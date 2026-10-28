import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 7.3 "Configure Reminder Settings", the doctor's own (migration 42):
 * a doctor may turn off the reminder they are sent the day before each of
 * their appointments. Nobody else may turn it off for them, and turning it
 * off changes nothing for their patients, for any other doctor, or for the
 * clinic's settings.
 */

const MIGRATION_41 = '20260902100041'
const MIGRATION_42 = '20260902100042'
const ROLLBACK_42 = 'supabase/rollbacks/20260902100042_doctor_appointment_reminder_setting.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const GUARD = /Only the doctor can change their own reminder settings/

async function reminderSetting(database: TestDatabase, doctorId: string): Promise<boolean> {
  const [row] = await database.asService<{ on: boolean }>(
    'select doc_appointment_reminder_is_enabled as on from public.doctor where doc_id = $1',
    [doctorId],
  )
  return row!.on
}

/** As the My profile page saves it: the one column, on the doctor's own row. */
function setReminderAs(
  database: TestDatabase,
  userId: string,
  doctorId: string,
  on: boolean,
) {
  return database.asUser<{ doc_id: string }>(
    userId,
    `update public.doctor set doc_appointment_reminder_is_enabled = $2
      where doc_id = $1 returning doc_id`,
    [doctorId, on],
  )
}

describe('a doctor’s appointment reminder setting (migration 42)', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService(
      'update public.doctor set doc_appointment_reminder_is_enabled = true',
    )
  })

  describe('who may change it', () => {
    it('is on for every doctor, and for a doctor added later', async () => {
      const rows = await database.asService<{ on: boolean }>(
        'select doc_appointment_reminder_is_enabled as on from public.doctor',
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.on)).toBe(true)

      const [column] = await database.asService<{ fallback: string; nullable: string }>(
        `select column_default as fallback, is_nullable as nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'doctor'
            and column_name = 'doc_appointment_reminder_is_enabled'`,
      )
      expect(column).toEqual({ fallback: 'true', nullable: 'NO' })
    })

    it('lets the doctor turn their own off, and on again', async () => {
      await expect(
        setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false),
      ).resolves.toEqual([{ doc_id: fx.doctorAId }])
      expect(await reminderSetting(database, fx.doctorAId)).toBe(false)

      await expect(
        setReminderAs(database, fx.doctorAUserId, fx.doctorAId, true),
      ).resolves.toEqual([{ doc_id: fx.doctorAId }])
      expect(await reminderSetting(database, fx.doctorAId)).toBe(true)
    })

    it('does not let another doctor change it', async () => {
      await expectDenied(() =>
        setReminderAs(database, fx.doctorBUserId, fx.doctorAId, false),
      )
      expect(await reminderSetting(database, fx.doctorAId)).toBe(true)
    })

    it('does not let a patient change their doctor’s', async () => {
      await expectDenied(() =>
        setReminderAs(database, fx.aliceUserId, fx.doctorAId, false),
      )
      expect(await reminderSetting(database, fx.doctorAId)).toBe(true)
    })

    it('does not let a visitor with no session change it', async () => {
      await expectDenied(() =>
        database.asAnon(
          `update public.doctor set doc_appointment_reminder_is_enabled = false
            where doc_id = $1 returning doc_id`,
          [fx.doctorAId],
        ),
      )
      expect(await reminderSetting(database, fx.doctorAId)).toBe(true)
    })

    it('does not let the clinic’s administrator change it, either way', async () => {
      await expect(
        setReminderAs(database, fx.adminUserId, fx.doctorAId, false),
      ).rejects.toThrow(GUARD)
      expect(await reminderSetting(database, fx.doctorAId)).toBe(true)

      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false)
      await expect(
        setReminderAs(database, fx.adminUserId, fx.doctorAId, true),
      ).rejects.toThrow(GUARD)
      expect(await reminderSetting(database, fx.doctorAId)).toBe(false)
    })

    it('leaves the administrator’s other edits to a doctor alone', async () => {
      // Module 11.3: the administrator still edits the rest of the row, and
      // an update that carries the setting unchanged - a whole-row save - is
      // not a change to it.
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.doctor set doc_specialization = 'Sports rehabilitation'
            where doc_id = $1 returning doc_id`,
          [fx.doctorAId],
        ),
      ).resolves.toEqual([{ doc_id: fx.doctorAId }])

      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.doctor
              set doc_specialization = 'Orthopaedic rehabilitation',
                  doc_appointment_reminder_is_enabled = true
            where doc_id = $1 returning doc_id`,
          [fx.doctorAId],
        ),
      ).resolves.toEqual([{ doc_id: fx.doctorAId }])
    })

    it('is the only thing the guard looks at: the doctor still edits their profile', async () => {
      await expect(
        database.asUser(
          fx.doctorAUserId,
          `update public.doctor
              set doc_contact_no = '+63 917 555 0142',
                  doc_appointment_reminder_is_enabled = false
            where doc_id = $1 returning doc_id`,
          [fx.doctorAId],
        ),
      ).resolves.toEqual([{ doc_id: fx.doctorAId }])
    })

    it('keeps the guard and the reminder job out of the Data API', async () => {
      const [row] = await database.asService<{ guard: boolean; job: boolean }>(
        `select
           has_function_privilege('authenticated', 'public.doctor_guard_reminder_preference()', 'execute') as guard,
           has_function_privilege('authenticated', 'public.dispatch_appointment_reminders(integer)', 'execute') as job`,
      )
      expect(row).toEqual({ guard: false, job: false })

      await expect(
        database.asUser(fx.doctorAUserId, 'select public.dispatch_appointment_reminders(24)'),
      ).rejects.toThrow(/permission denied/)
    })
  })

  describe('the reminder job', () => {
    beforeEach(async () => {
      await database.asService('delete from public.notification')
      await database.asService('delete from public.appointment')
    })

    async function appointmentIn(
      hoursAway: number,
      patId: string,
      docId: string,
    ): Promise<string> {
      const [row] = await database.asService<{ appointment_id: string }>(
        `insert into public.appointment
           (pat_id, doc_id, appointment_date, appointment_status)
         values ($1, $2, now() + make_interval(hours => $3), 'scheduled')
         returning appointment_id`,
        [patId, docId, hoursAway],
      )
      return row!.appointment_id
    }

    async function dispatch(): Promise<number> {
      const [row] = await database.asService<{ dispatch_appointment_reminders: number }>(
        'select public.dispatch_appointment_reminders(24)',
      )
      return Number(row!.dispatch_appointment_reminders)
    }

    async function remindersFor(userId: string): Promise<string[]> {
      const rows = await database.asService<{ notification_message: string }>(
        `select notification_message from public.notification
          where user_id = $1 and notification_type = 'appointment'`,
        [userId],
      )
      return rows.map((row) => row.notification_message)
    }

    async function isStamped(appointmentId: string): Promise<boolean> {
      const [row] = await database.asService<{ stamped: boolean }>(
        `select appointment_reminder_sent_at is not null as stamped
           from public.appointment where appointment_id = $1`,
        [appointmentId],
      )
      return row!.stamped
    }

    it('sends both reminders while the doctor’s is on, as before', async () => {
      await appointmentIn(12, fx.alicePatId, fx.doctorAId)

      expect(await dispatch()).toBe(2)
      expect(await remindersFor(fx.doctorAUserId)).toHaveLength(1)
      expect(await remindersFor(fx.aliceUserId)).toHaveLength(1)
    })

    it('leaves the doctor out once they turn theirs off, and still tells the patient', async () => {
      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false)
      const id = await appointmentIn(12, fx.alicePatId, fx.doctorAId)

      expect(await dispatch()).toBe(1)
      expect(await remindersFor(fx.doctorAUserId)).toEqual([])
      expect(await remindersFor(fx.aliceUserId)).toEqual([
        expect.stringMatching(/^You have an upcoming appointment on /),
      ])
      // Stamped as before, so it is never reminded again.
      expect(await isStamped(id)).toBe(true)
      expect(await dispatch()).toBe(0)
    })

    it('does not catch up when the doctor turns theirs back on', async () => {
      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false)
      await appointmentIn(12, fx.alicePatId, fx.doctorAId)
      expect(await dispatch()).toBe(1)

      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, true)
      expect(await dispatch()).toBe(0)
      expect(await remindersFor(fx.doctorAUserId)).toEqual([])

      // The next appointment is reminded as before.
      await appointmentIn(20, fx.bobPatId, fx.doctorAId)
      expect(await dispatch()).toBe(2)
      expect(await remindersFor(fx.doctorAUserId)).toHaveLength(1)
    })

    it('changes nothing for another doctor or their patients', async () => {
      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false)
      await appointmentIn(12, fx.alicePatId, fx.doctorAId)
      await appointmentIn(14, fx.bobPatId, fx.doctorAId)
      await appointmentIn(16, fx.carolPatId, fx.doctorBId)

      expect(await dispatch()).toBe(4)
      expect(await remindersFor(fx.doctorAUserId)).toEqual([])
      expect(await remindersFor(fx.aliceUserId)).toHaveLength(1)
      expect(await remindersFor(fx.bobUserId)).toHaveLength(1)
      expect(await remindersFor(fx.doctorBUserId)).toEqual([
        expect.stringMatching(/^Upcoming appointment with Carol /),
      ])
      expect(await remindersFor(fx.carolUserId)).toHaveLength(1)
    })

    it('touches no clinic setting, and no patient’s reminder preferences', async () => {
      const snapshot = () =>
        Promise.all([
          database.asService(
            `select system_setting_id, clinic_id, system_setting_key, system_setting_value,
                    system_setting_updated_at::text as updated
               from public.system_setting order by 1`,
          ),
          database.asService('select * from public.clinic order by clinic_id'),
          database.asService(
            `select pat_id, pat_reminder_is_enabled, pat_reminder_preferred_time::text as at
               from public.patient order by pat_id`,
          ),
        ])

      const before = await snapshot()
      await setReminderAs(database, fx.doctorAUserId, fx.doctorAId, false)
      await appointmentIn(12, fx.alicePatId, fx.doctorAId)
      await dispatch()

      expect(await snapshot()).toEqual(before)
    })
  })
})

describe('migration 42, before and after', () => {
  it('turns it on for every doctor who already exists', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_41 })
    try {
      const fx = await seedFixture(database)
      await database.applyMigration(MIGRATION_42)

      const rows = await database.asService<{ doc_id: string; on: boolean }>(
        'select doc_id, doc_appointment_reminder_is_enabled as on from public.doctor order by doc_id',
      )
      expect(rows.map((row) => row.doc_id).sort()).toEqual(
        [fx.doctorAId, fx.doctorBId, fx.doctorCId].sort(),
      )
      expect(rows.every((row) => row.on)).toBe(true)
    } finally {
      await database.close()
    }
  })

  it('rolls back to sending every doctor theirs, refuses to run twice, and can be applied again', async () => {
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.asUser(
        fx.doctorAUserId,
        `update public.doctor set doc_appointment_reminder_is_enabled = false
          where doc_id = $1`,
        [fx.doctorAId],
      )

      await database.db.exec(await script(ROLLBACK_42))

      const columns = await database.asService(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'doctor'
            and column_name = 'doc_appointment_reminder_is_enabled'`,
      )
      expect(columns).toEqual([])
      const leftovers = await database.asService(
        `select 1 from pg_trigger where tgname = 'doctor_protect_reminder_preference'
         union all
         select 1 from pg_proc where proname = 'doctor_guard_reminder_preference'`,
      )
      expect(leftovers).toEqual([])
      const [described] = await database.asService<{ comment: string }>(
        `select obj_description('public.dispatch_appointment_reminders(integer)'::regprocedure, 'pg_proc') as comment`,
      )
      expect(described!.comment).toMatch(/\(two per appointment\)/)

      // Migration 31's job: the doctor who had turned theirs off is told again.
      await database.asService('delete from public.notification')
      await database.asService('delete from public.appointment')
      await database.asService(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '12 hours')`,
        [fx.alicePatId, fx.doctorAId],
      )
      const [sent] = await database.asService<{ n: number }>(
        'select public.dispatch_appointment_reminders(24) as n',
      )
      expect(Number(sent!.n)).toBe(2)

      await expect(database.db.exec(await script(ROLLBACK_42))).rejects.toThrow(
        /Migration 42 is not applied/,
      )

      // Re-applying it starts every doctor on again.
      await database.applyMigration(MIGRATION_42)
      const rows = await database.asService<{ on: boolean }>(
        'select doc_appointment_reminder_is_enabled as on from public.doctor',
      )
      expect(rows.every((row) => row.on)).toBe(true)
    } finally {
      await database.close()
    }
  })
})
