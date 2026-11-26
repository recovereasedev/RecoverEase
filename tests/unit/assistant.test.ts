import { describe, expect, it } from 'vitest'

import type { AssistantReply } from '../../supabase/functions/_shared/assistant'
import {
  AssistantReplyError,
  ASSISTANT_RESPONSE_JSON_SCHEMA,
  buildResponsesRequest,
  buildSystemInstruction,
  DEFAULT_GUIDANCE,
  hasUnansweredPatientMessage,
  hostedPromptFrom,
  parseAssistantReply,
  raisesCriticalConcern,
  REPLY_FORMAT_NAME,
  responseOutputText,
  SAFETY_RULES,
  toConversationInput,
  withoutHostedPrompt,
} from '../../supabase/functions/_shared/assistant'

/**
 * The recovery assistant's provider-facing logic.
 *
 * None of this needs an OpenAI key, and that is the point: the request we
 * build, the data we are willing to send, and the output we are willing to
 * trust are all decided by pure functions, so they can be tested exactly
 * rather than inferred from a live call that costs money and cannot be made
 * to fail on demand.
 *
 * What these tests cannot cover is whether OpenAI accepts the request and
 * answers usefully. That is stated plainly in the report rather than implied
 * by a green suite.
 */

const validReply: AssistantReply = {
  message: 'Some stiffness in the morning is common at this stage.',
  safety_level: 'normal',
  should_contact_provider: false,
}

describe('the response contract', () => {
  it('accepts a well-formed structured reply', () => {
    const parsed = parseAssistantReply(JSON.stringify(validReply))

    expect(parsed.message).toContain('stiffness')
    expect(parsed.safety_level).toBe('normal')
    expect(parsed.should_contact_provider).toBe(false)
  })

  it('accepts a reply the model wrapped in a fenced code block', () => {
    // Structured output usually returns bare JSON, but models still sometimes
    // fence it. That one well-known wrapper is stripped; nothing else is.
    const parsed = parseAssistantReply(
      '```json\n' + JSON.stringify(validReply) + '\n```',
    )

    expect(parsed.safety_level).toBe('normal')
  })

  it.each([
    ['prose instead of JSON', 'I think you should take more ibuprofen.'],
    ['truncated JSON', '{"message":"partial", "safety_level":'],
    ['an empty string', ''],
    ['whitespace only', '   \n  '],
  ])('refuses %s', (_label, output) => {
    expect(() => parseAssistantReply(output)).toThrow(AssistantReplyError)
  })

  it('refuses a null response rather than inventing one', () => {
    expect(() => parseAssistantReply(null)).toThrow(AssistantReplyError)
  })

  it.each([
    ['a safety level outside the enum', { ...validReply, safety_level: 'fine' }],
    ['a missing safety level', { message: 'x', should_contact_provider: false }],
    ['a non-boolean escalation flag', { ...validReply, should_contact_provider: 'yes' }],
    ['an empty message', { ...validReply, message: '' }],
    ['a null message', { ...validReply, message: null }],
  ])('refuses %s', (_label, body) => {
    // Valid JSON that does not satisfy the schema is still refused. Nothing
    // partially-valid is repaired and passed on to a recovering patient.
    expect(() => parseAssistantReply(JSON.stringify(body))).toThrow(
      AssistantReplyError,
    )
  })

  it('escalates on urgent, and on an explicit request to contact the provider', () => {
    expect(raisesCriticalConcern({ ...validReply, safety_level: 'urgent' })).toBe(true)
    expect(
      raisesCriticalConcern({ ...validReply, should_contact_provider: true }),
    ).toBe(true)
    // Module 8.2 is deliberately wider than emergencies, but not unbounded.
    expect(raisesCriticalConcern({ ...validReply, safety_level: 'caution' })).toBe(
      false,
    )
    expect(raisesCriticalConcern(validReply)).toBe(false)
  })
})

describe('reading the provider response', () => {
  const message = (...parts: unknown[]) => ({ type: 'message', role: 'assistant', content: parts })

  it('reads the output_text parts of the assistant’s messages, joined', () => {
    const payload = {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'IGNORED' }] },
        message({ type: 'output_text', text: '{"ok":' }, { type: 'output_text', text: 'true}' }),
      ],
    }
    expect(responseOutputText(payload)).toEqual({ text: '{"ok":true}', refused: false })
  })

  it('notices a refusal instead of reading it as an empty answer', () => {
    const payload = { output: [message({ type: 'refusal', refusal: 'I cannot help with that.' })] }
    expect(responseOutputText(payload)).toEqual({ text: null, refused: true })
  })

  it.each([
    ['a null payload', null],
    ['a string payload', 'unexpected'],
    ['no output at all', { id: 'resp_1' }],
    ['output of the wrong type', { output: 'nope' }],
    ['a message with no text', { output: [message({})] }],
    ['only a reasoning item', { output: [{ type: 'reasoning', content: [{ type: 'output_text', text: 'x' }] }] }],
  ])('degrades to null on %s', (_label, payload) => {
    // A response shape that shifts under us must become a clean "unavailable",
    // never a crash and never a confident empty answer.
    expect(responseOutputText(payload).text).toBeNull()
  })
})

describe('data minimisation', () => {
  it('sends only the role and text of this conversation', () => {
    const history = [
      {
        chat_message_role: 'patient',
        chat_message_content: 'Is stiffness normal?',
        // Everything below is real column data that must not leave the system.
        chat_message_id: 'msg-1',
        chat_session_id: 'session-1',
        chat_message_created_at: '2026-09-03T00:00:00Z',
        pat_id: 'patient-uuid',
      },
      {
        chat_message_role: 'assistant',
        chat_message_content: 'Often, yes.',
        chat_message_id: 'msg-2',
      },
    ]

    const turns = toConversationInput(history as never)

    expect(turns).toEqual([
      { role: 'user', content: 'Is stiffness normal?' },
      { role: 'assistant', content: 'Often, yes.' },
    ])

    // Asserted on the serialised request too, so a future field cannot
    // smuggle an identifier through unnoticed.
    const serialised = JSON.stringify(
      buildResponsesRequest({ model: 'test-model', instructions: 'system', turns }),
    )
    for (const leaked of ['msg-1', 'session-1', 'patient-uuid', '2026-09-03']) {
      expect(serialised).not.toContain(leaked)
    }
  })

  it('drops empty and whitespace-only messages', () => {
    const turns = toConversationInput([
      { chat_message_role: 'patient', chat_message_content: '   ' },
      { chat_message_role: 'patient', chat_message_content: null },
      { chat_message_role: 'patient', chat_message_content: 'real question' },
    ])

    expect(turns).toEqual([{ role: 'user', content: 'real question' }])
  })

  it('treats anything that is not the patient as an assistant turn', () => {
    const turns = toConversationInput([
      { chat_message_role: 'assistant', chat_message_content: 'a' },
      { chat_message_role: null, chat_message_content: 'b' },
    ])

    expect(turns.every((turn) => turn.role === 'assistant')).toBe(true)
  })
})

describe('the request sent to OpenAI', () => {
  const turns = toConversationInput([
    { chat_message_role: 'patient', chat_message_content: 'first' },
    { chat_message_role: 'assistant', chat_message_content: 'reply' },
    { chat_message_role: 'patient', chat_message_content: 'follow-up' },
  ])

  it('sends the configured model, the instructions and the conversation in order', () => {
    const request = buildResponsesRequest({ model: 'gpt-test', instructions: 'system', turns })
    expect(request).toMatchObject({
      model: 'gpt-test',
      instructions: 'system',
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'follow-up' },
      ],
    })
  })

  it('asks for strict structured output matching the schema we validate against', () => {
    const request = buildResponsesRequest({ model: 'm', instructions: 's', turns })
    expect(request.text).toEqual({
      format: {
        type: 'json_schema',
        name: REPLY_FORMAT_NAME,
        schema: ASSISTANT_RESPONSE_JSON_SCHEMA,
        strict: true,
      },
    })
    // Strict mode requires every property required and no others allowed.
    expect(ASSISTANT_RESPONSE_JSON_SCHEMA.additionalProperties).toBe(false)
    expect([...ASSISTANT_RESPONSE_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(ASSISTANT_RESPONSE_JSON_SCHEMA.properties).sort(),
    )
  })

  it('replays history statelessly rather than letting the provider keep it', () => {
    const request = buildResponsesRequest({ model: 'm', instructions: 's', turns })
    expect(request.store).toBe(false)
    expect(request).not.toHaveProperty('previous_response_id')
    expect(request).not.toHaveProperty('conversation')
  })

  it('sends nothing that identifies the patient', () => {
    const request = buildResponsesRequest({ model: 'm', instructions: 's', turns })
    for (const field of ['user', 'safety_identifier', 'metadata', 'prompt_cache_key']) {
      expect(request).not.toHaveProperty(field)
    }
  })

  it('adds the hosted prompt only when one is configured, with no variables', () => {
    expect(buildResponsesRequest({ model: 'm', instructions: 's', turns })).not.toHaveProperty('prompt')
    const withPrompt = buildResponsesRequest({
      model: 'm',
      instructions: 's',
      turns,
      hostedPrompt: { id: 'pmpt_test', version: '1' },
    })
    expect(withPrompt).toMatchObject({ prompt: { id: 'pmpt_test', version: '1' } })
    expect((withPrompt as { prompt: Record<string, unknown> }).prompt).not.toHaveProperty('variables')
    // The instructions and the schema are sent either way: nothing depends on the prompt.
    expect(withPrompt).toMatchObject({ instructions: 's', text: { format: { strict: true } } })
    expect(withoutHostedPrompt(withPrompt)).toEqual(
      buildResponsesRequest({ model: 'm', instructions: 's', turns }),
    )
  })

  it('reads the hosted prompt from configuration, ignoring blanks', () => {
    expect(hostedPromptFrom(undefined, '1')).toBeNull()
    expect(hostedPromptFrom('   ', '1')).toBeNull()
    expect(hostedPromptFrom(' pmpt_a ', ' 1 ')).toEqual({ id: 'pmpt_a', version: '1' })
    expect(hostedPromptFrom('pmpt_a', '')).toEqual({ id: 'pmpt_a' })
  })

  it('only calls the provider when the patient spoke last', () => {
    const answerable = toConversationInput([
      { chat_message_role: 'patient', chat_message_content: 'a' },
      { chat_message_role: 'assistant', chat_message_content: 'b' },
      { chat_message_role: 'patient', chat_message_content: 'c' },
    ])
    const alreadyAnswered = toConversationInput([
      { chat_message_role: 'patient', chat_message_content: 'a' },
      { chat_message_role: 'assistant', chat_message_content: 'b' },
    ])

    expect(hasUnansweredPatientMessage(answerable)).toBe(true)
    expect(hasUnansweredPatientMessage(alreadyAnswered)).toBe(false)
    expect(hasUnansweredPatientMessage([])).toBe(false)
  })

  it('requires every field the validator requires', () => {
    // If these two drift apart, the model is free to omit a field that the
    // parser then rejects - a self-inflicted outage.
    expect([...ASSISTANT_RESPONSE_JSON_SCHEMA.required]).toEqual([
      'message',
      'safety_level',
      'should_contact_provider',
    ])
  })
})

describe('the system instruction', () => {
  it('puts the administrator prompt first and the safety rules after it', () => {
    const instruction = buildSystemInstruction('Speak warmly. Mention our clinic hours.')

    expect(instruction.indexOf('Speak warmly')).toBeLessThan(
      instruction.indexOf('You are not a doctor'),
    )
  })

  it('keeps the safety rules when no prompt is configured', () => {
    for (const value of [null, undefined, '', '   ']) {
      const instruction = buildSystemInstruction(value)
      expect(instruction).toContain(DEFAULT_GUIDANCE)
      expect(instruction).toContain(SAFETY_RULES.trim().split('\n')[0])
    }
  })

  it('states the prohibitions the product depends on', () => {
    // Module 8 is only safe if these survive an edit to the configurable half.
    const instruction = buildSystemInstruction('anything at all')

    for (const rule of [
      'not a doctor',
      'diagnose',
      'interpret test results',
      'medication, dose, or schedule',
      'invent a patient fact',
      'emergency services',
    ]) {
      expect(instruction).toContain(rule)
    }
  })
})
