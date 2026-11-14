import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { ALLOWED_ENDPOINTS, REFUSED_ENDPOINTS } from './helpers/push-endpoints'

/**
 * Web Push (migration 53), as the database promises it.
 *
 *   - Nobody's browser can read a stored endpoint or key; it can only
 *     register its own device, remove it, and ask yes or no about it.
 *   - Only a patient's own reminder or cancellation is queued, tagged by the
 *     job that wrote it - never worked out from the message.
 *   - A push is checked again when it is about to be sent: a cancelled or
 *     moved appointment, a dose already recorded, a course outside its
 *     dates, reminders switched off, or a phone that changed hands, and it
 *     is skipped. A cancellation is an update, never a reminder.
 *   - Only Chrome-on-Android (FCM) endpoints are accepted.
 *   - One notification reaches one device once: retries, back-off, give-up,
 *     expiry, and cleanup of devices the push service says are gone.
 *   - A phone changing account is atomic, and the device limit keeps it.
 *
 * The send itself is the Edge Function's (tests/unit/web-push-crypto.test.ts,
 * tests/unit/send-push-handler.test.ts). Every push service here is absent:
 * nothing in this file sends anything.
 */

const MIGRATION_53 = '20260902100053'
const ROLLBACK_53 = 'supabase/rollbacks/20260902100053_web_push_notifications.down.sql'
const P256DH = 'B' + 'A'.repeat(86) // 87 base64url characters, like a real key
const AUTH = 'abcdefghijklmnopqrstuv' // 22 characters

const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-token-${String(n).padStart(6, '0')}:APA91b`

type Delivery = {
  delivery_id: string
  notification_id: string
  subscription_id: string
  push_kind: string
  source_event: string
  delivery_status: string
  attempt_count: number
  last_status_code: number | null
  last_error_code: string | null
}

/** Everything the tests ask of one database. */
function pushApi(database: TestDatabase, fixture: () => Fixture) {
  /** Alice's course for the test in hand; made afresh by `reset`. */
  let scheduleId = ''

  const register = (userId: string, n: number) =>
    database.asUser<{ ok: boolean }>(
      userId,
      `select public.register_push_subscription($1, $2, $3, 'Android Chrome') as ok`,
      [endpoint(n), P256DH, AUTH],
    )

  const deliveries = () =>
    database.asService<Delivery>(
      'select * from app_private.push_delivery order by delivery_created_at, push_kind, delivery_id',
    )

  const subscriptions = () =>
    database.asService<{ subscription_id: string; user_id: string; push_endpoint: string }>(
      'select * from app_private.push_subscription order by push_registered_at, subscription_id',
    )

  const claim = (batch = 50) =>
    database.asService<{ delivery_id: string; push_kind: string; push_endpoint: string; attempt_count: number }>(
      'select * from public.claim_push_deliveries($1)',
      [batch],
    )

  const complete = (
    id: string,
    outcome: string,
    options: { code?: string | null; status?: number | null; retryAfter?: number | null } = {},
  ) =>
    database.asService<{ result: string }>(
      'select public.complete_push_delivery($1, $2, $3, $4, $5) as result',
      [id, outcome, options.status ?? null, options.code ?? null, options.retryAfter ?? null],
    )

  /** An appointment of Alice's with Dr A, `hours` from now. */
  const appointment = async (hours = 2) => {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, now() + make_interval(hours => $3)) returning appointment_id as id`,
      [fixture().alicePatId, fixture().doctorAId, hours],
    )
    return row!.id
  }

  /** A pending dose of Alice's, due `minutes` from now (negative: already due). */
  const dose = async (minutes: number) => {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + make_interval(mins => $2)) returning medication_log_id as id`,
      [scheduleId, minutes],
    )
    return row!.id
  }

  /** Ends Alice's course the day before this dose's date (the dose itself stays). */
  const endCourseBefore = (doseId: string) =>
    database.asService(
      `update public.medication_schedule
          set medication_schedule_end_date =
                (select medication_log_dose_date - 1 from public.medication_log where medication_log_id = $2)
        where medication_schedule_id = $1`,
      [scheduleId, doseId],
    )

  const run = (job: 'pre_dose' | 'follow_up' | 'appointments') =>
    database.asService(
      {
        pre_dose: 'select public.dispatch_medication_pre_dose_reminders()',
        follow_up: 'select public.dispatch_medication_reminders(30)',
        appointments: 'select public.dispatch_appointment_reminders(24)',
      }[job],
    )

  const cancel = (appointmentId: string) =>
    database.asService(`update public.appointment set appointment_status = 'cancelled' where appointment_id = $1`, [
      appointmentId,
    ])

  /** Runs SQL as the service role - what the Edge Function's key is. */
  const asServiceRole = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    await database.db.exec('begin')
    try {
      await database.db.exec('set local role service_role')
      const result = await database.db.query<T>(sql, params)
      await database.db.exec('commit')
      return result.rows
    } catch (error) {
      await database.db.exec('rollback')
      throw error
    }
  }

  const reset = async () => {
    await database.asService('delete from app_private.push_delivery')
    await database.asService('delete from app_private.push_subscription')
    await database.asService(`delete from public.notification`)
    // A schedule's dates cannot be changed back once set, so each test gets
    // its own ongoing course, started a month ago, with no doses but its own.
    await database.asService(`delete from public.medication_schedule where medication_schedule_name = 'Paracetamol'`)
    const [schedule] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times, medication_schedule_start_date)
       values ($1, 'Paracetamol', '500mg', 1, '{08:00}'::time[],
               app_private.clinic_today(app_private.clinic_of_patient(
                 app_private.patient_of_prescription($1))) - 30)
       returning medication_schedule_id as id`,
      [fixture().alicePrescriptionId],
    )
    scheduleId = schedule!.id
    await database.asService('delete from public.medication_log where medication_schedule_id = $1', [scheduleId])
    // The tests' own appointments are hours away; the fixture's are a week out.
    await database.asService(`delete from public.appointment where appointment_date < now() + interval '3 days'`)
    await database.asService(
      'update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null',
    )
  }

  return {
    register,
    deliveries,
    subscriptions,
    claim,
    complete,
    appointment,
    dose,
    endCourseBefore,
    run,
    cancel,
    asServiceRole,
    reset,
  }
}

let database: TestDatabase
let fixture: Fixture
let push: ReturnType<typeof pushApi>

beforeAll(async () => {
  database = await createTestDatabase()
  fixture = await seedFixture(database)
  push = pushApi(database, () => fixture)
}, 120_000)

afterAll(async () => {
  await database?.close()
})

beforeEach(async () => {
  await push.reset()
})

// ===========================================================================
// 1. Subscription credentials are not readable by any client
// ===========================================================================

describe('subscription credentials', () => {
  it('are in a private schema: no client role holds any privilege on either table', async () => {
    const rows = await database.asService<{ role: string; table_name: string; privilege: string }>(
      `select r.role, t.table_name, p.privilege
         from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
        cross join unnest(array['app_private.push_subscription', 'app_private.push_delivery']) as t(table_name)
        cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p(privilege)
        where has_table_privilege(r.role, t.table_name, p.privilege)`,
    )
    expect(rows).toEqual([])

    const [exposed] = await database.asService<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name like 'push%'`,
    )
    expect(exposed!.n).toBe(0)
  })

  it('no column of them is readable either', async () => {
    const rows = await database.asService<{ role: string; column_name: string }>(
      `select r.role, c.column_name
         from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
        cross join information_schema.columns c
        where c.table_schema = 'app_private' and c.table_name in ('push_subscription', 'push_delivery')
          and has_column_privilege(r.role, format('%I.%I', c.table_schema, c.table_name), c.column_name, 'select')`,
    )
    expect(rows).toEqual([])
  })

  it('a patient cannot read their own endpoint or keys, by any column', async () => {
    await push.register(fixture.aliceUserId, 1)
    for (const sql of [
      'select * from app_private.push_subscription',
      'select push_endpoint from app_private.push_subscription',
      'select push_p256dh from app_private.push_subscription',
      'select push_auth from app_private.push_subscription',
      'select count(*) from app_private.push_subscription',
      'select * from public.push_subscription',
      'select * from app_private.push_delivery',
    ]) {
      await expect(database.asUser(fixture.aliceUserId, sql), sql).rejects.toThrow(
        /permission denied|does not exist/,
      )
    }
  })

  it('nor can another patient, a doctor, an admin or a visitor', async () => {
    await push.register(fixture.aliceUserId, 1)
    for (const userId of [fixture.bobUserId, fixture.doctorAUserId, fixture.adminUserId]) {
      await expect(
        database.asUser(userId, 'select push_endpoint from app_private.push_subscription'),
      ).rejects.toThrow(/permission denied/)
    }
    await expect(database.asAnon('select push_endpoint from app_private.push_subscription')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('nor can a patient write either table', async () => {
    await push.register(fixture.aliceUserId, 1)
    for (const sql of [
      `insert into app_private.push_subscription (user_id, push_endpoint, push_p256dh, push_auth)
       values ('${fixture.aliceUserId}', '${endpoint(2)}', '${P256DH}', '${AUTH}')`,
      `update app_private.push_subscription set user_id = '${fixture.aliceUserId}'`,
      'delete from app_private.push_subscription',
      `update app_private.push_delivery set delivery_status = 'sent'`,
      'delete from app_private.push_delivery',
    ]) {
      await expect(database.asUser(fixture.bobUserId, sql), sql).rejects.toThrow(/permission denied/)
    }
  })

  it('registering returns true, not what was stored', async () => {
    expect(await push.register(fixture.aliceUserId, 1)).toEqual([{ ok: true }])
    const [signature] = await database.asService<{ returns: string; is_set: boolean }>(
      `select pg_get_function_result(oid) as returns, proretset as is_set
         from pg_proc where oid = 'public.register_push_subscription(text, text, text, text)'::regprocedure`,
    )
    expect(signature).toEqual({ returns: 'boolean', is_set: false })
  })

  it('the status function answers yes or no, about the caller\u2019s own device only', async () => {
    await push.register(fixture.aliceUserId, 1)
    const ask = (userId: string, n: number) =>
      database.asUser<Record<string, unknown>>(userId, 'select public.push_device_registered($1) as registered', [
        endpoint(n),
      ])

    expect(await ask(fixture.aliceUserId, 1)).toEqual([{ registered: true }])
    expect(await ask(fixture.aliceUserId, 2)).toEqual([{ registered: false }])
    // Bob learns nothing about Alice's device: the same answer as for one that does not exist.
    expect(await ask(fixture.bobUserId, 1)).toEqual([{ registered: false }])

    const [signature] = await database.asService<{ returns: string; is_set: boolean }>(
      `select pg_get_function_result(oid) as returns, proretset as is_set
         from pg_proc where oid = 'public.push_device_registered(text)'::regprocedure`,
    )
    expect(signature).toEqual({ returns: 'boolean', is_set: false })
  })

  it('refuses visitors every function, and doctors and admins registration', async () => {
    for (const sql of [
      `select public.register_push_subscription('${endpoint(3)}', '${P256DH}', '${AUTH}')`,
      `select public.unregister_push_subscription('${endpoint(3)}')`,
      `select public.push_device_registered('${endpoint(3)}')`,
    ]) {
      await expect(database.asAnon(sql), sql).rejects.toThrow(/permission denied/)
    }
    await expect(push.register(fixture.doctorAUserId, 3)).rejects.toThrow(/for patients/)
    await expect(push.register(fixture.adminUserId, 4)).rejects.toThrow(/for patients/)
    expect(await push.subscriptions()).toEqual([])
  })

  it('refuses keys of the wrong shape', async () => {
    for (const [p256dh, auth] of [
      ['short', AUTH],
      [P256DH, 'short'],
      [P256DH + '=', AUTH],
      ["B'; drop table public.patient; --".padEnd(87, 'A'), AUTH],
    ]) {
      await expect(
        database.asUser(fixture.aliceUserId, 'select public.register_push_subscription($1, $2, $3)', [
          endpoint(5),
          p256dh,
          auth,
        ]),
      ).rejects.toThrow(/violates check constraint/)
    }
  })

  it('removes only the caller\u2019s own device', async () => {
    await push.register(fixture.aliceUserId, 6)
    const remove = (userId: string) =>
      database.asUser<{ removed: boolean }>(userId, 'select public.unregister_push_subscription($1) as removed', [
        endpoint(6),
      ])
    expect(await remove(fixture.bobUserId)).toEqual([{ removed: false }])
    expect(await push.subscriptions()).toHaveLength(1)
    expect(await remove(fixture.aliceUserId)).toEqual([{ removed: true }])
    expect(await push.subscriptions()).toHaveLength(0)
  })

  it('the service role reaches the queue through its two functions and nothing else', async () => {
    await push.register(fixture.aliceUserId, 7)
    const id = await push.appointment()
    await push.run('appointments')

    await expect(push.asServiceRole('select * from app_private.push_subscription')).rejects.toThrow(/permission denied/)
    await expect(push.asServiceRole('select * from app_private.push_delivery')).rejects.toThrow(/permission denied/)
    // Not even the wake-up: that is the scheduled job's, run by the database owner.
    await expect(push.asServiceRole('select app_private.request_push_dispatch()')).rejects.toThrow(/permission denied/)

    const claimed = await push.asServiceRole<{ delivery_id: string; push_endpoint: string }>(
      'select * from public.claim_push_deliveries(10)',
    )
    expect(claimed.map((row) => row.push_endpoint)).toEqual([endpoint(7)])
    expect(
      await push.asServiceRole(`select public.complete_push_delivery($1, 'sent', 201) as result`, [
        claimed[0]!.delivery_id,
      ]),
    ).toEqual([{ result: 'sent' }])
    expect(id).toBeTruthy()
  })

  it('no signed-in user can claim, complete, wake or check the queue', async () => {
    for (const sql of [
      'select * from public.claim_push_deliveries(10)',
      `select public.complete_push_delivery(gen_random_uuid(), 'sent')`,
      'select app_private.request_push_dispatch()',
      `select app_private.push_endpoint_is_allowed('${endpoint(1)}')`,
      `select app_private.push_source_is_current('appointment_reminder', null, gen_random_uuid(), now(), gen_random_uuid())`,
    ]) {
      await expect(database.asUser(fixture.aliceUserId, sql), sql).rejects.toThrow(/permission denied/)
      await expect(database.asAnon(sql), sql).rejects.toThrow(/permission denied/)
    }
  })

  it('every function of the migration that runs with its owner\u2019s rights has an empty search_path', async () => {
    const rows = await database.asService<{ name: string; definer: boolean; config: string | null }>(
      `select p.oid::regprocedure::text as name, p.prosecdef as definer, array_to_string(p.proconfig, ',') as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app_private')
          and (p.proname like '%push%' or p.proname in (
                 'dispatch_medication_reminders', 'dispatch_medication_pre_dose_reminders',
                 'dispatch_appointment_reminders', 'appointment_notify_cancellation'))
        order by 1`,
    )
    expect(rows.length).toBe(13)
    for (const row of rows) expect(row.config, row.name).toBe('search_path=""')
    expect(rows.filter((row) => !row.definer).map((row) => row.name)).toEqual([
      'app_private.push_endpoint_is_allowed(text)',
    ])
  })
})

// ===========================================================================
// 2. What is queued, and what it is called
// ===========================================================================

describe('queueing from the real reminder jobs', () => {
  it('a reminder before a dose is a medication reminder, tagged with its dose', async () => {
    await push.register(fixture.aliceUserId, 10)
    const doseId = await push.dose(5)
    await push.run('pre_dose')

    const notifications = await database.asService<Record<string, unknown>>(
      `select user_id, notification_type::text, notification_message, notification_source,
              notification_purpose, notification_medication_log_id, notification_appointment_id
         from public.notification`,
    )
    expect(notifications).toEqual([
      {
        user_id: fixture.aliceUserId,
        notification_type: 'medication',
        // The in-app message is exactly what it was before migration 53.
        notification_message: expect.stringMatching(/^Your Paracetamol \(500mg\) is due at \d\d:\d\d\.$/),
        notification_source: 'medication_pre_dose',
        notification_purpose: 'reminder',
        notification_medication_log_id: doseId,
        notification_appointment_id: null,
      },
    ])
    expect(await push.deliveries()).toMatchObject([
      { push_kind: 'medication_reminder', source_event: 'medication_pre_dose', delivery_status: 'pending' },
    ])
  })

  it('a follow-up after a missed dose is a medication reminder too', async () => {
    await push.register(fixture.aliceUserId, 11)
    await push.dose(-45)
    await push.run('follow_up')
    expect(await push.deliveries()).toMatchObject([
      { push_kind: 'medication_reminder', source_event: 'medication_follow_up' },
    ])
  })

  it('an appointment reminder is queued for the patient, never for the doctor', async () => {
    await push.register(fixture.aliceUserId, 12)
    // A doctor cannot register; force a device onto the doctor's account to
    // prove the queue itself refuses them.
    await database.asService(
      `insert into app_private.push_subscription (user_id, push_endpoint, push_p256dh, push_auth)
       values ($1, $2, $3, $4)`,
      [fixture.doctorAUserId, endpoint(13), P256DH, AUTH],
    )
    const id = await push.appointment()
    await push.run('appointments')

    const notified = await database.asService<{ user_id: string; notification_appointment_id: string }>(
      `select user_id, notification_appointment_id from public.notification
        where notification_source = 'appointment_reminder' order by user_id`,
    )
    expect(notified.map((row) => row.user_id).sort()).toEqual([fixture.aliceUserId, fixture.doctorAUserId].sort())
    expect(new Set(notified.map((row) => row.notification_appointment_id))).toEqual(new Set([id]))

    const queued = await push.deliveries()
    expect(queued).toMatchObject([{ push_kind: 'appointment_reminder', source_event: 'appointment_reminder' }])
    const [owner] = await database.asService<{ user_id: string }>(
      'select user_id from app_private.push_subscription where subscription_id = $1',
      [queued[0]!.subscription_id],
    )
    expect(owner!.user_id).toBe(fixture.aliceUserId)
  })

  it('a cancellation is an appointment update, never a reminder', async () => {
    await push.register(fixture.aliceUserId, 14)
    const id = await push.appointment()
    await push.cancel(id)

    const [stored] = await database.asService<Record<string, unknown>>(
      `select notification_type::text, notification_message, notification_source, notification_purpose
         from public.notification where user_id = $1`,
      [fixture.aliceUserId],
    )
    expect(stored).toEqual({
      notification_type: 'appointment',
      notification_message: expect.stringMatching(/^Your appointment on .+ has been cancelled\.$/),
      notification_source: 'appointment_cancellation',
      notification_purpose: 'update',
    })
    const queued = await push.deliveries()
    expect(queued).toMatchObject([{ push_kind: 'appointment_update', source_event: 'appointment_cancellation' }])
    expect(queued.some((row) => row.push_kind.includes('reminder'))).toBe(false)

    const claimed = await push.claim()
    expect(claimed.map((row) => row.push_kind)).toEqual(['appointment_update'])
  })

  it('one delivery per device', async () => {
    await push.register(fixture.aliceUserId, 15)
    await push.register(fixture.aliceUserId, 16)
    await push.dose(5)
    await push.run('pre_dose')
    const queued = await push.deliveries()
    expect(queued).toHaveLength(2)
    expect(new Set(queued.map((row) => row.subscription_id)).size).toBe(2)
  })

  it('queues nothing for a notification that does not say what it is about', async () => {
    await push.register(fixture.aliceUserId, 17)
    await database.asService(
      `insert into public.notification (user_id, notification_type, notification_message) values
         ($1, 'medication', 'Your Paracetamol (500mg) is due at 08:00.'),
         ($1, 'appointment', 'Your appointment on Monday at 09:00 has been cancelled.'),
         ($1, 'general', 'A message from your doctor.'),
         ($1, 'announcement', 'News.'),
         ($1, 'chat_critical', 'Critical concern.')`,
      [fixture.aliceUserId],
    )
    await database.asUser(
      fixture.doctorAUserId,
      `insert into public.notification (user_id, notification_type, notification_message)
       values ($1, 'general', 'Please call the clinic.')`,
      [fixture.aliceUserId],
    )
    expect(await push.deliveries()).toEqual([])
  })

  it('queues nothing for a tag pointing at someone else\u2019s dose or appointment', async () => {
    await push.register(fixture.bobUserId, 18)
    const aliceDose = await push.dose(5)
    const aliceAppointment = await push.appointment()
    await database.asService(
      `insert into public.notification
         (user_id, notification_type, notification_message, notification_source, notification_purpose,
          notification_medication_log_id, notification_appointment_id) values
         ($1, 'medication', 'x', 'medication_pre_dose', 'reminder', $2, null),
         ($1, 'appointment', 'x', 'appointment_reminder', 'reminder', null, $3),
         ($1, 'appointment', 'x', 'appointment_cancellation', 'update', null, gen_random_uuid())`,
      [fixture.bobUserId, aliceDose, aliceAppointment],
    )
    expect(await push.deliveries()).toEqual([])
  })

  it('a doctor cannot write a tagged notification to a patient', async () => {
    await push.register(fixture.aliceUserId, 19)
    const id = await push.appointment()
    await expect(
      database.asUser(
        fixture.doctorAUserId,
        `insert into public.notification
           (user_id, notification_type, notification_message, notification_source, notification_purpose, notification_appointment_id)
         values ($1, 'general', 'x', 'appointment_reminder', 'reminder', $2)`,
        [fixture.aliceUserId, id],
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await push.deliveries()).toEqual([])
  })

  it('a source and its purpose cannot disagree', async () => {
    for (const [source, purpose] of [
      ['appointment_cancellation', 'reminder'],
      ['appointment_reminder', 'update'],
      ['medication_pre_dose', 'update'],
      ['made_up', 'reminder'],
    ]) {
      await expect(
        database.asService(
          `insert into public.notification (user_id, notification_type, notification_message, notification_source, notification_purpose)
           values ($1, 'appointment', 'x', $2, $3)`,
          [fixture.aliceUserId, source, purpose],
        ),
      ).rejects.toThrow(/violates check constraint/)
    }
  })

  it('the queue holds no text: not the message, not a name, not a dose', async () => {
    await push.register(fixture.aliceUserId, 20)
    await push.dose(5)
    await push.run('pre_dose')
    const id = await push.appointment()
    await push.cancel(id)

    const textColumns = await database.asService<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'app_private' and table_name = 'push_delivery' and data_type = 'text'
        order by 1`,
    )
    // Each of these is held to a fixed list of values by a check constraint.
    expect(textColumns.map((c) => c.column_name)).toEqual([
      'delivery_status',
      'last_error_code',
      'push_kind',
      'source_event',
    ])
    expect(JSON.stringify(await push.deliveries())).not.toMatch(/Paracetamol|500mg|has been cancelled|Alice|is due at/)
  })

  it('a queue failure never stops the notification being stored', async () => {
    await push.register(fixture.aliceUserId, 21)
    await database.asService(
      `alter table app_private.push_delivery add constraint test_refuse_all check (push_kind = 'never')`,
    )
    try {
      await push.dose(5)
      await push.run('pre_dose')
      expect(await database.asService('select 1 from public.notification')).toHaveLength(1)
      expect(await push.deliveries()).toEqual([])
    } finally {
      await database.asService('alter table app_private.push_delivery drop constraint test_refuse_all')
    }
  })
})

// ===========================================================================
// 2b. Still true when it is about to be sent?
// ===========================================================================

describe('checked again just before sending', () => {
  const skipped = { delivery_status: 'skipped', last_error_code: 'source_no_longer_valid', attempt_count: 0 }

  it('sends a reminder that is still true', async () => {
    await push.register(fixture.aliceUserId, 30)
    await push.appointment()
    await push.dose(5)
    await push.run('appointments')
    await push.run('pre_dose')
    expect((await push.claim()).map((row) => row.push_kind).sort()).toEqual([
      'appointment_reminder',
      'medication_reminder',
    ])
  })

  it('an appointment cancelled after its reminder was queued: the reminder is skipped, the update is sent', async () => {
    await push.register(fixture.aliceUserId, 31)
    const id = await push.appointment()
    await push.run('appointments')
    await push.cancel(id)

    const claimed = await push.claim()
    expect(claimed.map((row) => row.push_kind)).toEqual(['appointment_update'])
    const queued = await push.deliveries()
    expect(queued.find((row) => row.push_kind === 'appointment_reminder')).toMatchObject(skipped)
    expect(queued.find((row) => row.push_kind === 'appointment_update')).toMatchObject({ delivery_status: 'sending' })
    // Skipped for good: it is never offered again.
    expect(await push.claim()).toEqual([])
  })

  it('an appointment moved by an approved reschedule: the old time\u2019s reminder is skipped, the new one\u2019s is sent', async () => {
    await push.register(fixture.aliceUserId, 32)
    const id = await push.appointment()
    await push.run('appointments')

    // The patient asks, the doctor approves: the database's own path, which
    // moves appointment_date and clears the reminder mark (migration 19).
    const [request] = await database.asUser<{ id: string }>(
      fixture.aliceUserId,
      `insert into public.reschedule_request (appointment_id, user_id, reschedule_request_date, reschedule_request_reason)
       values ($1, $2, now() + interval '5 hours', 'Work') returning reschedule_request_id as id`,
      [id, fixture.aliceUserId],
    )
    await database.asUser(
      fixture.doctorAUserId,
      `update public.reschedule_request set reschedule_request_status = 'approved' where reschedule_request_id = $1`,
      [request!.id],
    )

    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])

    await push.run('appointments')
    expect((await push.claim()).map((row) => row.push_kind)).toEqual(['appointment_reminder'])
  })

  it('an appointment already completed or missed is not reminded about', async () => {
    await push.register(fixture.aliceUserId, 33)
    const id = await push.appointment()
    await push.run('appointments')
    await database.asService(`update public.appointment set appointment_status = 'completed' where appointment_id = $1`, [id])
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('an appointment that has been deleted is not reminded about', async () => {
    await push.register(fixture.aliceUserId, 34)
    const id = await push.appointment()
    await push.run('appointments')
    await database.asService('delete from public.appointment where appointment_id = $1', [id])
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it.each(['taken', 'missed'])('a dose recorded as %s before dispatch is skipped', async (status) => {
    await push.register(fixture.aliceUserId, 35)
    const id = await push.dose(5)
    await push.run('pre_dose')
    await database.asService(
      `update public.medication_log
          set medication_log_status = $2::public.medication_log_status,
              medication_log_taken_at = case when $2 = 'taken' then now() end
        where medication_log_id = $1`,
      [id, status],
    )
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a dose the patient records as taken themselves is skipped', async () => {
    await push.register(fixture.aliceUserId, 36)
    const id = await push.dose(-45)
    await push.run('follow_up')
    await database.asUser(
      fixture.aliceUserId,
      `update public.medication_log set medication_log_status = 'taken', medication_log_taken_at = now()
        where medication_log_id = $1`,
      [id],
    )
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a course ended before dispatch: its reminder is skipped', async () => {
    await push.register(fixture.aliceUserId, 37)
    const id = await push.dose(-45)
    await push.run('follow_up')
    await push.endCourseBefore(id)
    // The dose itself is still there and still pending: it is the end date that makes it stale.
    expect(
      await database.asService('select 1 from public.medication_log where medication_log_id = $1 and medication_log_status = $2', [
        id,
        'pending',
      ]),
    ).toHaveLength(1)
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a dose slot removed with its course is skipped', async () => {
    await push.register(fixture.aliceUserId, 39)
    const id = await push.dose(5)
    await push.run('pre_dose')
    await database.asService('delete from public.medication_log where medication_log_id = $1', [id])
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a "due soon" reminder is not sent half an hour after the dose', async () => {
    await push.register(fixture.aliceUserId, 41)
    await push.dose(5)
    await push.run('pre_dose')
    // Time passing, which a test cannot wait for: the dose and what was
    // queued about it are both moved 36 minutes into the past. The app
    // itself can never move a dose (its guard is set aside for this only).
    await database.asService('alter table public.medication_log disable trigger user')
    try {
      await database.asService(
        `update public.medication_log set medication_log_scheduled_at = medication_log_scheduled_at - interval '36 minutes'`,
      )
    } finally {
      await database.asService('alter table public.medication_log enable trigger user')
    }
    await database.asService(
      `update app_private.push_delivery set source_due_at = source_due_at - interval '36 minutes'`,
    )
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a reminder about a time the dose no longer has is skipped', async () => {
    await push.register(fixture.aliceUserId, 40)
    await push.dose(5)
    await push.run('pre_dose')
    await database.asService(
      `update app_private.push_delivery set source_due_at = source_due_at - interval '3 hours'`,
    )
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([skipped])
  })

  it('a patient who turned medication reminders off gets no medication push - but still their appointment\u2019s', async () => {
    await push.register(fixture.aliceUserId, 42)
    await push.dose(5)
    await push.appointment()
    await push.run('pre_dose')
    await push.run('appointments')
    await database.asUser(
      fixture.aliceUserId,
      `update public.patient set pat_reminder_is_enabled = false where user_id = $1`,
      [fixture.aliceUserId],
    )
    expect((await push.claim()).map((row) => row.push_kind)).toEqual(['appointment_reminder'])
    expect((await push.deliveries()).find((row) => row.push_kind === 'medication_reminder')).toMatchObject(skipped)
  })

  it('a phone that changed account between queueing and sending gets nothing of the last account\u2019s', async () => {
    await push.register(fixture.aliceUserId, 43)
    await push.dose(5)
    await push.run('pre_dose')
    // As if the transfer committed in the instant after Alice's push was
    // queued, so the registration's own clean-up could not see it.
    await database.asService('update app_private.push_subscription set user_id = $1', [fixture.bobUserId])

    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([
      { delivery_status: 'skipped', last_error_code: 'owner_changed', attempt_count: 0 },
    ])
  })

  it('an endpoint off the allow-list is never handed to the sender', async () => {
    await push.register(fixture.aliceUserId, 44)
    await push.dose(5)
    await push.run('pre_dose')
    await database.asService(
      'alter table app_private.push_subscription drop constraint push_subscription_endpoint_allowed',
    )
    try {
      await database.asService(
        `update app_private.push_subscription set push_endpoint = 'https://169.254.169.254/latest/meta-data/'`,
      )
      expect(await push.claim()).toEqual([])
      expect(await push.deliveries()).toMatchObject([
        { delivery_status: 'failed', last_error_code: 'invalid_endpoint', attempt_count: 0 },
      ])
    } finally {
      await database.asService('delete from app_private.push_subscription')
      await database.asService(
        `alter table app_private.push_subscription add constraint push_subscription_endpoint_allowed
           check (app_private.push_endpoint_is_allowed(push_endpoint))`,
      )
    }
  })

  it('the check reads the dose and the appointment, never the message', async () => {
    const sql = (
      await readFile(join(process.cwd(), 'supabase/migrations/20260902100053_web_push_notifications.sql'), 'utf8')
    ).replace(/--.*$/gm, '')
    const queueHalf = sql.slice(sql.indexOf('create or replace function app_private.push_endpoint_is_allowed'))
    expect(queueHalf.length).toBeGreaterThan(5_000)
    // Nothing from the first function of the queue onwards so much as names
    // the message column, let alone searches text.
    expect(queueHalf).not.toMatch(/notification_message/)
    expect(queueHalf).not.toMatch(/\blike\b|\bilike\b|position\(|strpos\(|regexp_/i)
  })
})

// ===========================================================================
// 3. Only Chrome-on-Android (FCM) endpoints
// ===========================================================================

describe('endpoints', () => {
  it.each(ALLOWED_ENDPOINTS)('accepts %s', async (url) => {
    const [row] = await database.asService<{ ok: boolean }>('select app_private.push_endpoint_is_allowed($1) as ok', [url])
    expect(row!.ok).toBe(true)
    await expect(
      database.asUser(fixture.aliceUserId, 'select public.register_push_subscription($1, $2, $3)', [url, P256DH, AUTH]),
    ).resolves.toBeDefined()
  })

  it.each(REFUSED_ENDPOINTS)('refuses %j', async (url) => {
    const [row] = await database.asService<{ ok: boolean }>('select app_private.push_endpoint_is_allowed($1) as ok', [url])
    expect(row!.ok).toBe(false)
    await expect(
      database.asUser(fixture.aliceUserId, 'select public.register_push_subscription($1, $2, $3)', [url, P256DH, AUTH]),
    ).rejects.toThrow(/not supported/)
    expect(await push.subscriptions()).toEqual([])
  })

  it('refuses a missing endpoint', async () => {
    const [row] = await database.asService<{ ok: boolean }>('select app_private.push_endpoint_is_allowed(null) as ok')
    expect(row!.ok).toBe(false)
  })

  it('the table refuses one too, however it is written to', async () => {
    await expect(
      database.asService(
        `insert into app_private.push_subscription (user_id, push_endpoint, push_p256dh, push_auth)
         values ($1, 'https://10.0.0.5/fcm/send/abcdefghijklmnopqrstuvwx', $2, $3)`,
        [fixture.aliceUserId, P256DH, AUTH],
      ),
    ).rejects.toThrow(/push_subscription_endpoint_allowed/)
  })
})

// ===========================================================================
// 4. Once each: retries, back-off, give-up, expiry, sanitised errors
// ===========================================================================

describe('sending once', () => {
  beforeEach(async () => {
    await push.register(fixture.aliceUserId, 50)
    await push.appointment()
    await push.run('appointments')
  })

  it('claims a delivery once; a second claim finds nothing', async () => {
    const first = await push.claim()
    expect(first).toHaveLength(1)
    expect(first[0]!.push_endpoint).toBe(endpoint(50))
    expect(first[0]!.attempt_count).toBe(1)
    expect(await push.claim()).toEqual([])

    expect(await push.complete(first[0]!.delivery_id, 'sent', { status: 201 })).toEqual([{ result: 'sent' }])
    // Recording it again changes nothing.
    expect(await push.complete(first[0]!.delivery_id, 'sent', { status: 201 })).toEqual([{ result: 'ignored' }])
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([{ delivery_status: 'sent', last_status_code: 201 }])
  })

  it('reclaims a delivery a crashed run left behind, once its two-minute lease has passed', async () => {
    await push.claim()
    const [lease] = await database.asService<{ seconds: number }>(
      `select round(extract(epoch from locked_until - now()))::int as seconds from app_private.push_delivery`,
    )
    expect(lease!.seconds).toBe(120)
    await database.asService(`update app_private.push_delivery set locked_until = now() - interval '1 second'`)
    const again = await push.claim()
    expect(again).toHaveLength(1)
    expect(again[0]!.attempt_count).toBe(2)
  })

  it('backs off after a timeout, honouring Retry-After, and stores a category', async () => {
    const [first] = await push.claim()
    expect(await push.complete(first!.delivery_id, 'retry', { code: 'network_timeout' })).toEqual([{ result: 'retry' }])

    const [after] = await database.asService<{ status: string; code: string; wait: number }>(
      `select delivery_status as status, last_error_code as code,
              extract(epoch from next_attempt_at - now())::int as wait
         from app_private.push_delivery`,
    )
    expect(after).toEqual({ status: 'pending', code: 'network_timeout', wait: 30 })
    expect(await push.claim()).toEqual([])

    await database.asService(`update app_private.push_delivery set next_attempt_at = now()`)
    const [second] = await push.claim()
    await push.complete(second!.delivery_id, 'retry', { code: 'provider_429', status: 429, retryAfter: 600 })
    const [longer] = await database.asService<{ wait: number; code: string; status: number }>(
      `select extract(epoch from next_attempt_at - now())::int as wait, last_error_code as code,
              last_status_code as status from app_private.push_delivery`,
    )
    expect(longer).toEqual({ wait: 600, code: 'provider_429', status: 429 })
  })

  it('gives up after the fifth attempt', async () => {
    let result = ''
    for (let attempt = 1; attempt <= 5; attempt++) {
      await database.asService(`update app_private.push_delivery set next_attempt_at = now()`)
      const [row] = await push.claim()
      expect(row!.attempt_count).toBe(attempt)
      result = (await push.complete(row!.delivery_id, 'retry', { code: 'provider_5xx', status: 503 }))[0]!.result
    }
    expect(result).toBe('failed')
    expect(await push.deliveries()).toMatchObject([{ delivery_status: 'failed', last_error_code: 'gave_up' }])
  })

  it('stores only a category: a URL, a provider reply or free text is refused', async () => {
    const [row] = await push.claim()
    for (const text of [
      endpoint(50),
      'network error: connect ECONNREFUSED https://fcm.googleapis.com/fcm/send/abc',
      '<html>Internal Server Error</html>',
      'anything else',
    ]) {
      await expect(push.complete(row!.delivery_id, 'retry', { code: text })).rejects.toThrow(
        /push_delivery_error_code/,
      )
    }
    const columns = await database.asService<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'app_private' and table_name = 'push_delivery'`,
    )
    expect(columns.map((c) => c.column_name)).not.toContain('last_error')
    await push.complete(row!.delivery_id, 'failed', { code: 'invalid_vapid', status: 403 })
    expect(await push.deliveries()).toMatchObject([
      { delivery_status: 'failed', last_error_code: 'invalid_vapid', last_status_code: 403 },
    ])
  })

  it('forgets a device the push service says is gone', async () => {
    const [row] = await push.claim()
    expect(await push.complete(row!.delivery_id, 'gone', { status: 410 })).toEqual([{ result: 'gone' }])
    expect(await push.subscriptions()).toEqual([])
    expect(await push.deliveries()).toEqual([])
  })

  it('expires a push still unsent after six hours instead of sending it late', async () => {
    await database.asService(
      `update app_private.push_delivery set delivery_created_at = now() - interval '7 hours'`,
    )
    expect(await push.claim()).toEqual([])
    expect(await push.deliveries()).toMatchObject([{ delivery_status: 'expired' }])
  })

  it('prunes finished deliveries after 30 days', async () => {
    await database.asService(
      `update app_private.push_delivery set delivery_status = 'sent', delivery_created_at = now() - interval '31 days'`,
    )
    await push.claim()
    expect(await push.deliveries()).toEqual([])
  })

  it('refuses an unknown outcome', async () => {
    await expect(push.complete('00000000-0000-0000-0000-000000000000', 'maybe')).rejects.toThrow(
      /Unknown push outcome/,
    )
  })
})

describe('waking send-push', () => {
  it('does nothing when nothing is due', async () => {
    const [row] = await database.asService<{ r: string }>('select app_private.request_push_dispatch() as r')
    expect(row!.r).toBe('nothing due')
  })

  it('does nothing without pg_net, even with deliveries due', async () => {
    await push.register(fixture.aliceUserId, 60)
    await push.appointment()
    await push.run('appointments')
    const [row] = await database.asService<{ r: string }>('select app_private.request_push_dispatch() as r')
    expect(row!.r).toBe('pg_net is not installed')
  })

  it('the migration schedules no job and installs no extension: turning delivery on is a separate, approved step', async () => {
    const sql = (
      await readFile(join(process.cwd(), 'supabase/migrations/20260902100053_web_push_notifications.sql'), 'utf8')
    ).replace(/--.*$/gm, '')
    expect(sql).not.toMatch(/cron\.schedule\s*\(/)
    expect(sql).not.toMatch(/create extension/i)
  })
})

// ===========================================================================
// 5. A phone changing account
// ===========================================================================

describe('a phone changing account', () => {
  it('moves to the account now signed in, one row, and drops what was queued for the last one', async () => {
    await push.register(fixture.aliceUserId, 70)
    await push.appointment()
    await push.run('appointments')
    await push.claim() // One of Alice's is even mid-send.
    await push.dose(5)
    await push.run('pre_dose')
    expect((await push.deliveries()).map((row) => row.delivery_status).sort()).toEqual(['pending', 'sending'])

    await push.register(fixture.bobUserId, 70)

    expect(await push.deliveries()).toEqual([])
    expect(await push.subscriptions()).toMatchObject([{ user_id: fixture.bobUserId, push_endpoint: endpoint(70) }])
    const ask = (userId: string) =>
      database.asUser<{ r: boolean }>(userId, 'select public.push_device_registered($1) as r', [endpoint(70)])
    expect(await ask(fixture.aliceUserId)).toEqual([{ r: false }])
    expect(await ask(fixture.bobUserId)).toEqual([{ r: true }])
  })

  it('keeps the finished history of the last account, and nothing pending', async () => {
    await push.register(fixture.aliceUserId, 71)
    await push.appointment()
    await push.run('appointments')
    const [row] = await push.claim()
    await push.complete(row!.delivery_id, 'sent', { status: 201 })

    await push.register(fixture.bobUserId, 71)
    expect(await push.deliveries()).toMatchObject([{ delivery_status: 'sent' }])
  })

  it('the transferred device counts as newly registered', async () => {
    await push.register(fixture.aliceUserId, 72)
    await database.asService(`update app_private.push_subscription set push_registered_at = now() - interval '2 years'`)
    await push.register(fixture.bobUserId, 72)
    const [row] = await database.asService<{ age: number }>(
      `select extract(epoch from now() - push_registered_at)::int as age from app_private.push_subscription`,
    )
    expect(row!.age).toBeLessThan(60)
  })

  it('the ten-device limit never removes the device just transferred, however old it is', async () => {
    for (let n = 100; n < 110; n++) await push.register(fixture.bobUserId, n)
    await push.register(fixture.aliceUserId, 99)
    await database.asService(
      `update app_private.push_subscription set push_registered_at = now() - interval '2 years' where push_endpoint = $1`,
      [endpoint(99)],
    )

    await push.register(fixture.bobUserId, 99)

    const bobs = (await push.subscriptions()).filter((row) => row.user_id === fixture.bobUserId)
    expect(bobs).toHaveLength(10)
    expect(bobs.map((row) => row.push_endpoint)).toContain(endpoint(99))
    // The one forgotten is Bob's least recently registered other device.
    expect(bobs.map((row) => row.push_endpoint)).not.toContain(endpoint(100))
  })

  it('re-registering the same device keeps one row and refreshes it', async () => {
    await push.register(fixture.aliceUserId, 73)
    const [before] = await push.subscriptions()
    await push.register(fixture.aliceUserId, 73)
    const after = await push.subscriptions()
    expect(after).toHaveLength(1)
    expect(after[0]!.subscription_id).toBe(before!.subscription_id)
  })

  it('removing a device removes what was queued on it', async () => {
    await push.register(fixture.aliceUserId, 74)
    await push.appointment()
    await push.run('appointments')
    await database.asUser(fixture.aliceUserId, 'select public.unregister_push_subscription($1)', [endpoint(74)])
    expect(await push.deliveries()).toEqual([])
    expect(await push.claim()).toEqual([])
  })
})

describe('two registrations of one phone at the same moment', () => {
  // PGlite has one connection, so "at the same moment" is a transaction left
  // open as a prepared one - it goes on holding its locks, as an overlapping
  // session would - while a second transaction runs (the pattern of
  // tests/db/medication-dose-identity.test.ts). A statement that would wait
  // on those locks never returns here, so the second session asks with
  // NOWAIT: being refused is the proof that it would have had to wait.
  let racing: TestDatabase
  let fx: Fixture
  let api: ReturnType<typeof pushApi>

  beforeAll(async () => {
    racing = await createTestDatabase({ preparedTransactions: true })
    fx = await seedFixture(racing)
    api = pushApi(racing, () => fx)
  }, 120_000)

  afterAll(async () => {
    await racing?.close()
  })

  async function leftOpen(name: string, userId: string, n: number) {
    const db = racing.db
    await db.exec('begin')
    try {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })])
      await db.exec('set local role authenticated')
      await db.query('select public.register_push_subscription($1, $2, $3)', [endpoint(n), P256DH, AUTH])
      await db.exec('reset role')
    } catch (error) {
      await db.exec('rollback')
      throw error
    }
    await db.exec(`prepare transaction '${name}'`)
  }

  const lockedElsewhere = async (n: number) => {
    try {
      await racing.asService(
        'select 1 from app_private.push_subscription where push_endpoint = $1 for update nowait',
        [endpoint(n)],
      )
      return false
    } catch (error) {
      expect(String(error)).toMatch(/could not obtain lock/)
      return true
    }
  }

  it('a transfer holds the device\u2019s row until it commits, so a second registration must wait for it', async () => {
    await api.register(fx.aliceUserId, 80)
    await api.appointment()
    await api.run('appointments')
    expect(await lockedElsewhere(80)).toBe(false)

    await leftOpen('transfer', fx.bobUserId, 80)

    // Bob's transfer is in flight. Everyone else still sees Alice's device,
    // whole: never a half-moved row, never two rows.
    expect(await lockedElsewhere(80)).toBe(true)
    expect(await api.subscriptions()).toMatchObject([{ user_id: fx.aliceUserId }])
    expect(await api.deliveries()).toHaveLength(1)

    await racing.db.exec(`commit prepared 'transfer'`)

    expect(await lockedElsewhere(80)).toBe(false)
    expect(await api.subscriptions()).toMatchObject([{ user_id: fx.bobUserId, push_endpoint: endpoint(80) }])
    // Alice's queued push went with the transfer, in the same transaction.
    expect(await api.deliveries()).toEqual([])
  })

  it('a transfer that is abandoned leaves the device exactly as it was', async () => {
    await api.reset()
    await api.register(fx.aliceUserId, 81)
    await api.appointment()
    await api.run('appointments')
    await leftOpen('abandoned', fx.bobUserId, 81)
    await racing.db.exec(`rollback prepared 'abandoned'`)

    expect(await api.subscriptions()).toMatchObject([{ user_id: fx.aliceUserId }])
    expect(await api.deliveries()).toHaveLength(1)
    expect((await api.claim()).map((row) => row.push_endpoint)).toEqual([endpoint(81)])
  })

  it('the registration that commits last owns the device: one row, and only its own pushes', async () => {
    await api.reset()
    await api.register(fx.aliceUserId, 82)
    await leftOpen('bob', fx.bobUserId, 82)
    await racing.db.exec(`commit prepared 'bob'`)
    // Alice's registration, which had to wait for Bob's, now runs.
    await api.register(fx.aliceUserId, 82)

    expect(await api.subscriptions()).toMatchObject([{ user_id: fx.aliceUserId, push_endpoint: endpoint(82) }])
    await api.appointment()
    await api.run('appointments')
    expect((await api.claim()).map((row) => row.push_endpoint)).toEqual([endpoint(82)])
  })

  it('the endpoint is unique, whoever writes it', async () => {
    await api.reset()
    await api.register(fx.aliceUserId, 83)
    await expect(
      racing.asService(
        `insert into app_private.push_subscription (user_id, push_endpoint, push_p256dh, push_auth)
         values ($1, $2, $3, $4)`,
        [fx.bobUserId, endpoint(83), P256DH, AUTH],
      ),
    ).rejects.toThrow(/push_subscription_endpoint_unique/)
  })

  it('a delivery being claimed is not claimed by an overlapping run', async () => {
    await api.reset()
    await api.register(fx.aliceUserId, 84)
    await api.appointment()
    await api.run('appointments')

    await racing.db.exec('begin')
    await racing.db.query('select * from public.claim_push_deliveries(10)')
    await racing.db.exec(`prepare transaction 'claiming'`)

    // The first run has the row locked and not yet committed: SKIP LOCKED
    // passes over it rather than taking it a second time.
    expect(await api.claim()).toEqual([])
    await racing.db.exec(`commit prepared 'claiming'`)
    expect(await api.deliveries()).toMatchObject([{ delivery_status: 'sending', attempt_count: 1 }])
  })
})

// ===========================================================================
// Rollback, and applying it again
// ===========================================================================

describe('rollback and reapply', () => {
  let scratch: TestDatabase
  let before53: TestDatabase
  let seeded: Fixture

  beforeAll(async () => {
    ;[scratch, before53] = await Promise.all([
      // Through 53 only, so a later migration is not part of what is rolled
      // back and compared.
      createTestDatabase({ stopAfter: MIGRATION_53 }),
      createTestDatabase({ stopAfter: '20260902100048' }),
    ])
    seeded = await seedFixture(scratch)
  }, 180_000)

  afterAll(async () => {
    await Promise.all([scratch?.close(), before53?.close()])
  })

  const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')
  const messages = () =>
    scratch.asService<{ notification_message: string }>(
      'select notification_message from public.notification order by notification_created_at, notification_message',
    )

  it('refuses to apply twice', async () => {
    await expect(scratch.applyMigration(MIGRATION_53)).rejects.toThrow(/already been applied/)
  })

  it('rollback returns the schema to exactly what migration 48 left, and keeps every notification', async () => {
    const api = pushApi(scratch, () => seeded)
    await api.register(seeded.aliceUserId, 90)
    const id = await api.appointment()
    await api.run('appointments')
    await api.cancel(id)
    const stored = await messages()
    expect(stored.length).toBe(4) // The reminder and the cancellation, for patient and doctor.
    const full = await catalog(scratch)

    await scratch.db.exec(await script(ROLLBACK_53))

    expect(await catalog(scratch)).toEqual(await catalog(before53))
    expect(await messages()).toEqual(stored)
    const [left] = await scratch.asService<{ n: number }>(
      `select (to_regclass('app_private.push_subscription') is not null)::int
            + (to_regclass('app_private.push_delivery') is not null)::int
            + (select count(*)::int from pg_trigger where tgname = 'notification_enqueue_push')
            + (select count(*)::int from information_schema.columns
                where table_schema = 'public' and table_name = 'notification'
                  and column_name like 'notification_source%') as n`,
    )
    expect(left!.n).toBe(0)

    // The reminder jobs and the cancellation notice work as before 53.
    const again = await api.appointment()
    await api.run('appointments')
    await api.cancel(again)
    expect((await messages()).length).toBe(8)

    await expect(scratch.db.exec(await script(ROLLBACK_53))).rejects.toThrow(/Migration 53 is not applied/)

    // Applied again, it is the same schema as a first application, and works.
    await scratch.applyMigration(MIGRATION_53)
    expect(await catalog(scratch)).toEqual(full)
    expect((await messages()).length).toBe(8)
    await api.register(seeded.aliceUserId, 91)
    await api.appointment()
    await api.run('appointments')
    expect((await api.claim()).map((row) => row.push_kind)).toEqual(['appointment_reminder'])
  }, 120_000)
})
