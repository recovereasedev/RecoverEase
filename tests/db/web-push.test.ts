import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Web Push (migration 53): who may save a device, what gets queued, and
 * that the queue sends each reminder to each device once - with retries,
 * back-off, give-up and cleanup of devices the push service says are gone.
 *
 * The send itself is the Edge Function's (tests/unit/send-push-handler.test.ts);
 * this is everything the database promises it.
 */

const P256DH = 'B' + 'A'.repeat(86) // 87 base64url characters, like a real key
const AUTH = 'abcdefghijklmnopqrstuv' // 22 characters

let database: TestDatabase
let fixture: Fixture

const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`

async function register(userId: string, n: number): Promise<string> {
  const [row] = await database.asUser<{ id: string }>(
    userId,
    `select public.register_push_subscription($1, $2, $3, 'Android Chrome') as id`,
    [endpoint(n), P256DH, AUTH],
  )
  return row!.id
}

async function notify(userId: string, type: string, message = 'Your Amoxicillin (500mg) is due at 08:00.') {
  const [row] = await database.asService<{ id: string }>(
    `insert into public.notification (user_id, notification_type, notification_message)
     values ($1, $2::public.notification_type, $3) returning notification_id as id`,
    [userId, type, message],
  )
  return row!.id
}

const deliveries = () =>
  database.asService<{
    delivery_id: string
    notification_id: string
    subscription_id: string
    push_kind: string
    delivery_status: string
    attempt_count: number
  }>('select * from public.push_delivery order by delivery_created_at, delivery_id')

const claim = (batch = 50) =>
  database.asService<{ delivery_id: string; push_kind: string; push_endpoint: string; attempt_count: number }>(
    'select * from public.claim_push_deliveries($1)',
    [batch],
  )

const complete = (id: string, outcome: string, retryAfter: number | null = null) =>
  database.asService<{ result: string }>(
    'select public.complete_push_delivery($1, $2, 500, $3, $4) as result',
    [id, outcome, 'test error', retryAfter],
  )

beforeAll(async () => {
  database = await createTestDatabase()
  fixture = await seedFixture(database)
}, 120_000)

afterAll(async () => {
  await database.close()
})

beforeEach(async () => {
  await database.asService('delete from public.push_delivery')
  await database.asService('delete from public.push_subscription')
})

describe('saving a device', () => {
  it('lets a patient save this device, and read only their own', async () => {
    await register(fixture.aliceUserId, 1)
    await register(fixture.bobUserId, 2)

    const alice = await database.asUser<{ push_endpoint: string }>(
      fixture.aliceUserId,
      'select push_endpoint from public.push_subscription',
    )
    expect(alice.map((r) => r.push_endpoint)).toEqual([endpoint(1)])
  })

  it('refuses doctors, admins and visitors', async () => {
    await expect(register(fixture.doctorAUserId, 3)).rejects.toThrow(/for patients/)
    await expect(register(fixture.adminUserId, 4)).rejects.toThrow(/for patients/)
    await expect(
      database.asAnon('select public.register_push_subscription($1, $2, $3)', [endpoint(5), P256DH, AUTH]),
    ).rejects.toThrow()
  })

  it('refuses writing the table directly', async () => {
    await expect(
      database.asUser(
        fixture.aliceUserId,
        `insert into public.push_subscription (user_id, push_endpoint, push_p256dh, push_auth)
         values ($1, $2, $3, $4)`,
        [fixture.aliceUserId, endpoint(6), P256DH, AUTH],
      ),
    ).rejects.toThrow()
    await register(fixture.aliceUserId, 7)
    await expectDenied(() =>
      database.asUser(fixture.bobUserId, 'delete from public.push_subscription returning 1'),
    )
    await expect(
      database.asUser(fixture.aliceUserId, `update public.push_subscription set push_auth = 'x'`),
    ).rejects.toThrow()
  })

  it('refuses an endpoint that is not https or keys of the wrong shape', async () => {
    await expect(
      database.asUser(fixture.aliceUserId, 'select public.register_push_subscription($1, $2, $3)', [
        'http://example.com/push',
        P256DH,
        AUTH,
      ]),
    ).rejects.toThrow()
    await expect(
      database.asUser(fixture.aliceUserId, 'select public.register_push_subscription($1, $2, $3)', [
        endpoint(8),
        'short',
        AUTH,
      ]),
    ).rejects.toThrow()
  })

  it('saving the same device twice keeps one row', async () => {
    const first = await register(fixture.aliceUserId, 9)
    const second = await register(fixture.aliceUserId, 9)
    expect(second).toBe(first)
    const rows = await database.asService('select * from public.push_subscription')
    expect(rows).toHaveLength(1)
  })

  it('moves a shared phone to the account now signed in, dropping what was queued for the last one', async () => {
    await register(fixture.aliceUserId, 10)
    await notify(fixture.aliceUserId, 'medication')
    expect(await deliveries()).toHaveLength(1)

    await register(fixture.bobUserId, 10)

    expect(await deliveries()).toHaveLength(0)
    const [owner] = await database.asService<{ user_id: string }>(
      'select user_id from public.push_subscription where push_endpoint = $1',
      [endpoint(10)],
    )
    expect(owner!.user_id).toBe(fixture.bobUserId)
  })

  it('keeps at most ten devices per patient', async () => {
    for (let n = 100; n < 112; n++) await register(fixture.aliceUserId, n)
    const rows = await database.asService('select * from public.push_subscription')
    expect(rows).toHaveLength(10)
  })

  it('removes only the caller’s own device', async () => {
    await register(fixture.aliceUserId, 11)
    const [bobTry] = await database.asUser<{ removed: boolean }>(
      fixture.bobUserId,
      'select public.unregister_push_subscription($1) as removed',
      [endpoint(11)],
    )
    expect(bobTry!.removed).toBe(false)
    const [aliceTry] = await database.asUser<{ removed: boolean }>(
      fixture.aliceUserId,
      'select public.unregister_push_subscription($1) as removed',
      [endpoint(11)],
    )
    expect(aliceTry!.removed).toBe(true)
  })
})

describe('queueing', () => {
  it('queues one delivery per device for a patient’s medication or appointment reminder', async () => {
    const one = await register(fixture.aliceUserId, 20)
    const two = await register(fixture.aliceUserId, 21)
    const medication = await notify(fixture.aliceUserId, 'medication')
    const appointment = await notify(fixture.aliceUserId, 'appointment', 'You have an upcoming appointment.')

    const rows = await deliveries()
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.subscription_id))).toEqual(new Set([one, two]))
    expect(rows.filter((r) => r.notification_id === medication).map((r) => r.push_kind)).toEqual([
      'medication',
      'medication',
    ])
    expect(rows.filter((r) => r.notification_id === appointment)).toHaveLength(2)
  })

  it('queues nothing for other types, for patients without a device, or for doctors', async () => {
    await register(fixture.aliceUserId, 22)
    await notify(fixture.aliceUserId, 'general', 'A message from your doctor.')
    await notify(fixture.aliceUserId, 'announcement', 'News.')
    await notify(fixture.bobUserId, 'medication')
    await notify(fixture.doctorAUserId, 'appointment', 'Upcoming appointment with Alice.')
    await notify(fixture.doctorAUserId, 'chat_critical', 'Critical concern.')
    expect(await deliveries()).toHaveLength(0)
  })

  it('never holds the reminder’s text', async () => {
    await register(fixture.aliceUserId, 23)
    await notify(fixture.aliceUserId, 'medication')
    const columns = await database.asService<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'push_delivery'`,
    )
    expect(columns.map((c) => c.column_name)).not.toContain('notification_message')
    const text = JSON.stringify(await deliveries())
    expect(text).not.toMatch(/Amoxicillin|500mg/)
  })

  it('is closed to every signed-in user', async () => {
    await register(fixture.aliceUserId, 24)
    await notify(fixture.aliceUserId, 'medication')
    await expectDenied(() => database.asUser(fixture.aliceUserId, 'select * from public.push_delivery'))
    await expect(
      database.asUser(fixture.aliceUserId, `update public.push_delivery set delivery_status = 'sent'`),
    ).rejects.toThrow()
    await expect(database.asUser(fixture.aliceUserId, 'delete from public.push_delivery')).rejects.toThrow()
    await expect(
      database.asUser(fixture.aliceUserId, 'select * from public.claim_push_deliveries(10)'),
    ).rejects.toThrow()
    await expect(
      database.asUser(fixture.aliceUserId, `select public.complete_push_delivery(gen_random_uuid(), 'sent')`),
    ).rejects.toThrow()
    await expect(
      database.asUser(fixture.aliceUserId, 'select app_private.request_push_dispatch()'),
    ).rejects.toThrow()
  })

  it('a queue failure never stops the reminder being stored', async () => {
    await register(fixture.aliceUserId, 25)
    await database.asService(
      `alter table public.push_delivery add constraint test_refuse_all check (push_kind = 'never')`,
    )
    try {
      const id = await notify(fixture.aliceUserId, 'medication')
      const stored = await database.asService('select 1 from public.notification where notification_id = $1', [id])
      expect(stored).toHaveLength(1)
      expect(await deliveries()).toHaveLength(0)
    } finally {
      await database.asService('alter table public.push_delivery drop constraint test_refuse_all')
    }
  })
})

describe('sending once', () => {
  it('claims a delivery once; a second claim finds nothing', async () => {
    await register(fixture.aliceUserId, 30)
    await notify(fixture.aliceUserId, 'medication')

    const first = await claim()
    expect(first).toHaveLength(1)
    expect(first[0]!.push_endpoint).toBe(endpoint(30))
    expect(first[0]!.attempt_count).toBe(1)
    expect(await claim()).toHaveLength(0)

    expect((await complete(first[0]!.delivery_id, 'sent'))[0]!.result).toBe('sent')
    // Recording it again changes nothing.
    expect((await complete(first[0]!.delivery_id, 'sent'))[0]!.result).toBe('ignored')
    expect(await claim()).toHaveLength(0)
    const [row] = await deliveries()
    expect(row!.delivery_status).toBe('sent')
  })

  it('reclaims a delivery a crashed run left behind, once its lock has passed', async () => {
    await register(fixture.aliceUserId, 31)
    await notify(fixture.aliceUserId, 'medication')
    await claim()
    await database.asService(`update public.push_delivery set locked_until = now() - interval '1 second'`)
    const again = await claim()
    expect(again).toHaveLength(1)
    expect(again[0]!.attempt_count).toBe(2)
  })

  it('backs off after a retryable failure, honouring Retry-After', async () => {
    await register(fixture.aliceUserId, 32)
    await notify(fixture.aliceUserId, 'medication')
    const [first] = await claim()
    expect((await complete(first!.delivery_id, 'retry'))[0]!.result).toBe('retry')

    const [after] = await database.asService<{ status: string; wait: number }>(
      `select delivery_status as status,
              extract(epoch from next_attempt_at - now())::int as wait
         from public.push_delivery`,
    )
    expect(after!.status).toBe('pending')
    expect(after!.wait).toBe(30)
    expect(await claim()).toHaveLength(0)

    await database.asService(`update public.push_delivery set next_attempt_at = now()`)
    const [second] = await claim()
    await complete(second!.delivery_id, 'retry', 600)
    const [longer] = await database.asService<{ wait: number }>(
      `select extract(epoch from next_attempt_at - now())::int as wait from public.push_delivery`,
    )
    expect(longer!.wait).toBe(600)
  })

  it('gives up after the fifth attempt', async () => {
    await register(fixture.aliceUserId, 33)
    await notify(fixture.aliceUserId, 'medication')
    let result = ''
    for (let attempt = 1; attempt <= 5; attempt++) {
      await database.asService(`update public.push_delivery set next_attempt_at = now()`)
      const [row] = await claim()
      expect(row!.attempt_count).toBe(attempt)
      result = (await complete(row!.delivery_id, 'retry'))[0]!.result
    }
    expect(result).toBe('failed')
    expect((await deliveries())[0]!.delivery_status).toBe('failed')
  })

  it('forgets a device the push service says is gone', async () => {
    await register(fixture.aliceUserId, 34)
    await notify(fixture.aliceUserId, 'medication')
    const [row] = await claim()
    expect((await complete(row!.delivery_id, 'gone'))[0]!.result).toBe('gone')
    expect(await database.asService('select * from public.push_subscription')).toHaveLength(0)
    expect(await deliveries()).toHaveLength(0)
  })

  it('expires a reminder still unsent after six hours instead of sending it late', async () => {
    await register(fixture.aliceUserId, 35)
    await notify(fixture.aliceUserId, 'medication')
    await database.asService(
      `update public.push_delivery set delivery_created_at = now() - interval '7 hours'`,
    )
    expect(await claim()).toHaveLength(0)
    expect((await deliveries())[0]!.delivery_status).toBe('expired')
  })

  it('prunes finished deliveries after 30 days', async () => {
    await register(fixture.aliceUserId, 36)
    await notify(fixture.aliceUserId, 'medication')
    await database.asService(
      `update public.push_delivery set delivery_status = 'sent', delivery_created_at = now() - interval '31 days'`,
    )
    await claim()
    expect(await deliveries()).toHaveLength(0)
  })

  it('refuses an unknown outcome', async () => {
    await expect(complete('00000000-0000-0000-0000-000000000000', 'maybe')).rejects.toThrow(/Unknown push outcome/)
  })
})

describe('waking send-push', () => {
  it('does nothing when nothing is due', async () => {
    const [row] = await database.asService<{ r: string }>('select app_private.request_push_dispatch() as r')
    expect(row!.r).toBe('nothing due')
  })

  it('does nothing without pg_net, even with deliveries due', async () => {
    await register(fixture.aliceUserId, 40)
    await notify(fixture.aliceUserId, 'medication')
    const [row] = await database.asService<{ r: string }>('select app_private.request_push_dispatch() as r')
    expect(row!.r).toBe('pg_net is not installed')
  })

  it('schedules no job: turning delivery on is a separate, approved step', async () => {
    const sql = await readFile(
      join(process.cwd(), 'supabase/migrations/20260902100053_web_push_notifications.sql'),
      'utf8',
    )
    expect(sql).not.toMatch(/cron\.schedule\s*\(/)
    expect(sql).not.toMatch(/create extension/i)
  })
})

describe('rollback', () => {
  it('removes everything 53 added and leaves notifications working', async () => {
    const scratch = await createTestDatabase()
    try {
      const seeded = await seedFixture(scratch)
      await scratch.db.exec(
        await readFile(join(process.cwd(), 'supabase/rollbacks/20260902100053_web_push_notifications.down.sql'), 'utf8'),
      )
      const [left] = await scratch.asService<{ n: number }>(
        `select (to_regclass('public.push_subscription') is not null)::int
              + (to_regclass('public.push_delivery') is not null)::int
              + (select count(*)::int from pg_trigger where tgname = 'notification_enqueue_push') as n`,
      )
      expect(left!.n).toBe(0)
      await scratch.asService(
        `insert into public.notification (user_id, notification_type, notification_message)
         values ($1, 'medication', 'Still works.')`,
        [seeded.aliceUserId],
      )
    } finally {
      await scratch.close()
    }
  }, 120_000)
})
