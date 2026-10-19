import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The 2nd-half plan, section 5 — a reminder before each dose (migration 37).
 *
 * For a dose due at 08:00: a reminder at 07:50, ten minutes before, unless the
 * clinic's `medication.reminder_lead_minutes` says 5, 15 or 30; none once the
 * dose is taken. The job runs every minute, unattended, so what matters is
 * that it sends exactly one, only within the lead time, only to patients who
 * want it, and never twice however often it runs - and that nobody but the
 * job can send one, or mark one sent.
 *
 * Each timing case runs in one rolled-back transaction, so `now()` is the
 * same instant for the doses and the job, and "exactly at the lead time" is
 * exact.
 */

const KEY = 'medication.reminder_lead_minutes'
const JOB = 'recoverease-medication-pre-dose-reminders'
const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations', import.meta.url))
const MIGRATION_30 = '20260902100030'
const MIGRATION_33 = '20260902100033'
const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'
const ROLLBACK_37 = 'supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** Every job the migrations schedule, by name, as the last one to schedule it leaves it. */
async function scheduledJobs(): Promise<Map<string, { cadence: string; command: string }>> {
  const jobs = new Map<string, { cadence: string; command: string }>()
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(`${MIGRATIONS}/${name}`, 'utf8')
    for (const [, job, cadence, command] of sql.matchAll(
      /cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$job\$(.*?)\$job\$/gs,
    )) {
      jobs.set(job!, { cadence: cadence!, command: command!.trim() })
    }
  }
  return jobs
}

/** An ongoing once-a-day course, started three days before its clinic's today. */
async function schedule(database: TestDatabase, prescriptionId: string): Promise<string> {
  const id = await one<string>(
    database,
    `insert into public.medication_schedule
       (prescription_id, medication_schedule_name, medication_schedule_dosage,
        medication_schedule_frequency, medication_schedule_times,
        medication_schedule_start_date)
     values ($1, 'Amoxicillin', '500mg', 1, '{08:00}'::time[],
             app_private.clinic_today(app_private.clinic_of_patient(
               app_private.patient_of_prescription($1))) - 3)
     returning medication_schedule_id`,
    [prescriptionId],
  )
  // The generator has filled the course's slots, today's 08:00 among them -
  // due soon or not depending on the time of day. Every case records its own.
  await database.asService('delete from public.medication_log where medication_schedule_id = $1', [id])
  return id
}

/** Saves the lead time as the settings page does: an upsert, as the Clinic Admin. */
async function setLead(database: TestDatabase, adminUserId: string, adminId: string, value: string) {
  const rows = await database.asUser(
    adminUserId,
    `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
     values ($1, $2, $3)
     on conflict (clinic_id, system_setting_key) do update
       set admin_id = excluded.admin_id,
           system_setting_value = excluded.system_setting_value
     returning system_setting_value`,
    [adminId, KEY, value],
  )
  expect(rows).toEqual([{ system_setting_value: value }])
}

describe('reminders before a dose', () => {
  let database: TestDatabase
  let fx: Fixture
  let scheduleId: string
  let job: { cadence: string; command: string }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    job = (await scheduledJobs()).get(JOB)!
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.system_setting where system_setting_key = $1', [KEY])
    await database.asService(`delete from public.notification where notification_type = 'medication'`)
    await database.asService('delete from public.medication_schedule')
    await database.asService(
      `update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null`,
    )
    scheduleId = await schedule(database, fx.alicePrescriptionId)
  })

  type Outcome = {
    /** By minutes until due: whether the reminder before it went out. */
    reminded: Record<number, boolean>
    /** By minutes until due: whether the follow-up went out. */
    chased: Record<number, boolean>
    notifications: { user_id: string; notification_type: string; notification_message: string }[]
    /** What `read` returned, at the end of the same transaction. */
    read: Record<string, unknown>[]
  }

  /**
   * Doses due `dueIn` minutes from now (negative: already due), then `steps`,
   * in one transaction that is rolled back. `before` runs ahead of the doses,
   * and `read` after everything.
   */
  async function instant(
    dueIn: number[],
    steps: string[],
    options: {
      status?: 'pending' | 'taken' | 'missed' | 'skipped'
      before?: string[]
      read?: string
    } = {},
  ): Promise<Outcome> {
    await database.db.exec('begin')
    try {
      for (const sql of options.before ?? []) await database.db.query(sql)
      await database.db.query(
        `insert into public.medication_log
           (medication_schedule_id, medication_log_scheduled_at, medication_log_status,
            medication_log_taken_at)
         select $1, now() + make_interval(mins => m), $3::public.medication_log_status,
                case when $3 = 'taken' then now() end
           from unnest($2::int[]) m`,
        [scheduleId, dueIn, options.status ?? 'pending'],
      )
      for (const sql of steps) await database.db.query(sql)
      const { rows } = await database.db.query<{ due_in: number; reminded: boolean; chased: boolean }>(
        `select round(extract(epoch from medication_log_scheduled_at - now()) / 60)::int as due_in,
                medication_log_pre_dose_sent_at is not null as reminded,
                medication_log_follow_up_sent_at is not null as chased
           from public.medication_log
          where medication_schedule_id = $1`,
        [scheduleId],
      )
      const notifications = await database.db.query<Outcome['notifications'][number]>(
        `select user_id, notification_type::text, notification_message
           from public.notification where notification_type = 'medication'
          order by notification_message`,
      )
      const read = options.read ? (await database.db.query<Record<string, unknown>>(options.read)).rows : []
      return {
        reminded: Object.fromEntries(rows.map((row) => [row.due_in, row.reminded])),
        chased: Object.fromEntries(rows.map((row) => [row.due_in, row.chased])),
        notifications: notifications.rows,
        read,
      }
    } finally {
      await database.db.exec('rollback')
    }
  }

  // --- The scheduled job ------------------------------------------------------

  describe('the scheduled job', () => {
    it('runs every minute, with nothing to pass: the lead time is the clinic’s', () => {
      expect(job).toEqual({
        cadence: '* * * * *',
        command: 'select public.dispatch_medication_pre_dose_reminders()',
      })
    })

    it('leaves the follow-up job as it was', async () => {
      expect((await scheduledJobs()).get('recoverease-medication-reminders')).toEqual({
        cadence: '*/15 * * * *',
        command: 'select public.dispatch_medication_reminders(30)',
      })
    })
  })

  // --- When ---------------------------------------------------------------------

  describe('when it is sent', () => {
    it('with no lead time set, ten minutes before: not at eleven, and never once the dose is due', async () => {
      const { reminded, notifications } = await instant([11, 10, 9, 1, 0, -1, -30], [job.command])

      expect(reminded).toEqual({ 11: false, 10: true, 9: true, 1: true, 0: false, [-1]: false, [-30]: false })
      expect(notifications).toHaveLength(3)
    })

    it.each([5, 10, 15, 30])(
      'at a lead time of %i minutes: not a minute before it, then at it and inside it',
      async (lead) => {
        await setLead(database, fx.adminUserId, fx.adminId, String(lead))
        const { reminded } = await instant([lead + 1, lead, 1], [job.command])

        expect(reminded).toEqual({ [lead + 1]: false, [lead]: true, 1: true })
      },
    )

    it('reads past spaces and leading zeros, as the grace period is read', async () => {
      for (const stored of [' 15 ', '015']) {
        await setLead(database, fx.adminUserId, fx.adminId, stored)
        expect((await instant([16, 15], [job.command])).reminded).toEqual({ 16: false, 15: true })
      }
    })

    it.each(['7', '0', '60', '45', 'ten', '10.5', '-10', '+15', '1e1', '15 minutes'])(
      'a stored value of %j is not one it uses: ten minutes it is',
      async (stored) => {
        await setLead(database, fx.adminUserId, fx.adminId, stored)
        expect((await instant([11, 10], [job.command])).reminded).toEqual({ 11: false, 10: true })
      },
    )
  })

  // --- Once -------------------------------------------------------------------

  describe('once', () => {
    it('sends one reminder per dose however often it runs', async () => {
      const { reminded, notifications } = await instant([5], [job.command, job.command, job.command])

      expect(reminded).toEqual({ 5: true })
      expect(notifications).toHaveLength(1)
    })

    it('counts what it sent, and nothing on a run with nothing to send', async () => {
      const counts = await (async () => {
        await database.db.exec('begin')
        try {
          await database.db.query(
            `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
             select $1, now() + make_interval(mins => m) from unnest('{2,4}'::int[]) m`,
            [scheduleId],
          )
          const first = await database.db.query<{ sent: number }>(`${job.command} as sent`)
          const second = await database.db.query<{ sent: number }>(`${job.command} as sent`)
          return [first.rows[0]!.sent, second.rows[0]!.sent]
        } finally {
          await database.db.exec('rollback')
        }
      })()

      expect(counts).toEqual([2, 0])
    })

    it('is its own: the follow-up still chases a dose reminded before it was due', async () => {
      // Reminded at 7:50 for 8:00, still unrecorded at 8:31.
      const { reminded, chased } = await instant(
        [-31],
        [
          `update public.medication_log set medication_log_pre_dose_sent_at = now() - interval '41 minutes'`,
          'select public.dispatch_medication_reminders(30)',
        ],
      )

      expect(reminded).toEqual({ [-31]: true })
      expect(chased).toEqual({ [-31]: true })
    })

    it('does not count as the follow-up', async () => {
      expect((await instant([5], [job.command])).chased).toEqual({ 5: false })
    })
  })

  // --- To whom, and about what ---------------------------------------------------

  describe('what it sends', () => {
    it('reminds the dose’s patient and nobody else, naming the medication, its dose and its time in the clinic’s zone', async () => {
      // The due time as the clinic reads it, in the same transaction - the same "now".
      const { notifications, read } = await instant([7], [job.command], {
        read: `select to_char((now() + interval '7 minutes') at time zone c.clinic_timezone, 'HH24:MI') as at
                 from public.clinic c`,
      })

      expect(notifications).toEqual([
        {
          user_id: fx.aliceUserId,
          notification_type: 'medication',
          notification_message: `Your Amoxicillin (500mg) is due at ${read[0]!['at']}.`,
        },
      ])
    })
  })

  // --- What stops it ---------------------------------------------------------------

  describe('what stops it', () => {
    it.each(['taken', 'missed', 'skipped'] as const)('a dose already %s gets nothing', async (status) => {
      const { reminded, notifications } = await instant([5], [job.command], { status })

      expect(reminded).toEqual({ 5: false })
      expect(notifications).toEqual([])
    })

    it('a patient who turned reminders off gets nothing', async () => {
      const { reminded, notifications } = await instant([5], [job.command], {
        before: [`update public.patient set pat_reminder_is_enabled = false where pat_id = '${fx.alicePatId}'`],
      })

      expect(reminded).toEqual({ 5: false })
      expect(notifications).toEqual([])
    })

    /** Alice's clinic's time of day, now. */
    const CLINIC_TIME = `(now() at time zone (
        select c.clinic_timezone from public.patient p
          join public.doctor d on d.doc_id = p.doc_id
          join public.clinic c on c.clinic_id = d.clinic_id
         where p.pat_id = '__PAT__'))::time`

    /**
     * A preferred time of day before or after the clinic's current one, never
     * across midnight - a time of day has no date (see medication-reminders.test.ts).
     */
    const preferred = (when: 'earlier' | 'later') => {
      const now = CLINIC_TIME.replace('__PAT__', fx.alicePatId)
      return when === 'earlier'
        ? `case when ${now} >= time '00:50' then ${now} - interval '50 minutes' else time '00:00' end`
        : `case when ${now} < time '23:10' then ${now} + interval '50 minutes' else time '24:00' end`
    }

    it('waits for the patient’s preferred time of day, the earliest they want to be contacted', async () => {
      const later = await instant([5], [job.command], {
        before: [`update public.patient set pat_reminder_preferred_time = ${preferred('later')} where pat_id = '${fx.alicePatId}'`],
      })
      expect(later.reminded).toEqual({ 5: false })

      const earlier = await instant([5], [job.command], {
        before: [`update public.patient set pat_reminder_preferred_time = ${preferred('earlier')} where pat_id = '${fx.alicePatId}'`],
      })
      expect(earlier.reminded).toEqual({ 5: true })
    })

    it('a dose after its course’s end date gets nothing; one on it is reminded', async () => {
      const endOn = (offset: string) =>
        `update public.medication_schedule
            set medication_schedule_end_date =
                  ((now() + interval '5 minutes') at time zone (select clinic_timezone from public.clinic))::date ${offset}
          where medication_schedule_id = '${scheduleId}'`

      // Changing the end date lets the generator refill the course's own
      // slots too; only the dose due in five minutes is this case's.
      expect((await instant([5], [job.command], { before: [endOn('- 1')] })).reminded[5]).toBe(false)
      expect((await instant([5], [job.command], { before: [endOn('')] })).reminded[5]).toBe(true)
    })
  })

  // --- Who can do what -------------------------------------------------------------

  describe('who can send one, or mark one sent', () => {
    it('is refused to the patient, their doctor, the Clinic Admin and an anonymous caller', async () => {
      for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
        await expectDenied(() => database.asUser(userId, 'select public.dispatch_medication_pre_dose_reminders()'))
      }
      await expectDenied(() => database.asAnon('select public.dispatch_medication_pre_dose_reminders()'))
    })

    async function doseIn(minutes: number): Promise<string> {
      return one<string>(
        database,
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         values ($1, now() + make_interval(mins => $2)) returning medication_log_id`,
        [scheduleId, minutes],
      )
    }

    it('the patient can neither set the mark, and go unreminded, nor clear it, and be reminded again', async () => {
      const dose = await doseIn(60)

      await expect(
        database.asUser(
          fx.aliceUserId,
          'update public.medication_log set medication_log_pre_dose_sent_at = now() where medication_log_id = $1',
          [dose],
        ),
      ).rejects.toThrow(/managed by the system/)

      await database.asService(
        'update public.medication_log set medication_log_pre_dose_sent_at = now() where medication_log_id = $1',
        [dose],
      )
      await expect(
        database.asUser(
          fx.aliceUserId,
          'update public.medication_log set medication_log_pre_dose_sent_at = null where medication_log_id = $1',
          [dose],
        ),
      ).rejects.toThrow(/managed by the system/)

      expect(
        await one<boolean>(
          database,
          'select medication_log_pre_dose_sent_at is not null from public.medication_log where medication_log_id = $1',
          [dose],
        ),
      ).toBe(true)
    })

    it('the patient still records a reminded dose as taken, and writing the mark it already has is no change', async () => {
      const dose = await doseIn(60)
      await database.asService(
        'update public.medication_log set medication_log_pre_dose_sent_at = now() where medication_log_id = $1',
        [dose],
      )

      expect(
        await database.asUser(
          fx.aliceUserId,
          `update public.medication_log
              set medication_log_status = 'taken',
                  medication_log_pre_dose_sent_at = medication_log_pre_dose_sent_at
            where medication_log_id = $1
          returning medication_log_status::text as status, medication_log_pre_dose_sent_at is not null as reminded`,
          [dose],
        ),
      ).toEqual([{ status: 'taken', reminded: true }])
    })

    it('the doctor cannot write the mark either: they cannot write a dose at all', async () => {
      const dose = await doseIn(60)

      await expectDenied(() =>
        database.asUser(
          fx.doctorAUserId,
          `update public.medication_log set medication_log_pre_dose_sent_at = now()
            where medication_log_id = $1 returning medication_log_id`,
          [dose],
        ),
      )
    })

    it('only the Clinic Admin sets the lead time: not the patient, not the doctor', async () => {
      for (const userId of [fx.aliceUserId, fx.doctorAUserId]) {
        await expectDenied(() =>
          database.asUser(
            userId,
            `insert into public.system_setting (system_setting_key, system_setting_value)
             values ($1, '30') returning system_setting_id`,
            [KEY],
          ),
        )
      }
      expect(await database.asService('select 1 from public.system_setting where system_setting_key = $1', [KEY])).toEqual([])
    })
  })
})

describe('each clinic’s lead time', () => {
  let database: TestDatabase
  let fx: Fixture
  const jobCommand = 'select public.dispatch_medication_pre_dose_reminders()'

  type Member = { adminUserId: string; adminId: string; patientUserId: string; scheduleId: string }
  let harborview: Member
  let second: Member

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    harborview = {
      adminUserId: fx.adminUserId,
      adminId: fx.adminId,
      patientUserId: fx.aliceUserId,
      scheduleId: '',
    }
    await liftSingleClinicGate(database)
    const clinicId = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')

    const account = async (email: string, role: 'patient' | 'doctor' | 'admin') => {
      const userId = await one<string>(
        database,
        'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
        [email],
      )
      await database.asService(
        'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
        [userId, email, role],
      )
      return userId
    }
    const adminUserId = await account('admin@second.test', 'admin')
    const adminId = await one<string>(
      database,
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Admin', 'Second', $2) returning admin_id`,
      [adminUserId, clinicId],
    )
    const doctorUserId = await account('doctor@second.test', 'doctor')
    const doctorId = await one<string>(
      database,
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Doc', 'Second', 'LIC-SECOND', $2) returning doc_id`,
      [doctorUserId, clinicId],
    )
    const patientUserId = await account('patient@second.test', 'patient')
    const patientId = await one<string>(
      database,
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, 'Pat', 'Second', now()) returning pat_id`,
      [patientUserId, doctorId],
    )
    const prescriptionId = await one<string>(
      database,
      `insert into public.prescription (pat_id, doc_id, prescription_issued_date)
       values ($1, $2, app_private.clinic_today($3)) returning prescription_id`,
      [patientId, doctorId, clinicId],
    )

    await database.asService('delete from public.medication_schedule')
    harborview.scheduleId = await schedule(database, fx.alicePrescriptionId)
    second = { adminUserId, adminId, patientUserId, scheduleId: await schedule(database, prescriptionId) }
  })

  afterAll(async () => {
    await database?.close()
  })

  it('is read from each patient’s own clinic: five minutes in one, thirty in the other', async () => {
    await setLead(database, harborview.adminUserId, harborview.adminId, '5')
    await setLead(database, second.adminUserId, second.adminId, '30')

    await database.db.exec('begin')
    try {
      for (const scheduleId of [harborview.scheduleId, second.scheduleId]) {
        await database.db.query(
          `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
           values ($1, now() + interval '20 minutes')`,
          [scheduleId],
        )
      }
      await database.db.query(jobCommand)
      const { rows } = await database.db.query<{ user_id: string }>(
        `select user_id from public.notification where notification_type = 'medication'`,
      )

      expect(rows).toEqual([{ user_id: second.patientUserId }])
    } finally {
      await database.db.exec('rollback')
    }
  })

  it('each Clinic Admin sets only their own clinic’s', async () => {
    await setLead(database, harborview.adminUserId, harborview.adminId, '15')

    expect(
      await database.asService(
        `select c.clinic_name as clinic, s.system_setting_value as lead
           from public.system_setting s join public.clinic c using (clinic_id)
          where s.system_setting_key = $1 order by 1`,
        [KEY],
      ),
    ).toEqual([
      { clinic: 'Harborview Recovery Clinic', lead: '15' },
      { clinic: 'Synthetic Second Clinic', lead: '30' },
    ])
  })
})

describe('migration 37 beside the others', () => {
  it('refuses to run without migration 31, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: MIGRATION_30 })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_37)).rejects.toThrow(/needs migration 31 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('refuses to run twice', async () => {
    const applied = await createTestDatabase()
    try {
      const before = await catalog(applied)
      await expect(applied.applyMigration(MIGRATION_37)).rejects.toThrow(/already been applied/)
      expect(await catalog(applied)).toEqual(before)
    } finally {
      await applied.close()
    }
  })

  it('goes in after 33, 35 and 36 with 34 still unapplied, as production has them, keeping every dose; then the same schema once 34 follows', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      createTestDatabase(),
    ])
    try {
      await seedFixture(production)
      await production.applyMigration(MIGRATION_35)
      await production.applyMigration(MIGRATION_36)
      const doses = () =>
        production.asService(
          `select medication_log_id, medication_schedule_id, medication_log_scheduled_at,
                  medication_log_status::text, medication_log_follow_up_sent_at
             from public.medication_log order by 1`,
        )
      const before = await doses()
      expect(before.length).toBeGreaterThan(0)

      await production.applyMigration(MIGRATION_37)

      expect(await doses()).toEqual(before)
      expect(
        await one<number>(production, 'select count(*)::int from public.medication_log where medication_log_pre_dose_sent_at is not null'),
      ).toBe(0)
      expect(
        await one<number>(production, `select count(*)::int from pg_indexes where indexname = 'clinic_single_clinic_gate'`),
      ).toBe(1)

      await production.applyMigration(MIGRATION_34)
      expect(await catalog(production)).toEqual(await catalog(repository))
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})

describe('the down-script for migration 37', () => {
  let used: TestDatabase
  let through36: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[used, through36] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_37 }),
      createTestDatabase({ stopAfter: MIGRATION_36 }),
    ])
    fx = await seedFixture(used)
    // Use what 37 adds: a lead time, and a reminder sent and marked.
    await setLead(used, fx.adminUserId, fx.adminId, '15')
    await used.asService(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + interval '3 minutes')`,
      [fx.aliceScheduleId],
    )
    expect(await one<number>(used, 'select public.dispatch_medication_pre_dose_reminders()')).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through36?.close()])
  })

  it('returns the schema to exactly what 36 left, keeping every dose, reminder and setting', async () => {
    const rows = async () => ({
      doses: await used.asService(
        `select medication_log_id, medication_log_scheduled_at, medication_log_status::text,
                medication_log_follow_up_sent_at
           from public.medication_log order by 1`,
      ),
      notifications: await used.asService(
        'select notification_id, user_id, notification_type::text, notification_message from public.notification order by 1',
      ),
      settings: await used.asService(
        'select system_setting_id, clinic_id, system_setting_key, system_setting_value from public.system_setting order by 1',
      ),
    })
    const before = await rows()
    expect(before.notifications.some((n) => String(n['notification_message']).startsWith('Your Paracetamol'))).toBe(true)

    await used.db.exec(await script(ROLLBACK_37))

    expect(await catalog(used)).toEqual(await catalog(through36))
    expect(await rows()).toEqual(before)
  })

  it('refuses, changing nothing, where migration 37 is not applied', async () => {
    const before = await catalog(through36)
    await expect(through36.db.exec(await script(ROLLBACK_37))).rejects.toThrow(/Migration 37 is not applied/)
    expect(await catalog(through36)).toEqual(before)
  })
})
