import { describe, expect, it } from 'vitest'

import { createQueryClient } from '@/app/providers'

/**
 * QA-01 — authorization failures must not be retried.
 *
 * The guard read `error instanceof Error ? error.message : ''`. What the data
 * layer throws is the PostgREST response body: a plain object, never an
 * Error. So the message was always empty, none of the checks matched, and
 * every denial was retried three times — the exact thing the guard exists to
 * prevent. This is the third place that mistake has been made, which is why
 * these assert the shape production actually throws.
 */

/** The body PostgREST returns, and the shape `throw error` propagates. */
function postgrestError(message: string, code: string): unknown {
  return { code, details: null, hint: null, message }
}

function retryPolicy() {
  const options = createQueryClient().getDefaultOptions().queries
  const retry = options?.retry
  if (typeof retry !== 'function') throw new Error('retry policy is not a function')
  return (failureCount: number, error: unknown) =>
    (retry as (n: number, e: unknown) => boolean)(failureCount, error)
}

describe('the query retry policy', () => {
  const shouldRetry = retryPolicy()

  it('does not retry an RLS denial thrown as a plain object', () => {
    // The regression. This returned true before the fix.
    expect(
      shouldRetry(
        0,
        postgrestError(
          'new row violates row-level security policy for table "appointment"',
          '42501',
        ),
      ),
    ).toBe(false)
  })

  it('does not retry a permission denial thrown as a plain object', () => {
    expect(
      shouldRetry(0, postgrestError('permission denied for table patient', '42501')),
    ).toBe(false)
  })

  it('does not retry an expired or invalid JWT', () => {
    expect(shouldRetry(0, postgrestError('JWT expired', 'PGRST301'))).toBe(false)
  })

  it('still recognises the same failures when they arrive as an Error', () => {
    // `.throwOnError()`, a wrapped rethrow, or Supabase Auth all produce the
    // Error shape. Both must be understood.
    expect(
      shouldRetry(0, new Error('new row violates row-level security policy')),
    ).toBe(false)
  })

  it('keeps retrying ordinary transient failures', () => {
    // The fix must not turn every error into a non-retry. A dropped
    // connection is exactly what retrying is for.
    const network = postgrestError('Failed to fetch', '')
    expect(shouldRetry(0, network)).toBe(true)
    expect(shouldRetry(1, network)).toBe(true)
    // ...but not forever.
    expect(shouldRetry(2, network)).toBe(false)
  })

  it('retries an error carrying no message at all', () => {
    // Nothing identifies it as an authorization problem, so it gets the
    // normal budget rather than being written off.
    expect(shouldRetry(0, {})).toBe(true)
    expect(shouldRetry(0, null)).toBe(true)
  })
})
