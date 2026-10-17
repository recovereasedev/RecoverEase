import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 31: settings and time belong to the clinic (decision D3).
 *
 *   - the settings that exist become the one clinic's, untouched;
 *   - two clinics in zones 25 hours apart each get their own "today", dose
 *     slots, missed-dose cut-off, reminders, notices and date checks;
 *   - a Clinic Admin reads and writes only their clinic's settings and zone;
 *   - the settings screen deployed before 31 keeps working;
 *   - an announcement keeps its author and clinic.
 *
 * Production keeps the single-clinic gate; the two-clinic suites lift it in
 * their own database only (helpers/clinics.ts).
 */

const BEFORE_31 = '20260902100030'
/**
 * The last migration before the single-clinic gate and the key-only settings
 * index are dropped (migration 34). The release-window suites below describe
 * the screen deployed before 31, whose key-only upsert needs that index.
 */
const BEFORE_GATE_LIFT = '20260902100033'
const MIGRATION_31 = '20260902100031'
const REFUSED = { code: '42501' }

async function account(database: TestDatabase, email: string, role: 'patient' | 'doctor' | 'admin') {
  const [user] = await database.asService<{ id: string }>(
    'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
    [email],
  )
  await database.asService(
    'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
    [user!.id, email, role],
  )
  return user!.id
}

const value = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

describe('migration 31 on settings that already exist', () => {
  let database: TestDatabase
  let fx: Fixture
  let before: Record<string, unknown>[]
  let countsBefore: Record<string, number>

  const SETTINGS = 'select system_setting_id, admin_id, system_setting_key, system_setting_value, system_setting_updated_at::text as updated from public.system_setting order by 1'
  /** Every public table's row count. */
  const counts = async () => {
    const tables = await database.asService<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`,
    )
    const result: Record<string, number> = {}
    for (const { relname } of tables) {
      result[relname] = await value<number>(database, `select count(*)::int from public.${relname}`)
    }
    return result
  }

  beforeAll(async () => {
    database = await createTestDatabase({ stopAfter: BEFORE_31 })
    fx = await seedFixture(database)
    // As in production: the three settings an administrator wrote.
    await database.asService(
      `insert into public.system_setting (admin_id, system_setting_key, system_setting_value) values
         ($1, 'app.timezone', 'Asia/Manila'),
         ($1, 'chatbot.system_prompt', 'Support patients recovering after treatment.'),
         ($1, 'medication.reminder_grace_hours', '6')`,
      [fx.adminId],
    )
    before = await database.asService(SETTINGS)
    countsBefore = await counts()
    await database.applyMigration(MIGRATION_31)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('gives every setting the clinic, and changes no id, key, value, author or time', async () => {
    expect(await database.asService(SETTINGS)).toEqual(before)
    expect(
      await database.asService(
        `select count(*)::int as n from public.system_setting
          where clinic_id is distinct from (select clinic_id from public.clinic)`,
      ),
    ).toEqual([{ n: 0 }])
    expect(
      await database.asService(
        `select is_nullable from information_schema.columns
          where table_name = 'system_setting' and column_name = 'clinic_id'`,
      ),
    ).toEqual([{ is_nullable: 'NO' }])
  })

  it('writes no audit entry and changes no row count', async () => {
    expect(await counts()).toEqual(countsBefore)
  })

  it('keeps the single-clinic gate and the key-only settings index the deployed screen uses', async () => {
    const indexes = await database.asService<{ indexname: string }>(
      `select indexname from pg_indexes
        where indexname in ('clinic_single_clinic_gate', 'system_setting_key_unique', 'system_setting_clinic_key_unique')
        order by 1`,
    )
    expect(indexes.map((row) => row.indexname)).toEqual([
      'clinic_single_clinic_gate',
      'system_setting_clinic_key_unique',
      'system_setting_key_unique',
    ])
    await expect(
      database.asService(`insert into public.clinic (clinic_name, clinic_timezone) values ('Second', 'UTC')`),
    ).rejects.toThrow(/clinic_single_clinic_gate/)
  })

  it('answers "today" in the clinic’s zone, as the setting did', async () => {
    expect(await value(database, 'select public.app_today()::text')).toBe(
      await value(database, `select (now() at time zone 'Asia/Manila')::date::text`),
    )
  })

  it('refuses, changing nothing, when the time zone setting and the clinic disagree', async () => {
    const other = await createTestDatabase({ stopAfter: BEFORE_31 })
    try {
      await other.asService(
        `insert into public.system_setting (system_setting_key, system_setting_value) values ('app.timezone', 'Asia/Tokyo')`,
      )
      await expect(other.applyMigration(MIGRATION_31)).rejects.toThrow(/time zone setting \(Asia\/Tokyo\).*differ/)
      expect(
        await other.asService(
          `select count(*)::int as n from information_schema.columns
            where table_name = 'system_setting' and column_name = 'clinic_id'`,
        ),
      ).toEqual([{ n: 0 }])
    } finally {
      await other.close()
    }
  })

  it('runs only after 30, and only once', async () => {
    await expect(database.applyMigration(MIGRATION_31)).rejects.toThrow(/already been applied/)

    const early = await createTestDatabase({ stopAfter: '20260902100029' })
    try {
      await expect(early.applyMigration(MIGRATION_31)).rejects.toThrow(/needs migration 30 first/)
    } finally {
      await early.close()
    }
  })
})

/** One clinic's people and a course of medication, in its own zone. */
type Site = {
  clinicId: string
  zone: string
  adminUserId: string
  adminId: string
  doctorUserId: string
  doctorId: string
  patientUserId: string
  patientId: string
  prescriptionId: string
  scheduleId: string
}

async function site(database: TestDatabase, clinicId: string, zone: string, tag: string): Promise<Site> {
  await database.asService('update public.clinic set clinic_timezone = $2 where clinic_id = $1', [clinicId, zone])
  const today = await value<string>(database, 'select app_private.clinic_today($1)::text', [clinicId])

  const adminUserId = await account(database, `admin@${tag}.test`, 'admin')
  const adminId = await value<string>(
    database,
    `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
     values ($1, 'Admin', $2, $3) returning admin_id`,
    [adminUserId, tag, clinicId],
  )
  const doctorUserId = await account(database, `doctor@${tag}.test`, 'doctor')
  const doctorId = await value<string>(
    database,
    `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
     values ($1, 'Doc', $2, $3, $4) returning doc_id`,
    [doctorUserId, tag, `LIC-${tag}`, clinicId],
  )
  const patientUserId = await account(database, `patient@${tag}.test`, 'patient')
  const patientId = await value<string>(
    database,
    `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
     values ($1, $2, 'Pat', $3, now()) returning pat_id`,
    [patientUserId, doctorId, tag],
  )
  // With two clinics a server-side insert gives its dates: app_today()'s
  // default would have to guess whose day it is.
  const prescriptionId = await value<string>(
    database,
    `insert into public.prescription (pat_id, doc_id, prescription_issued_date)
     values ($1, $2, $3::date) returning prescription_id`,
    [patientId, doctorId, today],
  )
  const scheduleId = await value<string>(
    database,
    `insert into public.medication_schedule
       (prescription_id, medication_schedule_name, medication_schedule_dosage,
        medication_schedule_frequency, medication_schedule_times, medication_schedule_start_date)
     values ($1, 'Paracetamol', '500mg', 1, '{08:00}'::time[], $2::date)
     returning medication_schedule_id`,
    [prescriptionId, today],
  )

  return { clinicId, zone, adminUserId, adminId, doctorUserId, doctorId, patientUserId, patientId, prescriptionId, scheduleId }
}

describe('two clinics, two time zones', () => {
  let database: TestDatabase
  // UTC+14 and UTC-11: 25 hours apart, so their dates always differ.
  let east: Site
  let west: Site

  beforeAll(async () => {
    database = await createTestDatabase()
    const harborview = await value<string>(database, 'select clinic_id from public.clinic')
    await liftSingleClinicGate(database)
    const second = await addClinic(database, 'Synthetic Western Clinic', 'Pacific/Pago_Pago')
    east = await site(database, harborview, 'Pacific/Kiritimati', 'east')
    west = await site(database, second, 'Pacific/Pago_Pago', 'west')
  })

  afterAll(async () => {
    await database?.close()
  })

  const localToday = (s: Site) => value<string>(database, 'select app_private.clinic_today($1)::text', [s.clinicId])
  const localDateOf = (s: Site, sql: string) =>
    value<string>(database, `select ((${sql}) at time zone $1)::date::text`, [s.zone])

  describe('"today"', () => {
    it('is each member’s own clinic’s', async () => {
      const eastToday = await localToday(east)
      const westToday = await localToday(west)
      expect(eastToday).not.toBe(westToday)
      for (const [s, today] of [[east, eastToday], [west, westToday]] as const) {
        for (const userId of [s.adminUserId, s.doctorUserId, s.patientUserId]) {
          expect(await database.asUser(userId, 'select public.app_today()::text as d')).toEqual([{ d: today }])
        }
        expect(await localDateOf(s, 'now()')).toBe(today)
      }
    })

    it('is refused, rather than guessed, to a caller with no clinic once there are two', async () => {
      await expect(database.asService('select public.app_today()')).rejects.toThrow(/With 2 clinics/)
    })
  })

  describe('doses', () => {
    it('are generated at the prescribed wall-clock time in each patient’s clinic', async () => {
      for (const s of [east, west]) {
        const slots = await database.asService<{ local: string; day: string }>(
          `select to_char(medication_log_scheduled_at at time zone $2, 'HH24:MI') as local,
                  (medication_log_scheduled_at at time zone $2)::date::text as day
             from public.medication_log where medication_schedule_id = $1
            order by medication_log_scheduled_at`,
          [s.scheduleId, s.zone],
        )
        expect(slots.length).toBeGreaterThan(28)
        expect(new Set(slots.map((slot) => slot.local))).toEqual(new Set(['08:00']))
        expect(slots[0]!.day).toBe(await localToday(s))
      }
    })

    it('are extended by the nightly job in each clinic’s zone', async () => {
      await database.asService(
        `delete from public.medication_log where medication_schedule_id = any ($1::uuid[]) and medication_log_status = 'pending'`,
        [[east.scheduleId, west.scheduleId]],
      )
      expect(await value<number>(database, 'select public.extend_all_medication_log_slots(5)')).toBeGreaterThan(0)
      for (const s of [east, west]) {
        const locals = await database.asService<{ local: string }>(
          `select distinct to_char(medication_log_scheduled_at at time zone $2, 'HH24:MI') as local
             from public.medication_log where medication_schedule_id = $1`,
          [s.scheduleId, s.zone],
        )
        expect(locals).toEqual([{ local: '08:00' }])
      }
    })

    it('are marked missed after each clinic’s own grace period', async () => {
      await database.asService(
        `insert into public.system_setting (clinic_id, system_setting_key, system_setting_value) values
           ($1, 'medication.reminder_grace_hours', '2'),
           ($2, 'medication.reminder_grace_hours', '10')`,
        [east.clinicId, west.clinicId],
      )
      const dose = (s: Site) =>
        value<string>(
          database,
          `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
           values ($1, now() - interval '5 hours') returning medication_log_id`,
          [s.scheduleId],
        )
      const eastDose = await dose(east)
      const westDose = await dose(west)

      await database.asService('select public.mark_overdue_medication_logs(6)')

      const status = (id: string) =>
        value<string>(database, 'select medication_log_status::text from public.medication_log where medication_log_id = $1', [id])
      // Five hours late: past the eastern clinic's two, inside the western's ten.
      expect(await status(eastDose)).toBe('missed')
      expect(await status(westDose)).toBe('pending')
    })

    it('are chased with the due time in each patient’s clinic, from the hour each clinic’s clock has reached', async () => {
      await database.asService(
        `update public.medication_log set medication_log_follow_up_sent_at = now()
          where medication_log_follow_up_sent_at is null`,
      )
      const dueAt = await value<string>(database, `select (now() - interval '2 hours')::text`)
      for (const s of [east, west]) {
        await database.asService(
          `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at) values ($1, $2::timestamptz)`,
          [s.scheduleId, dueAt],
        )
      }
      // East has reached its preferred hour; west has not. Each is measured
      // on its own clinic's clock.
      await database.asService(
        `update public.patient set pat_reminder_preferred_time =
           case when (now() at time zone $2)::time >= time '01:00'
                then ((now() at time zone $2)::time - interval '30 minutes')
                else time '00:00' end
          where pat_id = $1`,
        [east.patientId, east.zone],
      )
      await database.asService(
        `update public.patient set pat_reminder_preferred_time =
           case when (now() at time zone $2)::time <= time '23:00'
                then ((now() at time zone $2)::time + interval '30 minutes')
                else time '23:59:59' end
          where pat_id = $1`,
        [west.patientId, west.zone],
      )

      expect(await value<number>(database, 'select public.dispatch_medication_reminders(30)')).toBe(1)

      const expected = await value<string>(database, `select to_char($1::timestamptz at time zone $2, 'HH24:MI')`, [dueAt, east.zone])
      expect(
        await database.asService(
          `select notification_message as m from public.notification where user_id = $1 and notification_type = 'medication'`,
          [east.patientUserId],
        ),
      ).toEqual([{ m: `Have you taken your Paracetamol (500mg)? It was due at ${expected}.` }])
      expect(
        await database.asService(`select 1 from public.notification where user_id = $1 and notification_type = 'medication'`, [
          west.patientUserId,
        ]),
      ).toEqual([])
    })

    it('stop after each course’s end date in its own clinic', async () => {
      const westToday = await localToday(west)
      // Late tomorrow in the west is the day after in Manila, and in the
      // east: compared in the wrong zone this dose would be dropped.
      const keep = await value<string>(
        database,
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         values ($1, (($2::date + 1) + time '22:00') at time zone $3) returning medication_log_id`,
        [west.scheduleId, westToday, west.zone],
      )
      const drop = await value<string>(
        database,
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         values ($1, (($2::date + 2) + time '01:00') at time zone $3) returning medication_log_id`,
        [west.scheduleId, westToday, west.zone],
      )

      await database.asService(
        `update public.medication_schedule set medication_schedule_end_date = $2::date + 1 where medication_schedule_id = $1`,
        [west.scheduleId, westToday],
      )

      const remaining = await database.asService<{ id: string }>(
        `select medication_log_id as id from public.medication_log where medication_log_id = any ($1::uuid[])`,
        [[keep, drop]],
      )
      expect(remaining).toEqual([{ id: keep }])
      expect(
        await database.asService(
          `select 1 from public.medication_log
            where medication_schedule_id = $1 and medication_log_status = 'pending'
              and medication_log_scheduled_at > now()
              and (medication_log_scheduled_at at time zone $2)::date > $3::date + 1`,
          [west.scheduleId, west.zone, westToday],
        ),
      ).toEqual([])
    })
  })

  describe('appointments', () => {
    let instant: string

    beforeAll(async () => {
      instant = await value<string>(database, `select date_trunc('minute', now() + interval '3 hours')::text`)
    })

    const book = (s: Site) =>
      value<string>(
        database,
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, $3::timestamptz) returning appointment_id`,
        [s.patientId, s.doctorId, instant],
      )
    const when = async (s: Site) => ({
      day: await value<string>(database, `select to_char($1::timestamptz at time zone $2, 'FMDay, FMDD FMMonth')`, [instant, s.zone]),
      time: await value<string>(database, `select to_char($1::timestamptz at time zone $2, 'HH24:MI')`, [instant, s.zone]),
    })
    const appointmentMessages = (userId: string) =>
      database.asService<{ m: string }>(
        `select notification_message as m from public.notification
          where user_id = $1 and notification_type = 'appointment' order by notification_created_at, notification_message`,
        [userId],
      )

    it('are reminded with the date and time in each clinic’s zone', async () => {
      await book(east)
      await book(west)
      expect(await value<number>(database, 'select public.dispatch_appointment_reminders(24)')).toBe(4)

      for (const s of [east, west]) {
        const { day, time } = await when(s)
        expect(await appointmentMessages(s.patientUserId)).toEqual([
          { m: `You have an upcoming appointment on ${day} at ${time}.` },
        ])
        expect(await appointmentMessages(s.doctorUserId)).toEqual([
          { m: `Upcoming appointment with Pat ${s === east ? 'east' : 'west'} on ${day} at ${time}.` },
        ])
      }
      // The same instant, a day apart on the two clinics' calendars.
      expect((await when(east)).day).not.toBe((await when(west)).day)
    })

    it('are cancelled with the date and time in the clinic’s zone', async () => {
      await database.asService('delete from public.notification')
      await database.asService(
        `update public.appointment set appointment_status = 'cancelled' where pat_id = $1`,
        [west.patientId],
      )
      const { day, time } = await when(west)
      expect(await appointmentMessages(west.patientUserId)).toEqual([
        { m: `Your appointment on ${day} at ${time} has been cancelled.` },
      ])
    })
  })

  describe('dates a person enters', () => {
    it('cannot be after their own clinic’s today', async () => {
      const eastToday = await localToday(east)
      const westToday = await localToday(west)

      const log = (s: Site, day: string) =>
        database.asUser(
          s.patientUserId,
          `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating)
           values ($1, $2::date, 3) returning recovery_log_id`,
          [s.patientId, day],
        )
      // The east's today is already the west's tomorrow.
      await expect(log(east, eastToday)).resolves.toHaveLength(1)
      await expect(log(west, westToday)).resolves.toHaveLength(1)
      await expect(log(west, eastToday)).rejects.toThrow(/cannot be dated in the future/)

      const born = (s: Site, day: string) =>
        database.asService('update public.patient set pat_birth_date = $2::date where pat_id = $1', [s.patientId, day])
      await expect(born(east, eastToday)).resolves.toBeDefined()
      await expect(born(west, eastToday)).rejects.toThrow(/cannot be in the future/)
      await expect(born(west, westToday)).resolves.toBeDefined()
    })
  })

  describe('settings', () => {
    it('are each Clinic Admin’s own clinic’s, whatever the request says', async () => {
      await database.asUser(
        east.adminUserId,
        `insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
         values ($1, 'chatbot.system_prompt', 'East guidance')`,
        [west.clinicId],
      )
      await database.asUser(
        west.adminUserId,
        `insert into public.system_setting (system_setting_key, system_setting_value)
         values ('chatbot.system_prompt', 'West guidance')`,
      )

      const prompts = await database.asService<{ clinic_id: string; v: string }>(
        `select clinic_id, system_setting_value as v from public.system_setting
          where system_setting_key = 'chatbot.system_prompt' order by 2`,
      )
      expect(prompts).toEqual([
        { clinic_id: east.clinicId, v: 'East guidance' },
        { clinic_id: west.clinicId, v: 'West guidance' },
      ])

      for (const [s, own] of [[east, 'East guidance'], [west, 'West guidance']] as const) {
        const seen = await database.asUser<{ k: string; v: string }>(
          s.adminUserId,
          'select system_setting_key as k, system_setting_value as v from public.system_setting order by 1',
        )
        expect(seen).toContainEqual({ k: 'chatbot.system_prompt', v: own })
        expect(seen.map((row) => row.v)).not.toContain(own === 'East guidance' ? 'West guidance' : 'East guidance')
      }
    })

    it('cannot be changed, or moved, across clinics', async () => {
      const westPrompt = await value<string>(
        database,
        `select system_setting_id from public.system_setting where clinic_id = $1 and system_setting_key = 'chatbot.system_prompt'`,
        [west.clinicId],
      )
      await expectDenied(() =>
        database.asUser(
          east.adminUserId,
          `update public.system_setting set system_setting_value = 'Hijacked' where system_setting_id = $1 returning 1`,
          [westPrompt],
        ),
      )
      // An update by key reaches the caller's own row only.
      expect(
        await database.asUser(
          east.adminUserId,
          `update public.system_setting set system_setting_value = 'East guidance, revised'
            where system_setting_key = 'chatbot.system_prompt' returning clinic_id`,
        ),
      ).toEqual([{ clinic_id: east.clinicId }])
      await expect(
        database.asUser(
          east.adminUserId,
          `update public.system_setting set clinic_id = $1 where system_setting_key = 'chatbot.system_prompt'`,
          [west.clinicId],
        ),
      ).rejects.toThrow(/stays with the clinic/)
      expect(
        await value<string>(database, 'select system_setting_value from public.system_setting where system_setting_id = $1', [westPrompt]),
      ).toBe('West guidance')
    })

    it('need a named clinic from a server-side write once there are two', async () => {
      await expect(
        database.asService(
          `insert into public.system_setting (system_setting_key, system_setting_value) values ('chatbot.system_prompt', 'Whose?')`,
        ),
      ).rejects.toThrow(/needs a clinic/)
    })

    it('are still out of reach of doctors and patients', async () => {
      for (const userId of [east.doctorUserId, east.patientUserId, west.doctorUserId, west.patientUserId]) {
        expect(await database.asUser(userId, 'select system_setting_id from public.system_setting')).toEqual([])
        await expect(
          database.asUser(userId, `insert into public.system_setting (system_setting_key, system_setting_value) values ('x', 'y')`),
        ).rejects.toThrow(/row-level security/)
      }
    })
  })

  describe('the time zone', () => {
    const setZone = (userId: string, zone: string) =>
      database.asUser<{ z: string }>(userId, 'select public.admin_set_clinic_timezone($1) as z', [zone])
    const zoneOf = (s: Site) => value<string>(database, 'select clinic_timezone from public.clinic where clinic_id = $1', [s.clinicId])

    it('is set by the Clinic Admin for their own clinic only, and audited where they can read it', async () => {
      expect(await setZone(east.adminUserId, ' Asia/Tokyo ')).toEqual([{ z: 'Asia/Tokyo' }])
      expect(await zoneOf(east)).toBe('Asia/Tokyo')
      expect(await zoneOf(west)).toBe('Pacific/Pago_Pago')

      const entry = { entity: 'clinic_settings', scope: 'administration' }
      const [audit] = await database.asUser<{ entity: string; scope: string; details: unknown }>(
        east.adminUserId,
        `select audit_log_entity as entity, audit_scope::text as scope, audit_log_details as details
           from public.audit_log where audit_log_entity = 'clinic_settings'`,
      )
      expect(audit).toEqual({
        ...entry,
        details: {
          changed_columns: ['clinic_timezone'],
          before: { clinic_timezone: 'Pacific/Kiritimati' },
          after: { clinic_timezone: 'Asia/Tokyo' },
        },
      })
      expect(
        await database.asUser(west.adminUserId, `select 1 from public.audit_log where audit_log_entity = 'clinic_settings'`),
      ).toEqual([])
      // Unchanged: nothing more to record.
      await setZone(east.adminUserId, 'Asia/Tokyo')
      expect(await value<number>(database, `select count(*)::int from public.audit_log where audit_log_entity = 'clinic_settings'`)).toBe(1)
      await setZone(east.adminUserId, 'Pacific/Kiritimati')
    })

    it('must be a real zone', async () => {
      await expect(setZone(east.adminUserId, 'Mars/Olympus_Mons')).rejects.toThrow(/Unknown time zone/)
      await expect(setZone(east.adminUserId, '   ')).rejects.toThrow(/Enter a time zone/)
      expect(await zoneOf(east)).toBe('Pacific/Kiritimati')
    })

    it('is refused to doctors, patients and anonymous callers', async () => {
      for (const userId of [east.doctorUserId, east.patientUserId]) {
        await expect(setZone(userId, 'UTC')).rejects.toMatchObject(REFUSED)
      }
      await expect(database.asAnon(`select public.admin_set_clinic_timezone('UTC')`)).rejects.toThrow(/permission denied/)
      expect(await zoneOf(east)).toBe('Pacific/Kiritimati')
    })
  })

  describe('announcements', () => {
    it('keep the author and clinic they were written with', async () => {
      const colleagueUserId = await account(database, 'colleague@east.test', 'admin')
      const colleagueId = await value<string>(
        database,
        `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
         values ($1, 'Col', 'League', $2) returning admin_id`,
        [colleagueUserId, east.clinicId],
      )
      const [posted] = await database.asUser<{ id: string; clinic_id: string }>(
        east.adminUserId,
        `insert into public.announcement (admin_id, announcement_title, announcement_content, clinic_id)
         values ($1, 'Hours', 'Open 8 to 5', $2) returning announcement_id as id, clinic_id`,
        [east.adminId, west.clinicId],
      )
      expect(posted!.clinic_id).toBe(east.clinicId)

      // Publishing, editing and deleting work as before.
      expect(
        await database.asUser(
          colleagueUserId,
          `update public.announcement set announcement_published_at = now(), announcement_title = 'Opening hours'
            where announcement_id = $1 returning announcement_id`,
          [posted!.id],
        ),
      ).toHaveLength(1)

      // Neither the author nor the clinic can change - not even to a
      // colleague in the same clinic, and not with the service key.
      await expect(
        database.asUser(colleagueUserId, 'update public.announcement set admin_id = $2 where announcement_id = $1', [
          posted!.id,
          colleagueId,
        ]),
      ).rejects.toThrow(/keeps the author and clinic/)
      await expect(
        database.asService('update public.announcement set clinic_id = $2 where announcement_id = $1', [posted!.id, west.clinicId]),
      ).rejects.toThrow(/keeps the author and clinic/)
      expect(
        await database.asService('select admin_id, clinic_id from public.announcement where announcement_id = $1', [posted!.id]),
      ).toEqual([{ admin_id: east.adminId, clinic_id: east.clinicId }])

      expect(
        await database.asUser(east.adminUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [posted!.id]),
      ).toHaveLength(1)
    })
  })
})

describe('the settings screen deployed before migration 31, during the release', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase({ stopAfter: BEFORE_GATE_LIFT })
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  // What the deployed screen sends: an upsert on the key alone.
  const oldSave = (key: string, settingValue: string) =>
    database.asUser(
      fx.adminUserId,
      `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
       values ($1, $2, $3)
       on conflict (system_setting_key) do update
         set admin_id = excluded.admin_id, system_setting_value = excluded.system_setting_value
       returning clinic_id, system_setting_value`,
      [fx.adminId, key, settingValue],
    )
  const clinicZone = () => value<string>(database, 'select clinic_timezone from public.clinic')

  it('still saves a setting, now its clinic’s', async () => {
    const clinic = await value<string>(database, 'select clinic_id from public.clinic')
    expect(await oldSave('medication.reminder_grace_hours', '4')).toEqual([{ clinic_id: clinic, system_setting_value: '4' }])
    expect(await oldSave('medication.reminder_grace_hours', '5')).toEqual([{ clinic_id: clinic, system_setting_value: '5' }])
  })

  it('still sets the time zone, which reaches the clinic and everything worked out in it', async () => {
    expect(await oldSave('app.timezone', ' Asia/Singapore ')).toEqual([
      { clinic_id: expect.any(String), system_setting_value: 'Asia/Singapore' },
    ])
    expect(await clinicZone()).toBe('Asia/Singapore')
    expect(await database.asUser(fx.doctorAUserId, 'select public.app_today()::text as d')).toEqual([
      { d: await value<string>(database, `select (now() at time zone 'Asia/Singapore')::date::text`) },
    ])
  })

  it('cannot set a zone that does not exist, and then nothing changes', async () => {
    await expect(oldSave('app.timezone', 'Nowhere/Atlantis')).rejects.toThrow(/Unknown time zone/)
    expect(await clinicZone()).toBe('Asia/Singapore')
    expect(
      await value<string>(database, `select system_setting_value from public.system_setting where system_setting_key = 'app.timezone'`),
    ).toBe('Asia/Singapore')
  })

  it('shows the zone the new screen sets, which keeps the old row in step', async () => {
    await database.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Manila')`)
    expect(await clinicZone()).toBe('Asia/Manila')
    expect(
      await database.asUser(fx.adminUserId, `select system_setting_value as v from public.system_setting where system_setting_key = 'app.timezone'`),
    ).toEqual([{ v: 'Asia/Manila' }])
  })

  it('and the new screen saves by clinic and key', async () => {
    expect(
      await database.asUser(
        fx.adminUserId,
        `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
         values ($1, 'chatbot.system_prompt', 'Guidance')
         on conflict (clinic_id, system_setting_key) do update
           set admin_id = excluded.admin_id, system_setting_value = excluded.system_setting_value
         returning system_setting_value`,
        [fx.adminId],
      ),
    ).toEqual([{ system_setting_value: 'Guidance' }])
  })
})

/**
 * The `app.timezone` alias passes a zone on to the clinic only when the row
 * is really written. PostgreSQL runs BEFORE INSERT triggers for every row an
 * INSERT proposes, including one that ON CONFLICT DO NOTHING then skips, so
 * the pass-through runs after the write (migration 31's
 * system_setting_sync_clinic_timezone), never before it.
 */
describe('the app.timezone alias reaches the clinic only when it is written', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase({ stopAfter: BEFORE_GATE_LIFT })
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const clinicZone = () => value<string>(database, 'select clinic_timezone from public.clinic')
  const aliasRows = () =>
    database.asService<{ v: string }>(
      `select system_setting_value as v from public.system_setting where system_setting_key = 'app.timezone'`,
    )
  const auditCount = (entity: string, action: string) =>
    value<number>(
      database,
      'select count(*)::int from public.audit_log where audit_log_entity = $1 and audit_log_action = $2',
      [entity, action],
    )
  // The two ON CONFLICT targets a writer could name: the key the deployed
  // screen upserts on, and the clinic and key.
  const doNothing = (target: string, zone: string, as: 'admin' | 'service') => {
    const sql = `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
                 values ($1, 'app.timezone', $2)
                 on conflict ${target} do nothing
                 returning system_setting_id`
    return as === 'admin'
      ? database.asUser(fx.adminUserId, sql, [fx.adminId, zone])
      : database.asService(sql, [fx.adminId, zone])
  }
  const oldScreenSave = (zone: string) =>
    database.asUser(
      fx.adminUserId,
      `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
       values ($1, 'app.timezone', $2)
       on conflict (system_setting_key) do update
         set admin_id = excluded.admin_id, system_setting_value = excluded.system_setting_value
       returning system_setting_value`,
      [fx.adminId, zone],
    )

  it('is passed on when a genuine insert creates the row', async () => {
    expect(await aliasRows()).toEqual([])
    expect(await clinicZone()).toBe('Asia/Manila')

    expect(await oldScreenSave(' Asia/Singapore ')).toEqual([{ system_setting_value: 'Asia/Singapore' }])

    expect(await aliasRows()).toEqual([{ v: 'Asia/Singapore' }])
    expect(await clinicZone()).toBe('Asia/Singapore')
  })

  it('changes nothing - not the setting, not the clinic - when ON CONFLICT DO NOTHING skips the row', async () => {
    const clinicUpdates = await auditCount('clinic', 'update')
    for (const target of ['(system_setting_key)', '(clinic_id, system_setting_key)']) {
      for (const as of ['admin', 'service'] as const) {
        expect(await doNothing(target, 'Asia/Tokyo', as)).toEqual([])
      }
    }
    expect(await aliasRows()).toEqual([{ v: 'Asia/Singapore' }])
    expect(await clinicZone()).toBe('Asia/Singapore')
    expect(await auditCount('clinic', 'update')).toBe(clinicUpdates)
    expect(
      await database.asUser(fx.doctorAUserId, 'select public.app_today()::text as d'),
    ).toEqual([{ d: await value<string>(database, `select (now() at time zone 'Asia/Singapore')::date::text`) }])
  })

  it('changes nothing either when the skipped row names a zone that does not exist', async () => {
    expect(await doNothing('(system_setting_key)', 'Nowhere/Atlantis', 'admin')).toEqual([])
    expect(await aliasRows()).toEqual([{ v: 'Asia/Singapore' }])
    expect(await clinicZone()).toBe('Asia/Singapore')
  })

  it('is passed on when the deployed screen’s upsert really updates the row', async () => {
    expect(await oldScreenSave('Asia/Tokyo')).toEqual([{ system_setting_value: 'Asia/Tokyo' }])
    expect(await aliasRows()).toEqual([{ v: 'Asia/Tokyo' }])
    expect(await clinicZone()).toBe('Asia/Tokyo')
  })

  it('rolls back the whole save, setting and clinic, when the zone does not exist', async () => {
    const before = await auditCount('system_setting', 'update')
    await expect(oldScreenSave('Nowhere/Atlantis')).rejects.toThrow(/Unknown time zone/)
    await expect(
      database.asUser(
        fx.adminUserId,
        `update public.system_setting set system_setting_value = 'Mars/Olympus_Mons'
          where system_setting_key = 'app.timezone'`,
      ),
    ).rejects.toThrow(/Unknown time zone/)
    expect(await aliasRows()).toEqual([{ v: 'Asia/Tokyo' }])
    expect(await clinicZone()).toBe('Asia/Tokyo')
    expect(await auditCount('system_setting', 'update')).toBe(before)
  })

  it('rolls back a genuine insert of a zone that does not exist, leaving no row', async () => {
    const other = await createTestDatabase({ stopAfter: BEFORE_GATE_LIFT })
    try {
      await expect(
        other.asService(
          `insert into public.system_setting (system_setting_key, system_setting_value) values ('app.timezone', 'Nowhere/Atlantis')`,
        ),
      ).rejects.toThrow(/Unknown time zone/)
      expect(
        await other.asService(`select 1 from public.system_setting where system_setting_key = 'app.timezone'`),
      ).toEqual([])
      expect(await other.asService('select clinic_timezone from public.clinic')).toEqual([
        { clinic_timezone: 'Asia/Manila' },
      ])
    } finally {
      await other.close()
    }
  })

  it('stays in step with admin_set_clinic_timezone, which updates the clinic once and the alias once', async () => {
    const clinicUpdates = await auditCount('clinic', 'update')
    const settingUpdates = await auditCount('system_setting', 'update')
    const zoneChanges = await auditCount('clinic_settings', 'update')

    expect(
      await database.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Manila') as z`),
    ).toEqual([{ z: 'Asia/Manila' }])

    expect(await clinicZone()).toBe('Asia/Manila')
    expect(await aliasRows()).toEqual([{ v: 'Asia/Manila' }])
    // One clinic update: the alias's own pass-through finds the clinic
    // already there and writes nothing - no second update, no loop.
    expect(await auditCount('clinic', 'update')).toBe(clinicUpdates + 1)
    expect(await auditCount('system_setting', 'update')).toBe(settingUpdates + 1)
    expect(await auditCount('clinic_settings', 'update')).toBe(zoneChanges + 1)

    // Nothing to change: nothing written at all.
    await database.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Manila')`)
    expect(await auditCount('clinic', 'update')).toBe(clinicUpdates + 1)
    expect(await auditCount('system_setting', 'update')).toBe(settingUpdates + 1)
    expect(await auditCount('clinic_settings', 'update')).toBe(zoneChanges + 1)
  })

  it('keeps the single-clinic gate', async () => {
    await expect(
      database.asService(`insert into public.clinic (clinic_name, clinic_timezone) values ('Second', 'UTC')`),
    ).rejects.toThrow(/clinic_single_clinic_gate/)
  })
})
