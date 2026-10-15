import { afterEach, describe, expect, it, vi } from 'vitest'

import { newChatId } from '@/features/chat/api'

/**
 * The ids the browser chooses for a patient's message and a new
 * conversation. They make a repeated save refusable as a duplicate, so they
 * must be real, random UUIDs - also on older phones without
 * `crypto.randomUUID`.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newChatId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is a random UUID', () => {
    const first = newChatId()
    expect(first).toMatch(UUID_V4)
    expect(newChatId()).not.toBe(first)
  })

  it('still works where crypto.randomUUID is missing', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => real.getRandomValues(bytes),
    })
    const ids = new Set(Array.from({ length: 50 }, () => newChatId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})
