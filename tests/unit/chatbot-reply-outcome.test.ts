import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  codeForStatus,
  DB_TIMEOUT_MS,
  isProviderTimeout,
  POST_PROVIDER_RESERVE_MS,
  providerDeadlineMs,
  PROVIDER_TIMEOUT_MS,
  replyLogLine,
  SERVER_BUDGET_MS,
} from '../../supabase/functions/_shared/reply-outcome'

/**
 * What `chatbot-reply` tells the browser and the log when a request ends:
 * a code the browser can act on, and one line an operator can read that
 * carries nothing a patient wrote.
 */

describe('codeForStatus', () => {
  it('names refusals known only by their status', () => {
    expect(codeForStatus(401)).toBe('not_allowed')
    expect(codeForStatus(403)).toBe('not_allowed')
    expect(codeForStatus(404)).toBe('not_allowed')
    expect(codeForStatus(400)).toBe('bad_request')
    expect(codeForStatus(429)).toBe('busy')
    expect(codeForStatus(504)).toBe('timeout')
    expect(codeForStatus(500)).toBe('unavailable')
    expect(codeForStatus(503)).toBe('unavailable')
  })
})

describe('isProviderTimeout', () => {
  it('recognises the request’s own time limit running out', async () => {
    const signal = AbortSignal.timeout(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(isProviderTimeout(signal.reason)).toBe(true)
    expect(isProviderTimeout(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('does not mistake a failed connection for a timeout', () => {
    expect(isProviderTimeout(new TypeError('error sending request'))).toBe(false)
    expect(isProviderTimeout(null)).toBe(false)
    expect(isProviderTimeout('TimeoutError')).toBe(false)
  })
})

describe('replyLogLine', () => {
  it('records how a request ended and how long it took', () => {
    expect(
      JSON.parse(
        replyLogLine({ requestId: 'r-1', status: 504, code: 'timeout', durationMs: 27_523.4 }),
      ),
    ).toEqual({
      event: 'chatbot_reply',
      request_id: 'r-1',
      status: 504,
      outcome: 'timeout',
      timed_out: true,
      duration_ms: 27_523,
      phases_ms: {},
      provider_status: null,
      model: null,
      request_bytes: null,
      response_bytes: null,
      history_messages: null,
      escalation_step: null,
    })
    expect(
      JSON.parse(replyLogLine({ requestId: 'r-2', status: 200, code: null, durationMs: 9_000 })),
    ).toMatchObject({ status: 200, outcome: 'replied' })
  })

  it('cannot carry anything else, even when handed it', () => {
    const line = replyLogLine({
      requestId: 'r-3',
      status: 200,
      code: null,
      durationMs: 1,
      // Not part of the type: what a careless caller might pass.
      ...({ message: 'Is swelling normal?', token: 'eyJ.secret' } as object),
    } as Parameters<typeof replyLogLine>[0])
    expect(line).not.toContain('swelling')
    expect(line).not.toContain('secret')
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(
      [
        'duration_ms',
        'escalation_step',
        'event',
        'history_messages',
        'model',
        'outcome',
        'phases_ms',
        'provider_status',
        'request_bytes',
        'request_id',
        'response_bytes',
        'status',
        'timed_out',
      ].sort(),
    )
  })

  it('times each phase separately and keeps only numbers, sizes and known names', () => {
    const line = replyLogLine({
      requestId: 'r-4',
      status: 200,
      code: null,
      durationMs: 9_412.6,
      phases: {
        auth: 120.4,
        gemini_headers: 8_000,
        gemini_body: 12,
        persistence: 30,
        escalation: null,
        // A phase name nobody declared, carrying text.
        ...({ 'Is swelling normal?': 5 } as object),
      },
      providerStatus: 200,
      model: 'gemini-3.8-flash',
      requestBytes: 7_210,
      responseBytes: 512,
      historyMessages: 3,
    })
    const parsed = JSON.parse(line)
    expect(parsed.phases_ms).toEqual({ auth: 120, gemini_headers: 8_000, gemini_body: 12, persistence: 30 })
    expect(parsed).toMatchObject({
      provider_status: 200,
      model: 'gemini-3.8-flash',
      request_bytes: 7_210,
      response_bytes: 512,
      history_messages: 3,
      timed_out: false,
    })
    expect(line).not.toContain('swelling')
  })

  it('drops a model or escalation step that is not one of its own values', () => {
    const parsed = JSON.parse(
      replyLogLine({
        requestId: 'r-5',
        status: 503,
        code: 'escalation_failed',
        durationMs: 1,
        model: 'Is swelling normal?',
        escalationStep: 'patient said: I feel faint',
      }),
    )
    expect(parsed.model).toBeNull()
    expect(parsed.escalation_step).toBeNull()
    expect(parsed.outcome).toBe('escalation_failed')
  })
})

describe('the time budget', () => {
  it('gives the provider what is left of the budget, within finite bounds', () => {
    expect(providerDeadlineMs(0)).toBe(PROVIDER_TIMEOUT_MS)
    expect(providerDeadlineMs(3_000)).toBe(PROVIDER_TIMEOUT_MS)
    // Checks before the provider ran slowly: it gets only what remains.
    expect(providerDeadlineMs(20_000)).toBe(SERVER_BUDGET_MS - POST_PROVIDER_RESERVE_MS - 20_000)
    // Never nothing, never unbounded.
    expect(providerDeadlineMs(10 * 60_000)).toBe(5_000)
    expect(providerDeadlineMs(-5)).toBe(PROVIDER_TIMEOUT_MS)
  })

  it('stays far inside the 150 s Supabase request limit, with time kept back for saving', () => {
    expect(SERVER_BUDGET_MS).toBeLessThan(150_000)
    expect(PROVIDER_TIMEOUT_MS + POST_PROVIDER_RESERVE_MS).toBeLessThanOrEqual(SERVER_BUDGET_MS)
    expect(DB_TIMEOUT_MS).toBeLessThanOrEqual(POST_PROVIDER_RESERVE_MS)
  })
})


describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const handler = source.slice(source.indexOf('Deno.serve('))

  it('logs every answer through one place, and never the content', () => {
    // After the method check, every response goes through `respond`, which
    // writes the log line.
    const afterMethodCheck = handler.slice(handler.indexOf('const admin = serviceClient()'))
    expect(afterMethodCheck).not.toContain('jsonResponse(')
    expect(source).toContain('console.log(\n      replyLogLine(')
    expect(source).not.toMatch(/console\.(log|error)\([^)]*(parsed\.message|chat_message_content|apiKey|authorization)/)
  })

  it('reports the provider being too slow as a timeout, not as unavailable', () => {
    // The provider module decides (tests/unit/gemini-call.test.ts); the
    // handler passes its code and status through unchanged.
    expect(source).toContain('throw new ReplyError(error.message, error.status, error.code)')
  })

  it('tells a retry that the message has been answered, rather than failing it', () => {
    expect(source).toMatch(
      /if \(!hasUnansweredPatientMessage\(turns\)\) \{[\s\S]*?'already_answered'/,
    )
  })

  it('saves at most one reply per question, enforced by the primary key', () => {
    const answerStep = source.slice(
      source.indexOf('await answerOrRequestReview('),
      source.indexOf('if (answeredElsewhere)'),
    )
    // The reply is saved under the id derived from the message it answers,
    // and a duplicate-key refusal adopts the reply already there.
    expect(source).toContain('const answering = newestFirst[0]!.chat_message_id')
    expect(answerStep).toMatch(
      /const replyId = await replyIdFor\(\s*answering,\s*Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/,
    )
    expect(answerStep).toContain('chat_message_id: replyId,')
    expect(answerStep).toContain("insertError?.code === '23505'")
    expect(answerStep).toContain('saveReplyOnce<ChatMessageRow>(')
    // No check-then-insert left for a concurrent request to slip past.
    expect(answerStep).not.toContain("latest?.chat_message_role === 'assistant'")
    // A request whose reply lost the race reports no concern of its own:
    // the reply shown is the other request's.
    expect(source).toMatch(
      /if \(answeredElsewhere\) \{\s*return respond\(\{ message: inserted, raisedCriticalConcern: false \}/,
    )
  })

  it('reads the answered message’s id without sending it to the provider', () => {
    expect(source).toContain(
      ".select('chat_message_id, chat_message_role, chat_message_content, chat_message_created_at')",
    )
    // The provider still receives role and text only.
    expect(source).toContain('const turns = toInteractionInput(history)')
  })
})
