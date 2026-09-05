import { describe, expect, it } from 'vitest'

import {
  describeError,
  errorMessage,
  isPresentableMessage,
} from '@/components/feedback/state-view'

describe('describeError', () => {
  it('classifies a network failure', () => {
    expect(describeError(new Error('Failed to fetch')).kind).toBe('network')
  })

  it('classifies a row-level security refusal', () => {
    const error = new Error(
      'new row violates row-level security policy for table "doctor"',
    )
    expect(describeError(error).kind).toBe('permission')
  })

  it('keeps the raw message as detail for anything else', () => {
    const error = new Error('That licence number is already registered')
    const described = describeError(error)
    expect(described.kind).toBe('unknown')
    expect(described.detail).toBe('That licence number is already registered')
  })

  it('reads a Supabase-shaped error object, not only an Error', () => {
    // `PostgrestError` is an Error subclass, but postgrest-js only constructs
    // one when `.throwOnError()` is used. Reading `{ data, error }` and
    // throwing `error` — which is what this codebase does — throws the parsed
    // response body instead: a plain object. Edge Function failures arrive
    // the same way.
    const described = describeError({
      message: 'An account already exists for that email address',
    })
    expect(described.detail).toBe(
      'An account already exists for that email address',
    )
  })
})

describe('errorMessage', () => {
  it('reads an Error', () => {
    expect(errorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('reads the plain object PostgREST throws', () => {
    expect(
      errorMessage({
        code: '23505',
        details: 'Key (a)=(b) already exists.',
        hint: null,
        message: 'duplicate key value violates unique constraint "x"',
      }),
    ).toBe('duplicate key value violates unique constraint "x"')
  })

  it('reads a bare string', () => {
    expect(errorMessage('something failed')).toBe('something failed')
  })

  it('returns an empty string when there is no message to read', () => {
    // Empty rather than a sentence, so each caller picks its own fallback.
    expect(errorMessage(null)).toBe('')
    expect(errorMessage(undefined)).toBe('')
    expect(errorMessage({})).toBe('')
    expect(errorMessage({ code: '23505' })).toBe('')
    expect(errorMessage({ message: 42 })).toBe('')
    expect(errorMessage(42)).toBe('')
  })
})

describe('isPresentableMessage', () => {
  it('passes application copy through', () => {
    expect(
      isPresentableMessage('An account already exists for that email address'),
    ).toBe(true)
    expect(isPresentableMessage('Choose a time in the future')).toBe(true)
  })

  it('withholds database internals', () => {
    expect(
      isPresentableMessage('new row violates row-level security policy'),
    ).toBe(false)
    expect(
      isPresentableMessage('duplicate key value violates unique constraint'),
    ).toBe(false)
    expect(
      isPresentableMessage('null value in column "pat_id" of relation "x"'),
    ).toBe(false)
    expect(isPresentableMessage('Unknown error')).toBe(false)
    expect(isPresentableMessage('')).toBe(false)
  })
})
