import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveOutcomeUnknown } from '@/features/chat/api'
import {
  forgetPendingSend,
  loadPendingSends,
  type PendingSend,
  pendingSendFor,
  rememberPendingSend,
} from '@/features/chat/pending-send'

/**
 * Sends whose save is not confirmed keep their ids - through retries, an
 * edit and a refresh - so the database can refuse a second copy. Only ids
 * are remembered, never what the patient wrote.
 */

const PATIENT = 'p1p1p1p1-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0)

function entry(overrides: Partial<PendingSend> = {}): PendingSend {
  return {
    messageId: 'm1m1m1m1-1111-4111-8111-111111111111',
    sessionId: 's1s1s1s1-1111-4111-8111-111111111111',
    newSessionId: 'n1n1n1n1-1111-4111-8111-111111111111',
    startedAt: NOW,
    ...overrides,
  }
}

describe('remembering unconfirmed sends', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('keeps ids across a reload, and nothing the patient wrote', () => {
    rememberPendingSend(PATIENT, entry())
    expect(loadPendingSends(PATIENT, NOW)).toEqual([entry()])
    const stored = Object.values({ ...localStorage }).join(' ')
    expect(stored).not.toMatch(/content|text|message"/i)
  })

  it('lets a send go once it is settled', () => {
    rememberPendingSend(PATIENT, entry())
    forgetPendingSend(PATIENT, entry().messageId)
    expect(loadPendingSends(PATIENT, NOW)).toEqual([])
  })

  it('keeps one entry per submission', () => {
    rememberPendingSend(PATIENT, entry())
    rememberPendingSend(PATIENT, entry({ sessionId: 'other' }))
    expect(loadPendingSends(PATIENT, NOW)).toHaveLength(1)
  })

  it('lets old entries go after a day', () => {
    rememberPendingSend(PATIENT, entry({ startedAt: NOW - 25 * 60 * 60 * 1000 }))
    expect(loadPendingSends(PATIENT, NOW)).toEqual([])
  })

  it('keeps each patient’s apart', () => {
    rememberPendingSend(PATIENT, entry())
    expect(loadPendingSends('someone-else', NOW)).toEqual([])
  })

  it('works, without remembering, where storage is blocked or holds junk', () => {
    localStorage.setItem(`recoverease.chat.unconfirmed-sends.v1.${PATIENT}`, '{not json')
    expect(loadPendingSends(PATIENT, NOW)).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => rememberPendingSend(PATIENT, entry())).not.toThrow()
  })
})

describe('pendingSendFor', () => {
  it('finds the send that belongs to the conversation on screen', () => {
    const sent = entry()
    const starting = entry({ messageId: 'm2', sessionId: null, newSessionId: 'n2' })
    expect(pendingSendFor([sent, starting], sent.sessionId)).toBe(sent)
    // A new conversation: on its "new" screen, and once it is open.
    expect(pendingSendFor([sent, starting], null)).toBe(starting)
    expect(pendingSendFor([sent, starting], 'n2')).toBe(starting)
    expect(pendingSendFor([sent, starting], 'unrelated')).toBeUndefined()
  })
})

describe('saveOutcomeUnknown', () => {
  it('treats no answer, a timeout and a gateway error as unknown', () => {
    for (const status of [0, 408, 500, 502, 503, 504]) {
      expect(saveOutcomeUnknown(status)).toBe(true)
    }
  })

  it('treats the server refusing the save as known not to have happened', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(saveOutcomeUnknown(status)).toBe(false)
    }
  })
})
