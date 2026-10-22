import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FunctionsHttpError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { canRetry, classifyReplyError } from '@/features/chat/reply-failure'
import { guidanceChatIsOn } from '@/features/system-settings/components/guidance-chat-setting'

import {
  ASSISTANT_SWITCH_FUNCTION,
  readAssistantSwitch,
} from '../../supabase/functions/_shared/assistant-switch'

/**
 * The adviser's "AI Chatbot On/Off", where the server enforces it.
 *
 * The rule is the database's (migration 38, `tests/db/guidance-assistant-switch.test.ts`).
 * What is pinned here is that `chatbot-reply` asks it at the right moment -
 * after the conversation is proved the caller's, before any of it is read and
 * before the provider is called - that only an explicit yes goes ahead, and
 * that the browser shows a switched-off assistant as off, with nothing to
 * retry.
 */

const source = () =>
  readFile(join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'), 'utf8')

describe('reading the switch', () => {
  it('goes ahead only on an explicit yes', () => {
    expect(readAssistantSwitch({ data: true, error: null })).toBe('on')
  })

  it('is off on an explicit no', () => {
    expect(readAssistantSwitch({ data: false, error: null })).toBe('off')
  })

  it('treats a failed or unexpected answer as not known, never as on', () => {
    for (const result of [
      { data: true, error: { message: 'function does not exist' } },
      { data: null, error: null },
      { data: 'true', error: null },
      { data: 1, error: null },
      { data: [true], error: null },
    ]) {
      expect(readAssistantSwitch(result), JSON.stringify(result)).toBe('unknown')
    }
  })
})

describe('where chatbot-reply asks', () => {
  it('asks the database’s rule, for the patient’s assigned doctor', async () => {
    const code = await source()
    expect(ASSISTANT_SWITCH_FUNCTION).toBe('guidance_assistant_on_for_doctor')
    expect(code).toContain('admin.rpc(ASSISTANT_SWITCH_FUNCTION, { target_doc_id: patient.doc_id })')
  })

  it('asks after proving the conversation the caller’s, and before reading it or calling the provider', async () => {
    const code = await source()
    const ownership = code.indexOf("throw new AuthError('This conversation is not yours', 403)")
    const theSwitch = code.indexOf('admin.rpc(ASSISTANT_SWITCH_FUNCTION')
    const transcript = code.indexOf(".from('chat_message')")
    const prompt = code.indexOf('loadClinicPrompt(')
    const provider = code.indexOf('fetch(GEMINI_ENDPOINT')

    for (const position of [ownership, theSwitch, transcript, prompt, provider]) {
      expect(position).toBeGreaterThan(-1)
    }
    expect(ownership).toBeLessThan(theSwitch)
    expect(theSwitch).toBeLessThan(transcript)
    expect(theSwitch).toBeLessThan(prompt)
    expect(theSwitch).toBeLessThan(provider)
  })

  it('refuses a switched-off assistant as disabled, and an unanswerable one as unavailable', async () => {
    const code = await source()
    expect(code).toContain("throw new ReplyError('The guidance assistant is turned off.', 403, 'disabled')")
    expect(code).toContain("throw new ReplyError('The guidance assistant is unavailable.', 503, 'unavailable')")
  })
})

describe('the browser', () => {
  const refusal = (status: number, body: unknown) =>
    new FunctionsHttpError(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

  it('reads a switched-off assistant as off, and offers no retry', async () => {
    const failure = await classifyReplyError(
      refusal(403, { error: 'The guidance assistant is turned off.', code: 'disabled' }),
    )
    expect(failure).toBe('disabled')
    expect(canRetry('disabled')).toBe(false)
  })

  it('still reads a refusal of someone else’s conversation as not allowed', async () => {
    expect(await classifyReplyError(refusal(403, { error: 'This conversation is not yours', code: 'not_allowed' }))).toBe(
      'not_allowed',
    )
  })
})

describe('a clinic’s stored switch, as the settings page shows it', () => {
  it('reads as the database does: unset or true is on, anything else is off', () => {
    expect(guidanceChatIsOn(null)).toBe(true)
    expect(guidanceChatIsOn('true')).toBe(true)
    expect(guidanceChatIsOn(' TRUE ')).toBe(true)
    for (const value of ['false', '', 'yes', 'on', '1']) {
      expect(guidanceChatIsOn(value), value).toBe(false)
    }
  })
})
