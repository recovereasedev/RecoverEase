import {
  AssistantReplyError,
  buildInteractionRequest,
  buildSystemInstruction,
  chronologicalWindow,
  GEMINI_MODEL,
  hasUnansweredPatientMessage,
  HISTORY_LIMIT,
  toInteractionInput,
} from '../_shared/assistant.ts'
import {
  ASSISTANT_SWITCH_FUNCTION,
  readAssistantSwitch,
} from '../_shared/assistant-switch.ts'
import { AuthError, requireCaller, serviceClient } from '../_shared/auth.ts'
import { loadClinicPrompt, PROMPT_KEY, type PromptStore } from '../_shared/clinic-prompt.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import {
  CRITICAL_ALERT_MESSAGE,
  type CriticalEscalationStore,
  EscalationError,
  escalateCriticalConcern,
} from '../_shared/critical-escalation.ts'
import {
  ProviderError,
  ProviderReplyError,
  type ProviderTimings,
  requestGeminiReply,
} from '../_shared/gemini-call.ts'
import {
  ReplyIdConflictError,
  replyIdFor,
  saveReplyOnce,
} from '../_shared/reply-once.ts'
import {
  codeForStatus,
  DB_TIMEOUT_MS,
  providerDeadlineMs,
  type ReplyErrorCode,
  type ReplyLogEntry,
  replyLogLine,
  type ReplyPhase,
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
 * A reply that raises a critical concern is escalated - the conversation
 * flagged, the doctor alerted - BEFORE it is saved, and is saved only once
 * that has succeeded (_shared/critical-escalation.ts). A saved reply ends
 * every retry, so escalating afterwards could lose a concern for good.
 *
 * Time: one budget for the whole request (_shared/reply-outcome.ts). Every
 * database call has its own deadline, and Gemini is given what is left of
 * the budget, at most PROVIDER_TIMEOUT_MS, covering its headers and its body.
 *
 * Each clinic writes its own guidance (migration 31): the prompt is the
 * patient's clinic's, and the built-in guidance when that cannot be read.
 *
 * The assistant can be switched off for the platform or for a clinic
 * (migration 38): asked right after the conversation is proved the caller's,
 * and refused with `disabled` before any of it is read.
 *
 * Deploy:
 *   supabase functions deploy chatbot-reply
 *   supabase secrets set GEMINI_API_KEY=...
 */

/** A row of `chat_message`, as `select('*')` returns it. */
type ChatMessageRow = {
  chat_message_id: string
  chat_session_id: string
  chat_message_role: string | null
  chat_message_content: string
  chat_message_created_at: string
}

/** The columns of `chat_message` the history query reads. */
type HistoryRow = {
  chat_message_id: string
  chat_message_role: string | null
  chat_message_content: string | null
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

/** A fresh deadline for one database call. */
const dbDeadline = () => AbortSignal.timeout(DB_TIMEOUT_MS)

type Admin = ReturnType<typeof serviceClient>

/**
 * The database side of the prompt lookup (_shared/clinic-prompt.ts): the
 * patient's doctor's clinic, and that clinic's prompt. With the service key,
 * since a patient cannot read settings; every query names the clinic.
 */
function promptStore(admin: Admin): PromptStore {
  return {
    async clinicOfDoctor(docId) {
      const { data, error } = await admin
        .from('doctor')
        .select('clinic_id')
        .eq('doc_id', docId)
        .abortSignal(dbDeadline())
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
        .abortSignal(dbDeadline())
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
function reviewStore(admin: Admin, docId: string, chatSessionId: string): ReviewRequestStore {
  return {
    async assignedDoctorUserId() {
      const { data, error } = await admin
        .from('doctor')
        .select('user_id, doc_is_active')
        .eq('doc_id', docId)
        .abortSignal(dbDeadline())
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
        .abortSignal(dbDeadline())
      if (error) throw error
      return (data?.length ?? 0) > 0
    },
    async insertReviewRequest(doctorUserId) {
      const { error } = await admin
        .from('notification')
        .insert({
          user_id: doctorUserId,
          chat_session_id: chatSessionId,
          // The chat alert type, so it opens the conversation like one does
          // (module 8.5). The message says a reply is missing, not that a
          // concern was found, and the conversation is not flagged.
          notification_type: 'chat_critical',
          notification_message: NEEDS_REVIEW_MESSAGE,
        })
        .abortSignal(dbDeadline())
      if (error) throw error
    },
  }
}

/**
 * The database side of critical-concern escalation
 * (_shared/critical-escalation.ts). Every step throws on failure, so a
 * concern is either fully escalated or the reply is not saved.
 */
function criticalStore(admin: Admin, docId: string, chatSessionId: string): CriticalEscalationStore {
  return {
    async flagConversation(summary) {
      const { error } = await admin
        .from('chat_session')
        .update({ chat_session_has_critical_flag: true, chat_session_summary: summary })
        .eq('chat_session_id', chatSessionId)
        .abortSignal(dbDeadline())
      if (error) throw error
    },
    async doctorUserId() {
      const { data, error } = await admin
        .from('doctor')
        .select('user_id')
        .eq('doc_id', docId)
        .abortSignal(dbDeadline())
        .maybeSingle()
      if (error) throw error
      return (data?.user_id as string | null | undefined) ?? null
    },
    async hasConcernAlertSince(doctorUserId, since) {
      let query = admin
        .from('notification')
        .select('notification_id')
        .eq('user_id', doctorUserId)
        .eq('chat_session_id', chatSessionId)
        .eq('notification_type', 'chat_critical')
        .eq('notification_message', CRITICAL_ALERT_MESSAGE)
      if (since) query = query.gte('notification_created_at', since)
      const { data, error } = await query.limit(1).abortSignal(dbDeadline())
      if (error) throw error
      return (data?.length ?? 0) > 0
    },
    async insertConcernAlert(doctorUserId) {
      // No clinical detail: the doctor opens the conversation, and an
      // administrator must not learn anything from a notification row.
      const { error } = await admin
        .from('notification')
        .insert({
          user_id: doctorUserId,
          chat_session_id: chatSessionId,
          notification_type: 'chat_critical',
          notification_message: CRITICAL_ALERT_MESSAGE,
        })
        .abortSignal(dbDeadline())
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

  // What is known about this request for its one log line: timings, sizes
  // and statuses - never what was asked or answered.
  const phases: Partial<Record<ReplyPhase, number | null>> = {}
  const facts: Omit<ReplyLogEntry, 'requestId' | 'status' | 'code' | 'durationMs' | 'phases'> = {
    model: GEMINI_MODEL,
  }
  const timed = async <T>(phase: ReplyPhase, run: () => Promise<T>): Promise<T> => {
    const from = Date.now()
    try {
      return await run()
    } finally {
      phases[phase] = Date.now() - from
    }
  }
  const recordProvider = (timings: ProviderTimings) => {
    phases.gemini_headers = timings.headersMs
    phases.gemini_body = timings.bodyMs
    phases.validation = timings.validationMs
  }

  const respond = (body: Record<string, unknown>, status: number, code: ReplyErrorCode | null) => {
    console.log(
      replyLogLine({
        requestId,
        status,
        code,
        durationMs: Date.now() - startedAt,
        phases,
        ...facts,
      }),
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
    const caller = await timed('auth', () => requireCaller(request))
    const { chatSessionId } = (await request.json()) as { chatSessionId?: string }

    if (!chatSessionId) throw new AuthError('chatSessionId is required', 400)

    // 2. Is this conversation theirs. Without this check any patient could
    //    pass another patient's session id and read that transcript back
    //    through the model's reply.
    const { data: session, error: sessionError } = await timed('ownership', async () =>
      await admin
        .from('chat_session')
        .select('chat_session_id, pat_id, patient!inner ( user_id, doc_id )')
        .eq('chat_session_id', chatSessionId)
        .abortSignal(dbDeadline())
        .maybeSingle(),
    )

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
    //     conversation is read, and so before the provider is called. Only an
    //     explicit yes goes ahead; an answer that cannot be read - including
    //     one that ran out of time - is treated as no.
    const assistantSwitch = readAssistantSwitch(
      await timed('switch', async () =>
        await admin
          .rpc(ASSISTANT_SWITCH_FUNCTION, { target_doc_id: patient.doc_id })
          .abortSignal(dbDeadline()),
      ),
    )
    if (assistantSwitch === 'off') {
      throw new ReplyError('The guidance assistant is turned off.', 403, 'disabled')
    }
    if (assistantSwitch === 'unknown') {
      throw new ReplyError('The guidance assistant is unavailable.', 503, 'unavailable')
    }

    // 3. Only now is any content read, and only this conversation's: its
    //    newest HISTORY_LIMIT messages, newest first so the limit keeps the
    //    end of the conversation, then put back in order. The id breaks ties
    //    between identical timestamps, so the window is the same every time.
    const { data: historyRows, error: historyError } = await timed('history', async () =>
      await admin
        .from('chat_message')
        .select('chat_message_id, chat_message_role, chat_message_content, chat_message_created_at')
        .eq('chat_session_id', chatSessionId)
        .order('chat_message_created_at', { ascending: false })
        .order('chat_message_id', { ascending: false })
        .limit(HISTORY_LIMIT)
        .abortSignal(dbDeadline()),
    )

    if (historyError) throw new AuthError('Could not load the conversation', 500)
    const newestFirst = (historyRows ?? []) as HistoryRow[]
    if (newestFirst.length === 0) {
      throw new ReplyError('There is nothing to reply to', 400, 'bad_request')
    }
    facts.historyMessages = newestFirst.length
    const history = chronologicalWindow(newestFirst)

    // `toInteractionInput` is the data-minimisation boundary: it takes the
    // role and the text off each row and drops everything else, so the
    // provider receives this conversation and no other patient data at all.
    const turns = toInteractionInput(history)
    if (!hasUnansweredPatientMessage(turns)) {
      // The latest message already has its reply - typically a retry after a
      // reply that was saved but never reached the browser. Not a failure.
      throw new ReplyError('There is nothing to reply to', 400, 'already_answered')
    }

    // The message being answered: the newest, which is the patient's. Its id
    // decides the reply's id (_shared/reply-once.ts). It never reaches the
    // provider - `toInteractionInput` above passes on role and text only.
    const answering = newestFirst[0]!.chat_message_id

    // When the conversation was last answered - server time, since only this
    // function writes assistant messages. Escalation sends at most one alert
    // per unanswered stretch after it (_shared/critical-escalation.ts).
    const latestReplyAt =
      newestFirst.find((row) => row.chat_message_role === 'assistant')?.chat_message_created_at ??
      null

    // 4. From here the patient is owed an answer: their message is saved and
    //    nobody has replied. If the assistant cannot give one - for any
    //    reason, from an unconfigured key to a reply whose escalation or save
    //    fails - their doctor is asked to review the conversation, and the
    //    patient still gets the failure, never a stand-in reply.
    //
    //    Configuration is checked in here rather than at the top of the
    //    handler, so that an unconfigured deployment still answers "not
    //    yours" to a caller reaching for someone else's conversation.
    const { parsed, inserted, answeredElsewhere, critical } = await answerOrRequestReview(
      async () => {
        // The patient's clinic's guidance; the built-in one if it cannot be
        // read. The clinic comes from the conversation proved theirs above.
        const prompt = await timed('prompt', () => loadClinicPrompt(promptStore(admin), patient.doc_id))

        const body = buildInteractionRequest({
          systemInstruction: buildSystemInstruction(prompt),
          turns,
        })
        facts.requestBytes = new TextEncoder().encode(JSON.stringify(body)).length

        // One deadline for headers and body together: what is left of the
        // request's budget, at most PROVIDER_TIMEOUT_MS.
        let outcome: Awaited<ReturnType<typeof requestGeminiReply>>
        try {
          outcome = await requestGeminiReply({
            apiKey: Deno.env.get('GEMINI_API_KEY'),
            body,
            timeoutMs: providerDeadlineMs(Date.now() - startedAt),
          })
        } catch (error) {
          if (error instanceof ProviderError) {
            recordProvider(error.timings)
            facts.providerStatus = error.providerStatus
            throw new ReplyError(error.message, error.status, error.code)
          }
          if (error instanceof ProviderReplyError) {
            recordProvider(error.timings)
            facts.providerStatus = error.providerStatus
            facts.responseBytes = error.responseBytes
          }
          throw error
        }
        recordProvider(outcome.timings)
        facts.providerStatus = outcome.providerStatus
        facts.responseBytes = outcome.responseBytes
        const parsed = outcome.reply

        // Modules 8.2 and 8.3, before the reply is saved: a concern is flagged
        // and its alert written, or the reply is not saved at all.
        let escalation: Awaited<ReturnType<typeof escalateCriticalConcern>>
        try {
          escalation = await timed('escalation', () =>
            escalateCriticalConcern(
              criticalStore(admin, patient.doc_id, chatSessionId),
              parsed,
              latestReplyAt,
            ),
          )
        } catch (error) {
          if (!(error instanceof EscalationError)) throw error
          facts.escalationStep = error.step
          console.error(JSON.stringify({ event: 'critical_escalation_failed', step: error.step }))
          throw new ReplyError(
            'The guidance assistant is unavailable.',
            503,
            'escalation_failed',
          )
        }

        // One reply per question, enforced by the database rather than by a
        // check a concurrent request could slip past: the reply is saved
        // under an id derived from the message it answers, so a second reply
        // to the same message collides on the primary key and adopts the
        // first instead of being saved beside it (_shared/reply-once.ts).
        const replyId = await replyIdFor(
          answering,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        )
        let saved: Awaited<ReturnType<typeof saveReplyOnce<ChatMessageRow>>>
        try {
          saved = await timed('persistence', () =>
            saveReplyOnce<ChatMessageRow>(
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
                    .abortSignal(dbDeadline())
                    .single()

                  // 23505: the id is taken - the reply has already been saved.
                  if (insertError?.code === '23505') return { duplicate: true }
                  if (insertError) {
                    // The code only: the database's wording is not for a log
                    // line a patient's data could end up beside.
                    console.error(
                      JSON.stringify({ event: 'reply_save_failed', db_code: insertError.code ?? null }),
                    )
                    throw new ReplyError(
                      "The guidance assistant's reply could not be saved.",
                      500,
                      'save_failed',
                    )
                  }
                  return { row: data as ChatMessageRow }
                },
                async find() {
                  const { data, error } = await admin
                    .from('chat_message')
                    .select('*')
                    .eq('chat_message_id', replyId)
                    .abortSignal(dbDeadline())
                    .maybeSingle()
                  if (error) {
                    throw new ReplyError(
                      "The guidance assistant's reply could not be saved.",
                      500,
                      'save_failed',
                    )
                  }
                  return (data as ChatMessageRow | null) ?? null
                },
              },
              chatSessionId,
            ),
          )
        } catch (error) {
          if (!(error instanceof ReplyIdConflictError)) throw error
          console.error(JSON.stringify({ event: 'reply_id_conflict' }))
          throw new ReplyError(
            "The guidance assistant's reply could not be saved.",
            500,
            'save_failed',
          )
        }

        return {
          parsed,
          inserted: saved.row,
          answeredElsewhere: !saved.savedHere,
          critical: escalation !== 'not_critical',
        }
      },
      () => requestReview(reviewStore(admin, patient.doc_id, chatSessionId)),
      (error) =>
        console.error(
          JSON.stringify({
            event: 'review_request_failed',
            error: error instanceof Error ? error.name : 'unknown',
          }),
        ),
    )

    // Another request saved its reply first; that reply is the one shown,
    // and that request escalated it if it needed escalating.
    if (answeredElsewhere) {
      return respond({ message: inserted, raisedCriticalConcern: false }, 200, null)
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
      return respond(
        { error: 'The guidance assistant could not produce a usable reply.' },
        502,
        'invalid_reply',
      )
    }

    console.error(
      JSON.stringify({
        event: 'chatbot_reply_failed',
        error: error instanceof Error ? error.name : 'unknown',
      }),
    )
    return respond(
      { error: 'The guidance assistant is unavailable.' },
      503,
      'unavailable',
    )
  }
})
