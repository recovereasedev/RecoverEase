import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PushResult } from '../../supabase/functions/_shared/web-push'
import {
  dispatchPushes,
  missingConfig,
  secretMatches,
  type ClaimedDelivery,
  type PushStore,
} from '../../supabase/functions/send-push/handler'
import { buildPushPayload, PUSH_BODIES, PUSH_TITLE, PUSH_URLS } from '../../supabase/functions/send-push/payload'

/**
 * send-push's rules with the database and the push service replaced: what
 * it sends, that every outcome is recorded, and when it stops.
 */

const delivery = (n: number, kind = 'medication_reminder'): ClaimedDelivery => ({
  delivery_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  notification_id: `11111111-1111-1111-1111-${String(n).padStart(12, '0')}`,
  push_kind: kind,
  attempt_count: 1,
  push_endpoint: `https://fcm.googleapis.com/fcm/send/device-token-number-${n}`,
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

describe('the message sent to the phone', () => {
  it('says what it is for and where a tap goes - and carries no words', () => {
    expect(buildPushPayload('medication_reminder', 'n1')).toEqual({
      purpose: 'reminder',
      url: '/patient/medications',
      tag: 'recoverease-n1',
    })
    expect(buildPushPayload('appointment_reminder', 'n2')).toEqual({
      purpose: 'reminder',
      url: '/patient/appointments',
      tag: 'recoverease-n2',
    })
  })

  it('a cancellation is an appointment update, never a reminder', () => {
    expect(buildPushPayload('appointment_update', 'n3')).toEqual({
      purpose: 'appointment_update',
      url: '/patient/appointments',
      tag: 'recoverease-n3',
    })
    expect(PUSH_BODIES.appointment_update).toBe('You have an appointment update in RecoverEase.')
    expect(PUSH_BODIES.appointment_update).not.toMatch(/reminder/i)
  })

  it('builds nothing for a kind it does not know', () => {
    for (const kind of ['medication', 'appointment', 'chat_critical', 'general', '', '__proto__', 'toString']) {
      expect(buildPushPayload(kind, 'n4')).toBeNull()
    }
  })

  it('the words name no medicine, dose, doctor, date or time', () => {
    expect(PUSH_TITLE).toBe('RecoverEase')
    expect(PUSH_BODIES.reminder).toBe('You have a reminder in RecoverEase.')
    for (const text of [PUSH_TITLE, ...Object.values(PUSH_BODIES)]) {
      expect(text).not.toMatch(/\d|mg|dose|medic|doctor|dr\.|cancel|monday|tomorrow|today/i)
    }
  })

  it('opens only the two patient pages', () => {
    expect(PUSH_URLS.sort()).toEqual(['/patient/appointments', '/patient/medications'])
  })
})

describe('dispatchPushes', () => {
  it('sends each claimed delivery once and records every outcome as a category', async () => {
    const { store, completed } = queue([[delivery(1), delivery(2, 'appointment_update'), delivery(3)]])
    const outcomes: PushResult[] = [
      { outcome: 'sent', status: 201 },
      { outcome: 'gone', status: 410 },
      { outcome: 'retry', status: 503, errorCode: 'provider_5xx', retryAfterSeconds: null },
    ]
    const sent: { payload: string; topic: string }[] = []
    const send = vi.fn(async (_s, payload: string, { topic }: { topic: string }) => {
      sent.push({ payload, topic })
      return outcomes.shift()!
    })

    const summary = await dispatchPushes({ store, send })

    expect(summary).toEqual({ sent: 1, gone: 1, retry: 1, failed: 0, batches: 1 })
    expect(completed.map(([id, r]) => [id.slice(-1), r.outcome])).toEqual([
      ['1', 'sent'],
      ['2', 'gone'],
      ['3', 'retry'],
    ])
    expect(JSON.parse(sent[1]!.payload)).toEqual({
      purpose: 'appointment_update',
      url: '/patient/appointments',
      tag: 'recoverease-11111111-1111-1111-1111-000000000002',
    })
    expect(sent[0]!.topic).toMatch(/^[0-9a-f]{32}$/)
  })

  it('fails a delivery of an unknown kind without sending anything', async () => {
    const { store, completed } = queue([[delivery(1, 'appointment')]])
    const send = vi.fn()
    const summary = await dispatchPushes({ store, send })
    expect(send).not.toHaveBeenCalled()
    expect(summary.failed).toBe(1)
    expect(completed[0]![1]).toMatchObject({ outcome: 'failed' })
  })

  it('one endpoint that times out costs only its own delivery a retry', async () => {
    const { store, completed } = queue([[delivery(1), delivery(2), delivery(3)]])
    const send = vi.fn(async (subscription: { endpoint: string }): Promise<PushResult> =>
      subscription.endpoint.endsWith('-2')
        ? { outcome: 'retry', status: null, errorCode: 'network_timeout', retryAfterSeconds: null }
        : { outcome: 'sent', status: 201 },
    )
    const summary = await dispatchPushes({ store, send })
    expect(summary).toMatchObject({ sent: 2, retry: 1 })
    expect(completed).toHaveLength(3)
    expect(completed.find(([id]) => id.endsWith('2'))![1]).toMatchObject({ errorCode: 'network_timeout' })
  })

  it('a reply lost after the push service accepted the message leads to a second send, with the same Topic and tag', async () => {
    // The push service takes the message, then the reply never arrives: all
    // RecoverEase can know is "timed out". The delivery is retried, so the
    // push service is handed the message twice. That is the real guarantee -
    // one queue row, sent at least once - and the stable Topic and tag are
    // what let the push service and the phone fold the repeat away when
    // they can. Nothing here can promise the phone shows it only once.
    const accepted: { topic: string; tag: string }[] = []
    const send = vi.fn(async (_subscription: unknown, payload: string, options: { topic: string }): Promise<PushResult> => {
      accepted.push({ topic: options.topic, tag: (JSON.parse(payload) as { tag: string }).tag })
      return accepted.length === 1
        ? { outcome: 'retry', status: null, errorCode: 'network_timeout', retryAfterSeconds: null }
        : { outcome: 'sent', status: 201 }
    })
    const first = queue([[delivery(7)]])
    const second = queue([[{ ...delivery(7), attempt_count: 2 }]])

    expect(await dispatchPushes({ store: first.store, send })).toMatchObject({ retry: 1, sent: 0 })
    expect(await dispatchPushes({ store: second.store, send })).toMatchObject({ retry: 0, sent: 1 })

    // One logical delivery: the same queue row both times, never a second row.
    expect(first.completed[0]![0]).toBe(second.completed[0]![0])
    expect(first.completed[0]![1]).toMatchObject({ outcome: 'retry', errorCode: 'network_timeout' })
    expect(second.completed[0]![1]).toMatchObject({ outcome: 'sent' })
    // Handed to the push service twice, identically labelled.
    expect(accepted).toHaveLength(2)
    expect(accepted[0]).toEqual(accepted[1])
    expect(accepted[0]!.topic).toMatch(/^[0-9a-f]{32}$/)
    expect(accepted[0]!.tag).toBe(`recoverease-${delivery(7).notification_id}`)
  })

  it('one delivery that throws does not stop the others in its batch', async () => {
    const { store, completed } = queue([[delivery(1), delivery(2), delivery(3)]])
    const send = vi.fn(async (subscription: { endpoint: string }): Promise<PushResult> => {
      if (subscription.endpoint.endsWith('-2')) throw new Error('unexpected')
      return { outcome: 'sent', status: 201 }
    })
    const summary = await dispatchPushes({ store, send })
    expect(summary.sent).toBe(2)
    // The one that threw is left for the lease to return.
    expect(completed.map(([id]) => id.slice(-1)).sort()).toEqual(['1', '3'])
  })

  it('keeps claiming full batches until the queue is empty', async () => {
    const { store } = queue([[delivery(1), delivery(2)], [delivery(3), delivery(4)], [delivery(5)]])
    const send = vi.fn(async (): Promise<PushResult> => ({ outcome: 'sent', status: 201 }))
    const summary = await dispatchPushes({ store, send, batchSize: 2 })
    expect(summary.sent).toBe(5)
    expect(summary.batches).toBe(3)
  })

  it('claims no new batch after the time budget', async () => {
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

describe('the time limits fit inside one another', () => {
  // 40 s of claiming + one last batch of at most 10 s < pg_net's 55 s < the
  // queue's 120 s lease. Read from the sources so a change to one is seen.
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('request 10 s, budget 40 s, pg_net 55 s, lease 2 minutes', () => {
    const request = Number(/PUSH_REQUEST_TIMEOUT_MS = (\d[\d_]*)/.exec(read('supabase/functions/_shared/web-push.ts'))![1]!.replace(/_/g, ''))
    const budget = Number(/budgetMs = (\d[\d_]*)/.exec(read('supabase/functions/send-push/handler.ts'))![1]!.replace(/_/g, ''))
    const migration = read('supabase/migrations/20260902100053_web_push_notifications.sql')
    const pgNet = Number(/timeout_milliseconds := (\d+)/.exec(migration)![1])
    const leaseMinutes = Number(/locked_until\s+= case when checked\.refusal is null then now\(\) \+ interval '(\d+) minutes'/.exec(migration)![1])

    expect(request).toBe(10_000)
    expect(budget).toBe(40_000)
    expect(budget + request).toBeLessThan(pgNet)
    expect(pgNet).toBeLessThan(leaseMinutes * 60_000)
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
  const complete = {
    dispatchSecret: 'x'.repeat(43),
    vapidPublicKey: 'k',
    vapidPrivateKey: 'p',
    vapidSubject: 'mailto:ops@example.test',
  }

  it('names what is missing and nothing else', () => {
    expect(
      missingConfig({ dispatchSecret: '', vapidPublicKey: 'k', vapidPrivateKey: '', vapidSubject: 'nobody' }),
    ).toEqual(['PUSH_DISPATCH_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
    expect(missingConfig(complete)).toEqual([])
  })

  it('refuses a dispatch secret short enough to guess', () => {
    expect(missingConfig({ ...complete, dispatchSecret: 'short-secret' })).toEqual(['PUSH_DISPATCH_SECRET'])
  })
})
