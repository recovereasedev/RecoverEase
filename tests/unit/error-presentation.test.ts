import { describe, expect, it } from 'vitest'

import {
  describeError,
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
    // PostgrestError is an Error subclass, but an Edge Function failure or a
    // rejected promise can arrive as a plain object with a message.
    const described = describeError({
      message: 'An account already exists for that email address',
    })
    expect(described.detail).toBe(
      'An account already exists for that email address',
    )
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
