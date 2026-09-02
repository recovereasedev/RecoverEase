import { AuthError, requireCaller, serviceClient } from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'

/**
 * Guidance chatbot - modules 8.1, 8.2 and 8.3.
 *
 * Three things force this server-side: the provider credential must not ship
 * in a client bundle; module 8.7 lets an administrator set the system prompt,
 * and a prompt the client supplies is one the client can replace; and module
 * 8.2 requires critical-concern detection to raise a doctor alert, which a
 * check in the patient's browser could simply skip.
 *
 * If the provider is not configured this returns 503 and the UI says the
 * assistant is unavailable. It never falls back to a canned reply: an
 * invented answer about post-treatment symptoms is worse than no answer.
 *
 * The Anthropic SDK is imported dynamically, inside the handler and after the
 * key check, so that a missing or unreachable provider package cannot stop
 * the function loading and turn a clean 503 into a hard crash.
 *
 * This file is kept behaviourally in step with what is deployed. An earlier revision
 * used `messages.parse()` with `zodOutputFormat` for schema-guaranteed output,
 * which is the better shape for a patient-safety classifier; it was rolled
 * back to a top-level-import-free version so the function could load, and it
 * is recoverable from git history once the provider secrets are set and the
 * model path can actually be exercised end to end.
 *
 * Deploy:
 *   supabase functions deploy chatbot-reply
 *   supabase secrets set ANTHROPIC_API_KEY=...
 *   supabase secrets set ALLOWED_ORIGINS="https://<your-app>.vercel.app"
 */

const MODEL = 'claude-opus-5'

const DEFAULT_GUIDANCE = `You support patients recovering after treatment.
Answer questions about the recovery process in plain, calm language.`

// Appended after the administrator's text, so editing module 8.7's prompt can
// shape tone and clinic-specific guidance but cannot delete the instruction
// that stops the assistant diagnosing.
const SAFETY_RULES = `
Non-negotiable rules:
- You are not a clinician. Never diagnose a condition, never interpret test
  results, and never tell a patient to start, stop, or change a medication or
  a dose. Direct those questions to their doctor.
- Keep answers short and concrete. Prefer two or three sentences.
- If the patient describes something that could be an emergency - chest pain,
  difficulty breathing, heavy bleeding, signs of infection such as fever with
  a hot swollen wound, fainting, thoughts of self-harm - tell them plainly to
  contact emergency services or their doctor now, and set has_critical_concern.
- Set has_critical_concern for anything a treating clinician would want to
  know about promptly, not merely for emergencies. It is better to raise a
  concern that turns out to be minor than to miss one.
- Never claim to have contacted anyone on the patient's behalf.

Reply with JSON only, matching exactly:
{"reply": string, "has_critical_concern": boolean, "concern_summary": string}`

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin)
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return jsonResponse(
      { error: 'The guidance assistant is not configured.' },
      503,
      origin,
    )
  }

  const admin = serviceClient()

  try {
    const caller = await requireCaller(request)
    const { chatSessionId } = (await request.json()) as { chatSessionId?: string }

    if (!chatSessionId) throw new AuthError('chatSessionId is required', 400)

    // The session must belong to the caller. Without this check any patient
    // could pass another patient's session id and read their transcript back
    // through the model's reply.
    const { data: session, error: sessionError } = await admin
      .from('chat_session')
      .select('chat_session_id, pat_id, patient!inner ( user_id, doc_id )')
      .eq('chat_session_id', chatSessionId)
      .maybeSingle()

    if (sessionError) throw new AuthError('Could not load the conversation', 500)
    if (!session) throw new AuthError('Conversation not found', 404)

    const patient = session.patient as unknown as { user_id: string; doc_id: string }

    if (patient.user_id !== caller.userId) {
      throw new AuthError('This conversation is not yours', 403)
    }

    const { data: history, error: historyError } = await admin
      .from('chat_message')
      .select('chat_message_role, chat_message_content')
      .eq('chat_session_id', chatSessionId)
      .order('chat_message_created_at', { ascending: true })
      // A recovery conversation does not need unbounded history, and an
      // unbounded window is an unbounded bill.
      .limit(40)

    if (historyError) throw new AuthError('Could not load the conversation', 500)
    if (!history || history.length === 0) {
      throw new AuthError('There is nothing to reply to', 400)
    }

    const { data: promptSetting } = await admin
      .from('system_setting')
      .select('system_setting_value')
      .eq('system_setting_key', 'chatbot.system_prompt')
      .maybeSingle()

    const systemPrompt = `${
      promptSetting?.system_setting_value?.trim() || DEFAULT_GUIDANCE
    }\n${SAFETY_RULES}`

    const { default: Anthropic } = await import('npm:@anthropic-ai/sdk')
    const anthropic = new Anthropic({ apiKey })

    // Effort is left at its default. This is a patient-safety classification
    // as much as a chat reply, and missing a concern costs more than tokens.
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: history.map((message) => ({
        role: message.chat_message_role === 'patient' ? ('user' as const) : ('assistant' as const),
        content: message.chat_message_content as string,
      })),
    })

    const text = completion.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('')

    let parsed: { reply: string; has_critical_concern: boolean; concern_summary: string }
    try {
      parsed = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ''))
    } catch {
      // Saying nothing is the safe outcome; a half-parsed reply is not
      // something to show a recovering patient.
      throw new AuthError('The assistant could not produce a usable reply', 502)
    }

    const { data: inserted, error: insertError } = await admin
      .from('chat_message')
      .insert({
        chat_session_id: chatSessionId,
        chat_message_role: 'assistant',
        chat_message_content: parsed.reply,
      })
      .select()
      .single()

    if (insertError) throw new AuthError(insertError.message, 500)

    // Module 8.2: raise the doctor alert.
    if (parsed.has_critical_concern) {
      await admin
        .from('chat_session')
        .update({
          chat_session_has_critical_flag: true,
          chat_session_summary:
            parsed.concern_summary || 'A concern was raised in this conversation.',
        })
        .eq('chat_session_id', chatSessionId)

      // Module 8.3: the doctor receives the alert.
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
            parsed.concern_summary ||
            'A patient raised a concern in the guidance chat that may need your attention.',
        })
      }
    }

    return jsonResponse(
      { message: inserted, raisedCriticalConcern: parsed.has_critical_concern },
      200,
      origin,
    )
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    console.error('chatbot-reply failed', error)
    return jsonResponse({ error: 'The guidance assistant is unavailable.' }, 503, origin)
  }
})
