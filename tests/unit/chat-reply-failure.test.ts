import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import {
  canRetry,
  classifyReplyError,
  MAX_REPLY_RETRIES,
  REPLY_TIMEOUT_MS,
} from '@/features/chat/reply-failure'

/**
 * How the browser reads a request for the guidance assistant's reply that
 * did not produce one. The patient's message is already saved by then, so
 * each answer decides only what they are told and whether Try again is
 * offered.
 */

function httpError(status: number, body: unknown) {
  return new FunctionsHttpError(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('classifyReplyError', () => {
  it('reads the function’s own code first', async () => {
    expect(await classifyReplyError(httpError(504, { error: 'x', code: 'timeout' }))).toBe('timeout')
    expect(await classifyReplyError(httpError(429, { error: 'x', code: 'busy' }))).toBe('busy')
    expect(await classifyReplyError(httpError(503, { error: 'x', code: 'unavailable' }))).toBe(
      'unavailable',
    )
    expect(await classifyReplyError(httpError(502, { error: 'x', code: 'invalid_reply' }))).toBe(
      'unavailable',
    )
    expect(await classifyReplyError(httpError(500, { error: 'x', code: 'save_failed' }))).toBe(
      'unavailable',
    )
    expect(
      await classifyReplyError(httpError(503, { error: 'x', code: 'not_configured' })),
    ).toBe('not_configured')
    expect(await classifyReplyError(httpError(403, { error: 'x', code: 'not_allowed' }))).toBe(
      'not_allowed',
    )
  })

  it('treats a reply that was saved after all as answered, not as a failure', async () => {
    expect(
      await classifyReplyError(
        httpError(400, { error: 'There is nothing to reply to', code: 'already_answered' }),
      ),
    ).toBe('already_answered')
    // A malformed request is a failure, even with the same wording.
    expect(
      await classifyReplyError(
        httpError(400, { error: 'There is nothing to reply to', code: 'bad_request' }),
      ),
    ).toBe('unavailable')
  })

  it('still understands the function as deployed before it sent codes', async () => {
    expect(
      await classifyReplyError(httpError(400, { error: 'There is nothing to reply to' })),
    ).toBe('already_answered')
    expect(
      await classifyReplyError(
        httpError(503, { error: 'The guidance assistant is not configured.' }),
      ),
    ).toBe('not_configured')
    expect(await classifyReplyError(httpError(429, { error: 'busy' }))).toBe('busy')
    expect(await classifyReplyError(httpError(503, { error: 'down' }))).toBe('unavailable')
    expect(await classifyReplyError(httpError(401, { error: 'no' }))).toBe('not_allowed')
    expect(await classifyReplyError(httpError(404, { error: 'no' }))).toBe('not_allowed')
    // A body that is not JSON at all.
    expect(await classifyReplyError(new FunctionsHttpError(new Response('oops', { status: 500 })))).toBe(
      'unavailable',
    )
  })

  it('tells the browser’s own time limit apart from a dropped connection', async () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    expect(await classifyReplyError(new FunctionsFetchError(aborted))).toBe('timeout')
    // The limit can also run out while the body is being read, unwrapped.
    expect(await classifyReplyError(aborted)).toBe('timeout')
    expect(await classifyReplyError(new FunctionsFetchError(new TypeError('Failed to fetch')))).toBe(
      'network',
    )
  })

  it('reports anything else as unavailable rather than guessing', async () => {
    expect(await classifyReplyError(new FunctionsRelayError(new Response(null, { status: 502 })))).toBe(
      'unavailable',
    )
    expect(await classifyReplyError(new Error('surprise'))).toBe('unavailable')
    expect(await classifyReplyError(undefined)).toBe('unavailable')
  })
})

describe('retrying', () => {
  it('offers to try again only where trying again can help', () => {
    expect(canRetry('timeout')).toBe(true)
    expect(canRetry('network')).toBe(true)
    expect(canRetry('busy')).toBe(true)
    expect(canRetry('unavailable')).toBe(true)
    expect(canRetry('not_configured')).toBe(false)
    expect(canRetry('not_allowed')).toBe(false)
  })

  it('is bounded', () => {
    expect(MAX_REPLY_RETRIES).toBeGreaterThan(0)
    expect(MAX_REPLY_RETRIES).toBeLessThanOrEqual(5)
  })

  it('gives the server time to answer before the browser gives up', () => {
    // The browser's limit runs from just before `functions.invoke` sends the
    // request until the response is read. chatbot-reply's limit is only its
    // wait for Gemini, so the browser's must also cover everything else - the
    // session token, the CORS preflight, the checks before the Gemini call,
    // the review request after a timeout, the network. That measured 4.7 s on
    // the slowest request in production (2026-10-20, a cold start).
    //
    // This compares the configured limits with that one measurement; it does
    // not measure the overhead, which a slower cold start or network can
    // raise. What it keeps is at least 5 s spare beyond what was measured.
    const MEASURED_OVERHEAD_MS = 4_700
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
      'utf8',
    )
    const declared = source.match(/const REQUEST_TIMEOUT_MS = ([\d_]+)/)?.[1]
    expect(declared).toBeDefined()
    const serverTimeout = Number(declared!.replaceAll('_', ''))
    const spare = REPLY_TIMEOUT_MS - serverTimeout - MEASURED_OVERHEAD_MS
    expect(spare).toBeGreaterThanOrEqual(5_000)
    expect(REPLY_TIMEOUT_MS).toBeGreaterThan(30_000)
    expect(REPLY_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
