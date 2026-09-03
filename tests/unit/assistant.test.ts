import { describe, expect, it } from 'vitest'

import type { AssistantReply } from '../../supabase/functions/_shared/assistant'
import {
  AssistantReplyError,
  ASSISTANT_RESPONSE_JSON_SCHEMA,
  buildInteractionRequest,
  buildSystemInstruction,
  DEFAULT_GUIDANCE,
  extractOutputText,
  GEMINI_ENDPOINT,
  GEMINI_MODEL,
  parseAssistantReply,
  raisesCriticalConcern,
  SAFETY_RULES,
  toInteractionInput,
} from '../../supabase/functions/_shared/assistant'

/**
 * The recovery assistant's provider-facing logic.
 *
 * None of this needs a Gemini key, and that is the point: the request we
 * build, the data we are willing to send, and the output we are willing to
 * trust are all decided by pure functions, so they can be tested exactly
 * rather than inferred from a live call that costs money and cannot be made
 * to fail on demand.
 *
 * What these tests cannot cover is whether Gemini accepts the request and
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
  it('reads the convenience field when present', () => {
    expect(extractOutputText({ output_text: '{"a":1}' })).toBe('{"a":1}')
    expect(extractOutputText({ interaction: { output_text: 'nested' } })).toBe(
      'nested',
    )
  })

  it('walks the step timeline when there is no convenience field', () => {
    const payload = {
      id: 'int_1',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'IGNORED' }] },
        { type: 'model_output', content: [{ type: 'text', text: '{"ok":' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'true}' }] },
      ],
    }

    // Only the model's own output, and consecutive text blocks joined.
    expect(extractOutputText(payload)).toBe('{"ok":true}')
  })

  it('never returns the input we sent as though it were an answer', () => {
    const payload = {
      steps: [{ type: 'user_input', content: [{ type: 'text', text: 'my question' }] }],
    }

    // Echoing the patient's own words back as the assistant's reply would be
    // a convincing, entirely fabricated answer.
    expect(extractOutputText(payload)).toBeNull()
  })

  it.each([
    ['a null payload', null],
    ['a string payload', 'unexpected'],
    ['no steps at all', { id: 'int_1' }],
    ['steps of the wrong type', { steps: 'nope' }],
    ['a step with no text', { steps: [{ type: 'model_output', content: [{}] }] }],
  ])('degrades to null on %s', (_label, payload) => {
    // A response shape that shifts under us must become a clean "unavailable",
    // never a crash and never a confident empty answer.
    expect(extractOutputText(payload)).toBeNull()
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

    const turns = toInteractionInput(history as never)

    expect(turns).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Is stiffness normal?' }] },
      { type: 'model_response', content: [{ type: 'text', text: 'Often, yes.' }] },
    ])

    // Asserted on the serialised payload too, so a future field added to the
    // turn shape cannot smuggle an identifier through unnoticed.
    const serialised = JSON.stringify(turns)
    for (const leaked of ['msg-1', 'session-1', 'patient-uuid', '2026-09-03']) {
      expect(serialised).not.toContain(leaked)
    }
  })

  it('drops empty and whitespace-only messages', () => {
    const turns = toInteractionInput([
      { chat_message_role: 'patient', chat_message_content: '   ' },
      { chat_message_role: 'patient', chat_message_content: null },
      { chat_message_role: 'patient', chat_message_content: 'real question' },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.content[0]?.text).toBe('real question')
  })

  it('treats anything that is not the patient as a model turn', () => {
    const turns = toInteractionInput([
      { chat_message_role: 'assistant', chat_message_content: 'a' },
      { chat_message_role: null, chat_message_content: 'b' },
    ])

    expect(turns.every((turn) => turn.type === 'model_response')).toBe(true)
  })
})

describe('the request sent to Gemini', () => {
  it('targets the Interactions endpoint with a current model', () => {
    expect(GEMINI_ENDPOINT).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    )
    expect(GEMINI_MODEL).toMatch(/^gemini-/)
  })

  it('asks for structured output matching the schema we validate against', () => {
    const body = buildInteractionRequest({
      systemInstruction: 'system',
      turns: toInteractionInput([
        { chat_message_role: 'patient', chat_message_content: 'hello' },
      ]),
    })

    expect(body).toMatchObject({
      model: GEMINI_MODEL,
      system_instruction: 'system',
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: ASSISTANT_RESPONSE_JSON_SCHEMA,
      },
    })
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
