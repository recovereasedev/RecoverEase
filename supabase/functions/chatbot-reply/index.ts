import {
  AssistantReplyError,
  buildInteractionRequest,
  buildSystemInstruction,
  extractOutputText,
  GEMINI_API_REVISION,
  GEMINI_ENDPOINT,
  hasUnansweredPatientMessage,
  parseAssistantReply,
  raisesCriticalConcern,
  toInteractionInput,
} from '../_shared/assistant.ts'
import { AuthError, requireCaller, serviceClient } from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'

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
 * already persisted by then and is never lost. It never falls back to a
 * canned or partial reply.
 *
 * Deploy:
 *   supabase functions deploy chatbot-reply
 *   supabase secrets set GEMINI_API_KEY=...
 */

/** Beyond this the patient is better served by an honest failure. */
const REQUEST_TIMEOUT_MS = 25_000

/** A recovery conversation does not need unbounded history, and an unbounded
 *  window is an unbounded bill. */
const HISTORY_LIMIT = 40

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')

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

    // 3. Only now is any content read, and only this conversation's.
    const { data: history, error: historyError } = await admin
      .from('chat_message')
      .select('chat_message_role, chat_message_content')
      .eq('chat_session_id', chatSessionId)
      .order('chat_message_created_at', { ascending: true })
      .limit(HISTORY_LIMIT)

    if (historyError) throw new AuthError('Could not load the conversation', 500)
    if (!history || history.length === 0) {
      throw new AuthError('There is nothing to reply to', 400)
    }

    // Configuration is checked here rather than at the top of the handler, so
    // that an unconfigured deployment still answers "not yours" to a caller
    // reaching for someone else's conversation. Authorisation should not
    // depend on whether a provider key happens to be set, and this ordering
    // also means the refusal paths stay exercisable before a key exists.
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      throw new AuthError('The guidance assistant is not configured.', 503)
    }

    const { data: promptSetting } = await admin
      .from('system_setting')
      .select('system_setting_value')
      .eq('system_setting_key', 'chatbot.system_prompt')
      .maybeSingle()

    // `toInteractionInput` is the data-minimisation boundary: it takes the
    // role and the text off each row and drops everything else, so the
    // provider receives this conversation and no other patient data at all.
    const turns = toInteractionInput(history)
    if (!hasUnansweredPatientMessage(turns)) {
      throw new AuthError('There is nothing to reply to', 400)
    }

    const body = buildInteractionRequest({
      systemInstruction: buildSystemInstruction(
        promptSetting?.system_setting_value,
      ),
      turns,
    })

    const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': GEMINI_API_REVISION,
        },
        body: JSON.stringify(body),
        signal: abort,
      })
    } catch (cause) {
      // Timeout, DNS, TLS, connection reset. Deliberately not surfaced to the
      // patient in detail; the log is where an operator looks.
      console.error('gemini request failed to complete', cause)
      throw new AuthError('The guidance assistant is unavailable.', 503)
    }

    if (!response.ok) {
      // Logged for operators, never forwarded: provider error bodies can carry
      // request detail and, on some providers, the key itself. Reading it here
      // is what made the `model_output` turn-type failure diagnosable at all,
      // since the platform log pipeline was unavailable.
      const detail = await response.text().catch(() => '')
      console.error(
        'gemini returned an error status',
        response.status,
        detail.slice(0, 500),
      )
      // A 5xx from the provider is transient far more often than not - the
      // documented response to "high demand" is to retry - so it is reported
      // as busy rather than broken. Telling a patient the assistant is
      // permanently unavailable when it will work in a minute is the wrong
      // failure message.
      const busy = response.status === 429 || response.status >= 500
      throw new AuthError(
        busy
          ? 'The guidance assistant is busy. Try again in a moment.'
          : 'The guidance assistant is unavailable.',
        busy ? 429 : 502,
      )
    }

    // Everything past here is validated before it is trusted.
    const payload = (await response.json()) as unknown
    const parsed = parseAssistantReply(extractOutputText(payload))

    const { data: inserted, error: insertError } = await admin
      .from('chat_message')
      .insert({
        chat_session_id: chatSessionId,
        chat_message_role: 'assistant',
        chat_message_content: parsed.message,
      })
      .select()
      .single()

    if (insertError) throw new AuthError(insertError.message, 500)

    const critical = raisesCriticalConcern(parsed)

    // Module 8.2: flag the conversation for the treating clinician.
    if (critical) {
      await admin
        .from('chat_session')
        .update({
          chat_session_has_critical_flag: true,
          chat_session_summary:
            parsed.safety_level === 'urgent'
              ? 'The assistant advised seeking care now.'
              : 'The assistant suggested contacting the care team.',
        })
        .eq('chat_session_id', chatSessionId)

      // Module 8.3: the doctor receives the alert. The notification carries no
      // clinical detail - the doctor can open the conversation, and an
      // administrator must not learn anything from a notification row.
      const { data: doctor } = await admin
        .from('doctor')
        .select('user_id')
        .eq('doc_id', patient.doc_id)
        .maybeSingle()

      if (doctor?.user_id) {
        await admin.from('notification').insert({
          user_id: doctor.user_id,
          chat_session_id: chatSessionId,
          notification_type: 'chat_critical',
          notification_message:
            'A patient raised a concern in the guidance chat that may need your attention.',
        })
      }
    }

    return jsonResponse(
      {
        message: inserted,
        raisedCriticalConcern: critical,
        safetyLevel: parsed.safety_level,
        shouldContactProvider: parsed.should_contact_provider,
      },
      200,
      origin,
    )
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    if (error instanceof AssistantReplyError) {
      // The model answered but not in a shape we can trust. Saying nothing is
      // the safe outcome; a half-parsed reply is not something to show a
      // recovering patient.
      console.error('gemini output rejected', error.message)
      return jsonResponse(
        { error: 'The guidance assistant could not produce a usable reply.' },
        502,
        origin,
      )
    }

    console.error('chatbot-reply failed', error)
    return jsonResponse(
      { error: 'The guidance assistant is unavailable.' },
      503,
      origin,
    )
  }
})
