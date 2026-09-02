import Anthropic from 'npm:@anthropic-ai/sdk@0.70.0'
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.70.0/helpers/zod'
import { z } from 'npm:zod@3.25.76'

import {
  AuthError,
  requireCaller,
  serviceClient,
} from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'

/**
 * Guidance chatbot — modules 8.1, 8.2 and 8.3.
 *
 * Three things force this to run server-side rather than in the browser:
 *
 *  - the provider credential must not ship in a client bundle;
 *  - module 8.7 lets an administrator set the system prompt, and a prompt the
 *    client supplies is a prompt the client can replace;
 *  - module 8.2 requires critical-concern detection to raise a doctor alert,
 *    and a check the patient's browser performs is a check it can skip.
 *
 * If the provider is not configured this returns 503 and the UI says the
 * assistant is unavailable. It never falls back to a canned reply: an
 * invented answer about post-treatment symptoms is worse than no answer.
 *
 * Deploy:
 *   supabase functions deploy chatbot-reply
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 */

const MODEL = 'claude-opus-5'

/**
 * The fallback used when an administrator has not configured module 8.7.
 *
 * The safety framing is not left to configuration: an administrator editing
 * the prompt should be shaping tone and clinic-specific guidance, not able to
 * accidentally delete the instruction that stops the assistant diagnosing.
 * The non-negotiable part is appended below, after whatever they set.
 */
const DEFAULT_GUIDANCE = `You support patients recovering after treatment. Answer
questions about the recovery process in plain, calm language.`

const SAFETY_RULES = `
Non-negotiable rules:
- You are not a clinician. Never diagnose a condition, never interpret test
  results, and never tell a patient to start, stop, or change a medication or
  a dose. Direct those questions to their doctor.
- Keep answers short and concrete. Prefer two or three sentences.
- If the patient describes something that could be an emergency — chest pain,
  difficulty breathing, heavy bleeding, signs of infection such as fever with
  a hot swollen wound, fainting, thoughts of self-harm — tell them plainly to
  contact emergency services or their doctor now, and set has_critical_concern.
- Set has_critical_concern for anything a treating clinician would want to
  know about promptly, not merely for emergencies. It is better to raise a
  concern that turns out to be minor than to miss one.
- Never claim to have contacted anyone on the patient's behalf. Their doctor
  is notified separately by the system.`

const ReplySchema = z.object({
  reply: z
    .string()
    .describe('The message shown to the patient. Plain language, no markdown.'),
  has_critical_concern: z
    .boolean()
    .describe(
      'True when the patient described something their doctor should be told about promptly.',
    ),
  concern_summary: z
    .string()
    .describe(
      'One sentence for the doctor describing the concern, or an empty string when there is none.',
    ),
})

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
    const { chatSessionId } = (await request.json()) as {
      chatSessionId?: string
    }

    if (!chatSessionId) {
      throw new AuthError('chatSessionId is required', 400)
    }

    // The session must belong to the caller. Without this check any patient
    // could pass another patient's session id and read back their transcript
    // through the model's reply.
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

    // Module 8.7: administrator-configured guidance, with the safety rules
    // appended so they cannot be edited away.
    const { data: promptSetting } = await admin
      .from('system_setting')
      .select('system_setting_value')
      .eq('system_setting_key', 'chatbot.system_prompt')
      .maybeSingle()

    const systemPrompt = `${
      promptSetting?.system_setting_value?.trim() || DEFAULT_GUIDANCE
    }\n${SAFETY_RULES}`

    const anthropic = new Anthropic({ apiKey })

    const completion = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      // Effort is left at its default of `high`. This is a patient-safety
      // classification as much as a chat reply, and the cost of missing a
      // concern is far higher than the cost of the tokens.
      messages: history.map((message) => ({
        role:
          message.chat_message_role === 'patient'
            ? ('user' as const)
            : ('assistant' as const),
        content: message.chat_message_content as string,
      })),
      output_config: { format: zodOutputFormat(ReplySchema) },
    })

    const parsed = completion.parsed_output
    if (!parsed) {
      // Structured parsing failed. Saying nothing is the safe outcome; a
      // half-parsed reply is not something to show a recovering patient.
      throw new AuthError(
        'The assistant could not produce a usable reply',
        502,
      )
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

    // --- Module 8.2: raise the doctor alert ------------------------------
    if (parsed.has_critical_concern) {
      await admin
        .from('chat_session')
        .update({
          chat_session_has_critical_flag: true,
          chat_session_summary:
            parsed.concern_summary || 'A concern was raised in this conversation.',
        })
        .eq('chat_session_id', chatSessionId)

      // Module 8.3: the doctor receives the alert. Resolve their user account
      // from the patient's assigned doctor.
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
      {
        message: inserted,
        raisedCriticalConcern: parsed.has_critical_concern,
      },
      200,
      origin,
    )
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    // Typed SDK errors, checked most specific first.
    if (error instanceof Anthropic.RateLimitError) {
      return jsonResponse(
        { error: 'The assistant is busy. Try again in a moment.' },
        429,
        origin,
      )
    }
    if (error instanceof Anthropic.APIError) {
      console.error('anthropic error', error.status, error.message)
      return jsonResponse(
        { error: 'The guidance assistant is unavailable.' },
        503,
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
