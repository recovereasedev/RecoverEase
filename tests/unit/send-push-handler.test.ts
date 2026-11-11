import { describe, expect, it, vi } from 'vitest'

import type { PushResult } from '../../supabase/functions/_shared/web-push'
import {
  dispatchPushes,
  missingConfig,
  secretMatches,
  type ClaimedDelivery,
  type PushStore,
} from '../../supabase/functions/send-push/handler'
import { buildPushPayload, PUSH_BODY, PUSH_TITLE } from '../../supabase/functions/send-push/payload'

/**
 * send-push's rules with the database and the push service replaced: what
 * it sends, that every outcome is recorded, and when it stops.
 */

const delivery = (n: number, kind = 'medication'): ClaimedDelivery => ({
  delivery_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  notification_id: `11111111-1111-1111-1111-${String(n).padStart(12, '0')}`,
  push_kind: kind,
  attempt_count: 1,
  push_endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
  push_p256dh: 'p',
  push_auth: 'a',
})

function queue(batches: ClaimedDelivery[][]) {
  const completed: [string, PushResult][] = []
  const store: PushStore = {
    claim: vi.fn(async () => batches.shift() ?? []),
    complete: vi.fn(async (id, result) => {
      completed.push([id, result])
    }),
  }
  return { store, completed }
}

describe('the lock-screen message', () => {
  it('is the same generic words for every kind, with the page a tap opens', () => {
    expect(buildPushPayload('medication', 'n1')).toEqual({
      title: 'RecoverEase',
      body: 'You have a reminder in RecoverEase.',
      url: '/patient/medications',
      tag: 'recoverease-n1',
    })
    expect(buildPushPayload('appointment', 'n2').url).toBe('/patient/appointments')
    expect(buildPushPayload('anything else', 'n3').url).toBe('/patient/notifications')
  })

  it('names no medicine, dose, doctor or time', () => {
    for (const text of [PUSH_TITLE, PUSH_BODY]) {
      expect(text).not.toMatch(/\d|mg|dose|medic|doctor|dr\.|appointment/i)
    }
  })
})

describe('dispatchPushes', () => {
  it('sends each claimed delivery once and records every outcome', async () => {
    const { store, completed } = queue([[delivery(1), delivery(2, 'appointment'), delivery(3)]])
    const outcomes: PushResult[] = [
      { outcome: 'sent', status: 201 },
      { outcome: 'gone', status: 410 },
      { outcome: 'retry', status: 503, error: 'busy', retryAfterSeconds: null },
    ]
    const sent: { payload: string; topic: string }[] = []
    const send = vi.fn(async (_s, payload: string, { topic }: { topic: string }) => {
      sent.push({ payload, topic })
      return outcomes.shift()!
    })

    const summary = await dispatchPushes({ store, send, batchSize: 50 })

    expect(summary).toEqual({ sent: 1, gone: 1, retry: 1, failed: 0, batches: 1 })
    expect(completed.map(([id, r]) => [id.slice(-1), r.outcome])).toEqual([
      ['1', 'sent'],
      ['2', 'gone'],
      ['3', 'retry'],
    ])
    expect(JSON.parse(sent[1]!.payload)).toMatchObject({ url: '/patient/appointments' })
    expect(sent[0]!.topic).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps claiming full batches until the queue is empty', async () => {
    const { store } = queue([[delivery(1), delivery(2)], [delivery(3), delivery(4)], [delivery(5)]])
    const send = vi.fn(async (): Promise<PushResult> => ({ outcome: 'sent', status: 201 }))
    const summary = await dispatchPushes({ store, send, batchSize: 2 })
    expect(summary.sent).toBe(5)
    expect(summary.batches).toBe(3)
  })

  it('stops at the time budget', async () => {
    let clock = 0
    const { store } = queue([[delivery(1)], [delivery(2)], [delivery(3)]])
    const send = vi.fn(async (): Promise<PushResult> => {
      clock += 30_000
      return { outcome: 'sent', status: 201 }
    })
    const summary = await dispatchPushes({ store, send, batchSize: 1, budgetMs: 40_000, now: () => clock })
    expect(summary.batches).toBe(2)
  })

  it('does nothing when nothing is due', async () => {
    const { store } = queue([])
    const send = vi.fn()
    expect(await dispatchPushes({ store, send })).toMatchObject({ batches: 0, sent: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('s3cret-value', 's3cret-value')).toBe(true)
    expect(secretMatches('s3cret-valuX', 's3cret-value')).toBe(false)
    expect(secretMatches('s3cret', 's3cret-value')).toBe(false)
    expect(secretMatches(null, 's3cret-value')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('missingConfig', () => {
  it('names what is missing and nothing else', () => {
    expect(
      missingConfig({ dispatchSecret: '', vapidPublicKey: 'k', vapidPrivateKey: '', vapidSubject: 'nobody' }),
    ).toEqual(['PUSH_DISPATCH_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
    expect(
      missingConfig({
        dispatchSecret: 's',
        vapidPublicKey: 'k',
        vapidPrivateKey: 'p',
        vapidSubject: 'mailto:ops@example.test',
      }),
    ).toEqual([])
  })
})
