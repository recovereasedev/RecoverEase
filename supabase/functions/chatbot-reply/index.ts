import {
  AssistantReplyError,
  buildInteractionRequest,
  buildSystemInstruction,
  chronologicalWindow,
  extractOutputText,
  GEMINI_ENDPOINT,
  hasUnansweredPatientMessage,
  HISTORY_LIMIT,
  parseAssistantReply,
  raisesCriticalConcern,
  toInteractionInput,
} from '../_shared/assistant.ts'
import {
  ASSISTANT_SWITCH_FUNCTION,
  readAssistantSwitch,
} from '../_shared/assistant-switch.ts'
import { AuthError, requireCaller, serviceClient } from '../_shared/auth.ts'
import { loadClinicPrompt, PROMPT_KEY, type PromptStore } from '../_shared/clinic-prompt.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { GEMINI_CLIENT_OPTIONS, geminiRequestInit } from '../_shared/gemini-transport.ts'
import {
  ReplyIdConflictError,
  replyIdFor,
  saveReplyOnce,
} from '../_shared/reply-once.ts'
import {
  codeForStatus,
  isProviderTimeout,
  providerErrorSummary,
  type ReplyErrorCode,
  replyLogLine,
} from '../_shared/reply-outcome.ts'
import {
  answerOrRequestReview,
  NEEDS_REVIEW_MESSAGE,
  requestReview,
  type ReviewRequestStore,
} from '../_shared/escalation.ts'

/**
 * Recovery guidance assistant - modules 8.1, 8.2 and 8.3.
 *
 * Provider: Google Gemini, Interactions API. The browser never calls Gemini.
 * Three separate reasons force that, and only the first is about the key:
 *
 *   - the provider credential must not ship in a client bundle;
 *   - module 8.7 lets an administrator set the system prompt, and a prompt
 *     the client supplies is one the client can replace - including the
 *     safety half of it;
 *   - module 8.2 requires critical-concern detection to raise a doctor
 *     alert, and a check performed in the patient's browser is a check the
 *     patient's browser can skip.
 *
 * Order of operations matters here. The caller is authenticated, then the
 * conversation is proved to be theirs, and only then is anything sent to the
 * provider. Building the request earlier would mean a failed authorisation
 * had already leaked the transcript.
 *
 * If Gemini is unconfigured, unreachable, rate limited, slow, or returns
 * something that does not satisfy the schema, this returns an error status
 * and the UI says the assistant is unavailable. The patient's own message is
 * already persisted by then and is never lost, and their doctor is asked to
 * review the conversation (see _shared/escalation.ts). It never falls back
 * to a canned or partial reply.
 *
 * Each clinic writes its own guidance (migration 31): the prompt is the
 * patient's clinic's, and the built-in guidance when that cannot be read.
 * Deploy only once migration 31 is applied - the lookup reads
 * `system_setting.clinic_id`; deployed earlier, every conversation gets the
 * built-in guidance. And before any second clinic exists: the version before
 * this one reads the prompt by key alone.
 *
 * The assistant can be switched off for the platform or for a clinic
 * (migration 38): asked right after the conversation is proved the caller's,
 * and refused with `disabled` before any of it is read. Deploy only once
 * migration 38 is applied - deployed earlier, the check cannot be answered
 * and every reply is refused as unavailable.
 *
 * Deploy:
 *   supabase functions deploy chatbot-reply
 *   supabase secrets set GEMINI_API_KEY=...
 */

/**
 * Beyond this the patient is better served by an honest failure.
 *
 * Only part of what the browser waits for. Its own limit (`REPLY_TIMEOUT_MS`,
 * 40 s) runs from just before the request until the response is read, so it
 * also covers the session token, the CORS preflight, the checks before this
 * call, the review request after a timeout and the network. Those measured
 * 4.7 s on the slowest request in production (a cold start), which leaves
 * about 5 s to spare at 30 s - not a guarantee: a slower cold start or
 * network can use it up.
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * The HTTP/1.1 client Gemini is reached with (_shared/gemini-transport.ts).
 *
 * One for as long as this worker lives, created on the first request that
 * calls the provider, so its connections are pooled and reused like the
 * default client's; it goes when the worker does. One per request would open
 * a new TLS connection every time and would have to be closed once the body
 * is read. Created inside the provider call's `try`, so a runtime that cannot
 * make one fails that request as unavailable rather than the whole function.
 */
let geminiClient: Deno.HttpClient | undefined
const providerClient = () => (geminiClient ??= Deno.createHttpClient(GEMINI_CLIENT_OPTIONS))

/** A row of `chat_message`, as `select('*')` returns it. */
type ChatMessageRow = {
  chat_message_id: string
  chat_session_id: string
  chat_message_role: string | null
  chat_message_content: string
  chat_message_created_at: string
}

/**
 * A refusal or failure, with the code the browser uses to tell the patient
 * what happened and whether trying again can help (`_shared/reply-outcome.ts`).
 */
class ReplyError extends AuthError {
  readonly code: ReplyErrorCode

  constructor(message: string, status: number, code: ReplyErrorCode) {
    super(message, status)
    this.code = code
  }
}

/**
 * The database side of the prompt lookup (_shared/clinic-prompt.ts): the
 * patient's doctor's clinic, and that clinic's prompt. With the service key,
 * since a patient cannot read settings; every query names the clinic.
 */
function promptStore(admin: ReturnType<typeof serviceClient>): PromptStore {
  return {
    async clinicOfDoctor(docId) {
      const { data, error } = await admin
        .from('doctor')
        .select('clinic_id')
        .eq('doc_id', docId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data?.clinic_id as string | null | undefined) ?? null
    },
    async clinicPrompt(clinicId) {
      const { data, error } = await admin
        .from('system_setting')
        .select('system_setting_value')
        .eq('clinic_id', clinicId)
        .eq('system_setting_key', PROMPT_KEY)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data?.system_setting_value as string | null | undefined) ?? null
    },
  }
}

/**
 * The database side of a review request (_shared/escalation.ts), for one
 * conversation and the patient's assigned doctor. Written with the service
 * key, like every other write here.
 */
function reviewStore(
  admin: ReturnType<typeof serviceClient>,
  docId: string,
  chatSessionId: string,
): ReviewRequestStore {
  return {
    async assignedDoctorUserId() {
      const { data, error } = await admin
        .from('doctor')
        .select('user_id, doc_is_active')
        .eq('doc_id', docId)
        .maybeSingle()
      if (error) throw error
      return data?.doc_is_active ? (data.user_id as string) : null
    },
    async hasUnreadReviewRequest(doctorUserId) {
      const { data, error } = await admin
        .from('notification')
        .select('notification_id')
        .eq('user_id', doctorUserId)
        .eq('chat_session_id', chatSessionId)
        .eq('notification_type', 'chat_critical')
        .eq('notification_message', NEEDS_REVIEW_MESSAGE)
        .eq('notification_is_read', false)
        .limit(1)
      if (error) throw error
      return (data?.length ?? 0) > 0
    },
    async insertReviewRequest(doctorUserId) {
      const { error } = await admin.from('notification').insert({
        user_id: doctorUserId,
        chat_session_id: chatSessionId,
        // The chat alert type, so it opens the conversation like one does
        // (module 8.5). The message says a reply is missing, not that a
        // concern was found, and the conversation is not flagged.
        notification_type: 'chat_critical',
        notification_message: NEEDS_REVIEW_MESSAGE,
      })
      if (error) throw error
    },
  }
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()

  // Every answer from here is logged once: how it ended and how long it
  // took, never what was asked or answered.
  const respond = (
    body: Record<string, unknown>,
    status: number,
    code: ReplyErrorCode | null,
  ) => {
    console.log(
      replyLogLine({ requestId, status, code, durationMs: Date.now() - startedAt }),
    )
    return jsonResponse(code ? { ...body, code } : body, status, origin)
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin)
  }

  const admin = serviceClient()

  try {
    // 1. Who is calling. Verified against Supabase Auth, never taken from the
    //    request body.
    const caller = await requireCaller(request)
    const { chatSessionId } = (await request.json()) as { chatSessionId?: string }

    if (!chatSessionId) throw new AuthError('chatSessionId is required', 400)

    // 2. Is this conversation theirs. Without this check any patient could
    //    pass another patient's session id and read that transcript back
    //    through the model's reply.
    const { data: session, error: sessionError } = await admin
      .from('chat_session')
      .select('chat_session_id, pat_id, patient!inner ( user_id, doc_id )')
      .eq('chat_session_id', chatSessionId)
      .maybeSingle()

    if (sessionError) throw new AuthError('Could not load the conversation', 500)
    if (!session) throw new AuthError('Conversation not found', 404)

    const patient = session.patient as unknown as {
      user_id: string
      doc_id: string
    }

    if (patient.user_id !== caller.userId) {
      throw new AuthError('This conversation is not yours', 403)
    }

    // 2b. Is the assistant switched on - for the platform, and for this
    //     patient's clinic (migration 38). Asked before anything of the
    //     conversation is read, and so before the provider is called: a
    //     switched-off assistant never sees the transcript. Only an explicit
    //     yes goes ahead; an answer that cannot be read is treated as no.
    //     The patient's message stays saved and their care team still sees
    //     it; no review is requested, since the clinic or the platform chose
    //     to have no assistant rather than the assistant failing.
    const assistantSwitch = readAssistantSwitch(
      await admin.rpc(ASSISTANT_SWITCH_FUNCTION, { target_doc_id: patient.doc_id }),
    )
    if (assistantSwitch === 'off') {
      throw new ReplyError('The guidance assistant is turned off.', 403, 'disabled')
    }
    if (assistantSwitch === 'unknown') {
      throw new ReplyError('The guidance assistant is unavailable.', 503, 'unavailable')
    }

    // 3. Only now is any content read, and only this conversation's: its
    //    newest HISTORY_LIMIT messages. They are fetched newest first so the
    //    limit keeps the end of the conversation - fetched oldest first, a
    //    long conversation was cut off at its fortieth message and the
    //    patient's latest question never reached the model - and are put back
    //    in order before anything is built from them. The id breaks ties
    //    between identical timestamps, so the window is the same every time.
    const { data: newestFirst, error: historyError } = await admin
      .from('chat_message')
      .select('chat_message_id, chat_message_role, chat_message_content')
      .eq('chat_session_id', chatSessionId)
      .order('chat_message_created_at', { ascending: false })
      .order('chat_message_id', { ascending: false })
      .limit(HISTORY_LIMIT)

    if (historyError) throw new AuthError('Could not load the conversation', 500)
    if (!newestFirst || newestFirst.length === 0) {
      throw new ReplyError('There is nothing to reply to', 400, 'bad_request')
    }
    const history = chronologicalWindow(newestFirst)

    // `toInteractionInput` is the data-minimisation boundary: it takes the
    // role and the text off each row and drops everything else, so the
    // provider receives this conversation and no other patient data at all.
    const turns = toInteractionInput(history)
    if (!hasUnansweredPatientMessage(turns)) {
      // The latest message already has its reply - typically a retry after a
      // reply that was saved but never reached the browser. Not a failure:
      // the browser shows the conversation as it is.
      throw new ReplyError('There is nothing to reply to', 400, 'already_answered')
    }

    // The message being answered: the newest, which is the patient's. Its id
    // decides the reply's id (_shared/reply-once.ts). It never reaches the
    // provider - `toInteractionInput` above passes on role and text only.
    const answering = newestFirst[0]!.chat_message_id as string

    // 4. From here the patient is owed an answer: their message is saved and
    //    nobody has replied. If the assistant cannot give one - for any
    //    reason, from an unconfigured key to a reply that cannot be saved -
    //    their doctor is asked to review the conversation, and the patient
    //    still gets the failure, never a stand-in reply.
    //
    //    Configuration is checked in here rather than at the top of the
    //    handler, so that an unconfigured deployment still answers "not
    //    yours" to a caller reaching for someone else's conversation.
    //    Authorisation should not depend on whether a provider key happens to
    //    be set, and this ordering also means the refusal paths stay
    //    exercisable before a key exists.
    const { parsed, inserted, answeredElsewhere } = await answerOrRequestReview(
      async () => {
        const apiKey = Deno.env.get('GEMINI_API_KEY')
        if (!apiKey) {
          throw new ReplyError(
            'The guidance assistant is not configured.',
            503,
            'not_configured',
          )
        }

        // The patient's clinic's guidance; the built-in one if it cannot be
        // read. The clinic comes from the conversation proved theirs above.
        const prompt = await loadClinicPrompt(promptStore(admin), patient.doc_id)

        const body = buildInteractionRequest({
          systemInstruction: buildSystemInstruction(prompt),
          turns,
        })

        const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS)

        let response: Response
        try {
          response = await fetch(GEMINI_ENDPOINT, geminiRequestInit({
            apiKey,
            body,
            signal: abort,
            client: providerClient(),
          }))
        } catch (cause) {
          // Timeout, DNS, TLS, connection reset. Deliberately not surfaced to
          // the patient in detail; the log is where an operator looks.
          console.error('gemini request failed to complete', cause)
          // Our own time limit running out is reported as such, so the
          // patient hears "took too long" rather than "unavailable".
          throw isProviderTimeout(cause)
            ? new ReplyError('The guidance assistant took too long to respond.', 504, 'timeout')
            : new ReplyError('The guidance assistant is unavailable.', 503, 'unavailable')
        }

        if (!response.ok) {
          // Logged for operators, never forwarded - and only its
          // machine-readable parts: provider error bodies can carry request
          // detail and, on some providers, the key itself. The field paths it
          // keeps are what made the `model_output` turn-type failure
          // diagnosable at all, since the platform log pipeline was
          // unavailable (_shared/reply-outcome.ts).
          const detail = await response.text().catch(() => '')
          console.error(providerErrorSummary(response.status, detail))
          // A 5xx from the provider is transient far more often than not - the
          // documented response to "high demand" is to retry - so it is
          // reported as busy rather than broken. Telling a patient the
          // assistant is permanently unavailable when it will work in a
          // minute is the wrong failure message.
          const busy = response.status === 429 || response.status >= 500
          throw new ReplyError(
            busy
              ? 'The guidance assistant is busy. Try again in a moment.'
              : 'The guidance assistant is unavailable.',
            busy ? 429 : 502,
            busy ? 'busy' : 'unavailable',
          )
        }

        // Everything past here is validated before it is trusted. A body that
        // is not even JSON is the same failure as one that fails the schema.
        let payload: unknown
        try {
          payload = await response.json()
        } catch (cause) {
          // The time limit covers the body as well as the headers: a provider
          // that answers 200 and then stalls is too slow, not malformed, and
          // the patient hears "took too long" either way.
          if (isProviderTimeout(cause)) {
            console.error('gemini response body did not arrive in time')
            throw new ReplyError('The guidance assistant took too long to respond.', 504, 'timeout')
          }
          throw new AssistantReplyError('The assistant returned malformed output')
        }
        const parsed = parseAssistantReply(extractOutputText(payload))

        // One reply per question, enforced by the database rather than by a
        // check a concurrent request could slip past: the reply is saved
        // under an id derived from the message it answers, so a second reply
        // to the same message - a retry overlapping a slow request, the
        // conversation open on two devices - collides on the primary key and
        // adopts the first instead of being saved beside it. Keyed by the
        // service key, which never leaves the server, so a patient cannot
        // work the id out and take it first (_shared/reply-once.ts).
        const replyId = await replyIdFor(
          answering,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        )
        let saved: Awaited<ReturnType<typeof saveReplyOnce<ChatMessageRow>>>
        try {
          saved = await saveReplyOnce<ChatMessageRow>(
            {
              async insert() {
                const { data, error: insertError } = await admin
                  .from('chat_message')
                  .insert({
                    chat_message_id: replyId,
                    chat_session_id: chatSessionId,
                    chat_message_role: 'assistant',
                    chat_message_content: parsed.message,
                  })
                  .select()
                  .single()

                // 23505: the id is taken - the reply has already been saved.
                if (insertError?.code === '23505') return { duplicate: true }
                if (insertError) {
                  // Logged for operators; the database's own wording is not
                  // something to show a patient.
                  console.error('assistant reply could not be saved', insertError.message)
                  throw new ReplyError(
                    "The guidance assistant's reply could not be saved.",
                    500,
                    'save_failed',
                  )
                }
                return { row: data as ChatMessageRow }
              },
              async find() {
                const { data } = await admin
                  .from('chat_message')
                  .select('*')
                  .eq('chat_message_id', replyId)
                  .maybeSingle()
                return (data as ChatMessageRow | null) ?? null
              },
            },
            chatSessionId,
          )
        } catch (error) {
          if (!(error instanceof ReplyIdConflictError)) throw error
          console.error('assistant reply id was taken by another message')
          throw new ReplyError(
            "The guidance assistant's reply could not be saved.",
            500,
            'save_failed',
          )
        }

        const inserted = saved.row
        return { parsed, inserted, answeredElsewhere: !saved.savedHere }
      },
      () => requestReview(reviewStore(admin, patient.doc_id, chatSessionId)),
      (error) => console.error('review request could not be written', error),
    )

    // The other request saved its reply and dealt with any concern in it.
    if (answeredElsewhere) {
      return respond({ message: inserted, raisedCriticalConcern: false }, 200, null)
    }

    const critical = raisesCriticalConcern(parsed)

    // Module 8.2: flag the conversation for the treating clinician.
    if (critical) {
      const { error: flagError } = await admin
        .from('chat_session')
        .update({
          chat_session_has_critical_flag: true,
          chat_session_summary:
            parsed.safety_level === 'urgent'
              ? 'The assistant advised seeking care now.'
              : 'The assistant suggested contacting the care team.',
        })
        .eq('chat_session_id', chatSessionId)

      if (flagError) {
        console.error('critical flag could not be set', flagError.message)
      }

      // Module 8.3: the doctor receives the alert. The notification carries no
      // clinical detail - the doctor can open the conversation, and an
      // administrator must not learn anything from a notification row.
      const { data: doctor } = await admin
        .from('doctor')
        .select('user_id')
        .eq('doc_id', patient.doc_id)
        .maybeSingle()

      if (doctor?.user_id) {
        const { error: alertError } = await admin.from('notification').insert({
          user_id: doctor.user_id,
          chat_session_id: chatSessionId,
          notification_type: 'chat_critical',
          notification_message:
            'A patient raised a concern in the guidance chat that may need your attention.',
        })

        if (alertError) {
          console.error('critical alert could not be written', alertError.message)
        }
      }
    }

    return respond(
      {
        message: inserted,
        raisedCriticalConcern: critical,
        safetyLevel: parsed.safety_level,
        shouldContactProvider: parsed.should_contact_provider,
      },
      200,
      null,
    )
  } catch (error) {
    if (error instanceof AuthError) {
      return respond(
        { error: error.message },
        error.status,
        error instanceof ReplyError ? error.code : codeForStatus(error.status),
      )
    }

    if (error instanceof AssistantReplyError) {
      // The model answered but not in a shape we can trust. Saying nothing is
      // the safe outcome; a half-parsed reply is not something to show a
      // recovering patient.
      console.error('gemini output rejected', error.message)
      return respond(
        { error: 'The guidance assistant could not produce a usable reply.' },
        502,
        'invalid_reply',
      )
    }

    console.error('chatbot-reply failed', error)
    return respond(
      { error: 'The guidance assistant is unavailable.' },
      503,
      'unavailable',
    )
  }
})
