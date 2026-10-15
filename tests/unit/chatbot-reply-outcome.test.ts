import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  codeForStatus,
  isProviderTimeout,
  replyLogLine,
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
      duration_ms: 27_523,
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
      ['duration_ms', 'event', 'outcome', 'request_id', 'status'].sort(),
    )
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
    expect(source).toContain('isProviderTimeout(cause)')
    expect(source).toContain("504, 'timeout'")
  })

  it('tells a retry that the message has been answered, rather than failing it', () => {
    expect(source).toMatch(
      /if \(!hasUnansweredPatientMessage\(turns\)\) \{[\s\S]*?'already_answered'/,
    )
  })

  it('saves at most one reply per question, even when a retry overlaps a slow request', () => {
    const answerStep = source.slice(
      source.indexOf('await answerOrRequestReview('),
      source.indexOf('const critical = raisesCriticalConcern(parsed)'),
    )
    const guard = answerStep.indexOf("latest?.chat_message_role === 'assistant'")
    const insert = answerStep.indexOf('.insert({')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(insert)
    // The other request dealt with its own reply's concerns.
    expect(source.indexOf('if (answeredElsewhere)')).toBeLessThan(
      source.indexOf('const critical = raisesCriticalConcern(parsed)'),
    )
  })
})
