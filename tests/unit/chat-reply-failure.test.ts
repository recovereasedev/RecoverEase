
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
import {
  POST_PROVIDER_RESERVE_MS,
  PROVIDER_TIMEOUT_MS,
  SERVER_BUDGET_MS,
} from '../../supabase/functions/_shared/reply-outcome'

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

  it('reads a failed critical-concern escalation as unavailable, and offers to try again', async () => {
    // The reply was not saved, so asking again produces and escalates it
    // afresh (supabase/functions/_shared/critical-escalation.ts). Nothing
    // about it suggests a concern to the patient, and it is not "answered".
    const failure = await classifyReplyError(
      httpError(503, { error: 'The guidance assistant is unavailable.', code: 'escalation_failed' }),
    )
    expect(failure).toBe('unavailable')
    expect(canRetry(failure as 'unavailable')).toBe(true)
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
    // request until the response is read. It must cover the server's whole
    // budget (the provider gets what is left of SERVER_BUDGET_MS less the
    // post-provider reserve), plus what happens outside the function: the
    // session token, the CORS preflight and the network. The preflight alone
    // measured 3.7 s on a production cold start (2026-11-08); the whole
    // overhead outside the provider call measured 4.7 s (2026-10-20).
    const MEASURED_OUTSIDE_MS = 4_700
    const serverAnswersWithin = SERVER_BUDGET_MS - POST_PROVIDER_RESERVE_MS + 2_000
    expect(REPLY_TIMEOUT_MS - serverAnswersWithin - MEASURED_OUTSIDE_MS).toBeGreaterThanOrEqual(5_000)
    // Never beyond Supabase's 150 s request idle timeout, and finite.
    expect(SERVER_BUDGET_MS).toBeLessThan(150_000)
    expect(REPLY_TIMEOUT_MS).toBeLessThanOrEqual(90_000)
    expect(PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(SERVER_BUDGET_MS - POST_PROVIDER_RESERVE_MS)
  })
})
