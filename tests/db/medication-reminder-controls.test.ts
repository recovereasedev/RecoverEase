import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 59 — the doctor switches a medicine's reminders on or off.
 *
 * `medication_schedule_reminders_is_enabled` is on for every schedule unless
 * the patient's doctor turns it off. A reminder goes out only when the doctor
 * has it on for that medicine AND the patient wants medication reminders.
 * Both reminder jobs, and the check a queued phone reminder gets before it is
 * delivered, read it. Nothing else does: doses are still generated, still
 * recordable, and still become missed.
 */

const MIGRATION_58 = '20260902100058'
const MIGRATION_59 = '20260902100059'
const MIGRATION_59_FILE =
  'supabase/migrations/20260902100059_medication_schedule_reminder_control.sql'
const ROLLBACK_59 =
  'supabase/rollbacks/20260902100059_medication_schedule_reminder_control.down.sql'

const ROLLBACK_53 = 'supabase/rollbacks/20260902100053_web_push_notifications.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const FUNCTIONS = [
  'public.dispatch_medication_reminders(integer)',
  'public.dispatch_medication_pre_dose_reminders()',
  'app_private.push_source_is_current(text, uuid, uuid, timestamptz, uuid)',
] as const

/** Each reminder function's definition, security, settings and who may run it. */
const functionFacts = (database: TestDatabase) =>
  database.asService(
    `select f.name,
            pg_get_functiondef(f.name::regprocedure) as definition,
            p.prosecdef as security_definer,
            p.proconfig as settings,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated_may_run,
            has_function_privilege('anon', p.oid, 'execute') as anon_may_run,
            has_function_privilege('service_role', p.oid, 'execute') as service_may_run
       from unnest($1::text[]) as f(name)
       join pg_proc p on p.oid = f.name::regprocedure
      order by 1`,
    [[...FUNCTIONS]],
  )

describe('the doctor’s reminder switch on a medicine (migration 59)', () => {
  let database: TestDatabase
  let fx: Fixture
  let medicineA: string
  let medicineB: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  /** An ongoing once-a-day course on Alice's prescription, with no doses yet. */
  async function medicine(name: string): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times,
          medication_schedule_start_date)
       values ($1, $2, '500mg', 1, '{08:00}'::time[],
               -- The patient's clinic's today: one test adds a second clinic.
               app_private.clinic_today(app_private.clinic_of_patient(
                 app_private.patient_of_prescription($1))) - 3)
       returning medication_schedule_id as id`,
      [fx.alicePrescriptionId, name],
    )
    await database.asService('delete from public.medication_log where medication_schedule_id = $1', [
      row!.id,
    ])
    return row!.id
  }

  beforeEach(async () => {
    await database.asService(`delete from public.notification where notification_type = 'medication'`)
    await database.asService('delete from public.medication_schedule')
    await database.asService(
      `update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null`,
    )
    medicineA = await medicine('Medicine A')
    medicineB = await medicine('Medicine B')
  })

  /** A pending dose due `minutes` from now (negative: already due). */
  async function dose(scheduleId: string, minutes: number): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + make_interval(mins => $2::int))
       returning medication_log_id as id`,
      [scheduleId, minutes],
    )
    return row!.id
  }

  /** The switch alone, as the app writes it. Resolves to the rows changed. */
  const setAs = (userId: string, scheduleId: string, enabled: boolean) =>
    database.asUser(
      userId,
      `update public.medication_schedule
          set medication_schedule_reminders_is_enabled = $2
        where medication_schedule_id = $1
        returning medication_schedule_id`,
      [scheduleId, enabled],
    )

  const isEnabled = async (scheduleId: string) => {
    const [row] = await database.asService<{ on: boolean }>(
      `select medication_schedule_reminders_is_enabled as on
         from public.medication_schedule where medication_schedule_id = $1`,
      [scheduleId],
    )
    return row!.on
  }

  const preDose = async () =>
    Number(
      (await database.asService<{ n: number }>(
        'select public.dispatch_medication_pre_dose_reminders() as n',
      ))[0]!.n,
    )
  const followUp = async () =>
    Number(
      (await database.asService<{ n: number }>('select public.dispatch_medication_reminders(30) as n'))[0]!
        .n,
    )

  /** How many reminders were written about a dose. */
  const remindersFor = async (doseId: string) =>
    Number(
      (await database.asService<{ n: number }>(
        `select count(*) as n from public.notification where notification_medication_log_id = $1`,
        [doseId],
      ))[0]!.n,
    )

  // --- The column ------------------------------------------------------------

  it('is on for a new medicine, with nothing said', async () => {
    expect(await isEnabled(medicineA)).toBe(true)
    const [row] = await database.asUser<{ on: boolean }>(
      fx.doctorAUserId,
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times)
       values ($1, 'Ibuprofen', '200mg', 1, '{09:00}')
       returning medication_schedule_reminders_is_enabled as on`,
      [fx.alicePrescriptionId],
    )
    expect(row!.on).toBe(true)
  })

  it('cannot be left empty', async () => {
    await expect(
      database.asService(
        `update public.medication_schedule set medication_schedule_reminders_is_enabled = null
          where medication_schedule_id = $1`,
        [medicineA],
      ),
    ).rejects.toThrow(/not-null|null value/)
  })

  // --- Who may change it -----------------------------------------------------

  it('lets the patient’s doctor turn one medicine off and on again, leaving the other alone', async () => {
    await expect(setAs(fx.doctorAUserId, medicineA, false)).resolves.toHaveLength(1)
    expect(await isEnabled(medicineA)).toBe(false)
    expect(await isEnabled(medicineB)).toBe(true)

    await expect(setAs(fx.doctorAUserId, medicineA, true)).resolves.toHaveLength(1)
    expect(await isEnabled(medicineA)).toBe(true)
  })

  it('lets the patient read the setting and not change it', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const read = await database.asUser<{ on: boolean }>(
      fx.aliceUserId,
      `select medication_schedule_reminders_is_enabled as on
         from public.medication_schedule where medication_schedule_id = $1`,
      [medicineA],
    )
    expect(read).toEqual([{ on: false }])

    await expectDenied(() => setAs(fx.aliceUserId, medicineA, true))
    expect(await isEnabled(medicineA)).toBe(false)
  })

  it('refuses a doctor the patient is not assigned to, and the clinic’s administrator', async () => {
    await expectDenied(() => setAs(fx.doctorBUserId, medicineA, false))
    await expectDenied(() => setAs(fx.adminUserId, medicineA, false))
    expect(await isEnabled(medicineA)).toBe(true)
  })

  it('refuses a doctor in another clinic', async () => {
    await liftSingleClinicGate(database)
    const otherClinic = await addClinic(database, 'Second Street Clinic', 'Asia/Tokyo')
    const [user] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email)
       values (gen_random_uuid(), 'doctor.y@second.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role)
       values ($1, 'doctor.y@second.test', 'doctor')`,
      [user!.id],
    )
    await database.asService(
      `insert into public.doctor
         (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Yan', 'Other', 'LIC-Y-001', true, $2)`,
      [user!.id, otherClinic],
    )

    await expectDenied(() => setAs(user!.id, medicineA, false))
    expect(await isEnabled(medicineA)).toBe(true)
  })

  // --- The reminder before a dose --------------------------------------------

  it('sends no reminder before a dose of a medicine switched off, and still sends the other’s', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const offDose = await dose(medicineA, 5)
    const onDose = await dose(medicineB, 5)

    expect(await preDose()).toBe(1)
    expect(await remindersFor(offDose)).toBe(0)
    expect(await remindersFor(onDose)).toBe(1)
    // Not marked as reminded either: nothing was sent.
    const [row] = await database.asService<{ sent: string | null }>(
      'select medication_log_pre_dose_sent_at as sent from public.medication_log where medication_log_id = $1',
      [offDose],
    )
    expect(row!.sent).toBeNull()
  })

  it('resumes before the next dose once switched back on, without repeating one already sent', async () => {
    const already = await dose(medicineA, 5)
    expect(await preDose()).toBe(1)

    await setAs(fx.doctorAUserId, medicineA, false)
    const whileOff = await dose(medicineA, 8)
    expect(await preDose()).toBe(0)

    await setAs(fx.doctorAUserId, medicineA, true)
    expect(await preDose()).toBe(1)
    expect(await preDose()).toBe(0)
    expect(await remindersFor(already)).toBe(1)
    // Still ahead and within the lead time, so it is today's reminder, not history.
    expect(await remindersFor(whileOff)).toBe(1)
  })

  // --- The follow-up ---------------------------------------------------------

  it('sends no follow-up for a medicine switched off, and still sends the other’s', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const offDose = await dose(medicineA, -40)
    const onDose = await dose(medicineB, -40)

    expect(await followUp()).toBe(1)
    expect(await remindersFor(offDose)).toBe(0)
    expect(await remindersFor(onDose)).toBe(1)
    const [row] = await database.asService<{ sent: string | null }>(
      'select medication_log_follow_up_sent_at as sent from public.medication_log where medication_log_id = $1',
      [offDose],
    )
    expect(row!.sent).toBeNull()
  })

  it('does not chase the doses that came due while it was off once it is switched back on', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const missedWhileOff = [await dose(medicineA, -40), await dose(medicineA, -90), await dose(medicineA, -200)]
    expect(await followUp()).toBe(0)

    await setAs(fx.doctorAUserId, medicineA, true)
    expect(await followUp()).toBe(0)
    for (const id of missedWhileOff) expect(await remindersFor(id)).toBe(0)
  })

  it('chases doses due after it was switched back on, once each', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    await setAs(fx.doctorAUserId, medicineA, true)
    // As if it had been switched back on two hours ago. The stamp is the
    // database's own, so it is moved here with its trigger set aside.
    await database.db.exec(`
      alter table public.medication_schedule disable trigger medication_schedule_stamp_reminders;
      update public.medication_schedule
         set medication_schedule_reminders_enabled_at = now() - interval '2 hours';
      alter table public.medication_schedule enable trigger medication_schedule_stamp_reminders;
    `)
    const before = await dose(medicineA, -200)
    const after = await dose(medicineA, -40)

    expect(await followUp()).toBe(1)
    expect(await followUp()).toBe(0)
    expect(await remindersFor(before)).toBe(0)
    expect(await remindersFor(after)).toBe(1)
  })

  it('stamps the moment reminders come back on itself, whatever the writer sends', async () => {
    const stamp = async () =>
      (await database.asService<{ at: string | null }>(
        `select medication_schedule_reminders_enabled_at as at
           from public.medication_schedule where medication_schedule_id = $1`,
        [medicineA],
      ))[0]!.at

    expect(await stamp()).toBeNull()
    await database.asUser(
      fx.doctorAUserId,
      `update public.medication_schedule
          set medication_schedule_reminders_enabled_at = '2000-01-01'
        where medication_schedule_id = $1 returning 1`,
      [medicineA],
    )
    expect(await stamp()).toBeNull()

    await setAs(fx.doctorAUserId, medicineA, false)
    expect(await stamp()).toBeNull()
    await setAs(fx.doctorAUserId, medicineA, true)
    const first = await stamp()
    expect(first).not.toBeNull()
    // Saving "on" again when it is already on is not coming back on.
    await setAs(fx.doctorAUserId, medicineA, true)
    expect(await stamp()).toEqual(first)
  })

  // --- The patient's own choice ----------------------------------------------

  it('sends nothing to a patient who switched medication reminders off, whatever the doctor set', async () => {
    await database.asService('update public.patient set pat_reminder_is_enabled = false where pat_id = $1', [
      fx.alicePatId,
    ])
    await dose(medicineA, 5)
    await dose(medicineA, -40)

    expect(await isEnabled(medicineA)).toBe(true)
    expect(await preDose()).toBe(0)
    expect(await followUp()).toBe(0)
  })

  it('leaves the patient’s own reminder choice as it was', async () => {
    const choice = () =>
      database.asService(
        'select pat_reminder_is_enabled, pat_reminder_preferred_time from public.patient where pat_id = $1',
        [fx.alicePatId],
      )
    const before = await choice()
    await setAs(fx.doctorAUserId, medicineA, false)
    await setAs(fx.doctorAUserId, medicineA, true)
    expect(await choice()).toEqual(before)
  })

  // --- Phone reminders -------------------------------------------------------

  it('drops a phone reminder still waiting when the doctor switches the medicine off', async () => {
    const id = await dose(medicineA, 5)
    const current = async (event: string) =>
      (await database.asService<{ ok: boolean }>(
        `select app_private.push_source_is_current(
                  $1, ml.medication_log_id, null, ml.medication_log_scheduled_at, $3) as ok
           from public.medication_log ml where ml.medication_log_id = $2`,
        [event, id, fx.aliceUserId],
      ))[0]!.ok

    expect(await current('medication_pre_dose')).toBe(true)
    expect(await current('medication_follow_up')).toBe(true)
    await setAs(fx.doctorAUserId, medicineA, false)
    expect(await current('medication_pre_dose')).toBe(false)
    expect(await current('medication_follow_up')).toBe(false)
  })

  // --- What it does not touch ------------------------------------------------

  it('changes no dose when the switch changes', async () => {
    await dose(medicineA, 5)
    await dose(medicineA, -40)
    const doses = () =>
      database.asService(
        'select * from public.medication_log where medication_schedule_id = $1 order by medication_log_id',
        [medicineA],
      )
    const before = await doses()
    await setAs(fx.doctorAUserId, medicineA, false)
    await setAs(fx.doctorAUserId, medicineA, true)
    expect(await doses()).toEqual(before)
  })

  it('still lets the patient record a dose of a medicine switched off', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const id = await dose(medicineA, -10)
    const rows = await database.asUser(
      fx.aliceUserId,
      `update public.medication_log set medication_log_status = 'taken'
        where medication_log_id = $1 returning medication_log_status`,
      [id],
    )
    expect(rows).toEqual([{ medication_log_status: 'taken' }])
  })

  it('still marks an unrecorded dose missed after the grace period, switched off or not', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    const offDose = await dose(medicineA, -7 * 60)
    const onDose = await dose(medicineB, -7 * 60)

    const [row] = await database.asService<{ n: number }>('select public.mark_overdue_medication_logs(6) as n')
    expect(Number(row!.n)).toBe(2)
    const statuses = await database.asService<{ medication_log_status: string }>(
      'select medication_log_status from public.medication_log where medication_log_id = any($1::uuid[])',
      [[offDose, onDose]],
    )
    expect(statuses.map((s) => s.medication_log_status)).toEqual(['missed', 'missed'])
  })

  it('still generates doses for a medicine switched off, exactly as for one switched on', async () => {
    await setAs(fx.doctorAUserId, medicineA, false)
    await database.asService('select public.extend_all_medication_log_slots(30)')
    const slots = async (scheduleId: string) =>
      (await database.asService<{ at: string }>(
        `select medication_log_scheduled_at::text as at from public.medication_log
          where medication_schedule_id = $1 order by 1`,
        [scheduleId],
      )).map((row) => row.at)

    expect((await slots(medicineA)).length).toBeGreaterThan(0)
    expect(await slots(medicineA)).toEqual(await slots(medicineB))
  })
})

describe('migration 59 and the reminder jobs', () => {
  it('schedules no job and changes no cadence', async () => {
    expect(await script(MIGRATION_59_FILE)).not.toMatch(/cron\./)
  })

  it('keeps each function as migration 53 left it, but for the new condition', async () => {
    const [before, after] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_58 }),
      createTestDatabase(),
    ])
    try {
      const was = await functionFacts(before)
      const is = await functionFacts(after)

      // Still SECURITY DEFINER with an empty search_path, still run by the
      // service role only.
      for (const fact of is) {
        expect(fact).toMatchObject({
          security_definer: true,
          settings: ['search_path=""'],
          authenticated_may_run: false,
          anon_may_run: false,
        })
      }
      expect(is.map(({ definition: _definition, ...rest }) => rest)).toEqual(
        was.map(({ definition: _definition, ...rest }) => rest),
      )

      // The bodies differ only by lines that name the new columns, and the
      // comments explaining them.
      const withoutNewLines = (definition: unknown) =>
        String(definition)
          .split('\n')
          .filter((line) => !/medication_schedule_reminders_|-- \(59\)/.test(line))
          .join('\n')
      for (const [index, fact] of is.entries()) {
        expect(fact['definition']).toContain('medication_schedule_reminders_is_enabled')
        expect(withoutNewLines(fact['definition'])).toBe(String(was[index]!['definition']))
      }
    } finally {
      await Promise.all([before.close(), after.close()])
    }
  })
})

describe('migration 59 on existing data, and its rollback', () => {
  it('leaves every existing schedule with reminders on, and touches nothing else', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_58 })
    try {
      await seedFixture(database)
      const schedules = () =>
        database.asService(
          `select to_jsonb(s) - 'medication_schedule_reminders_is_enabled'
                              - 'medication_schedule_reminders_enabled_at' as row
             from public.medication_schedule s order by medication_schedule_id`,
        )
      const doses = () =>
        database.asService('select * from public.medication_log order by medication_log_id')
      const before = { schedules: await schedules(), doses: await doses() }
      expect(before.schedules.length).toBeGreaterThan(0)

      await database.applyMigration(MIGRATION_59)

      expect({ schedules: await schedules(), doses: await doses() }).toEqual(before)
      const settings = await database.asService(
        `select distinct medication_schedule_reminders_is_enabled as on,
                         medication_schedule_reminders_enabled_at as at
           from public.medication_schedule`,
      )
      expect(settings).toEqual([{ on: true, at: null }])
      const [{ timeout }] = await database.asService<{ timeout: string }>(
        "select current_setting('lock_timeout') as timeout",
      )
      expect(timeout).toBe('0')
    } finally {
      await database.close()
    }
  })

  it('rolls back to exactly what 58 left, refuses a second run, and can be applied again', async () => {
    const [database, through58] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: MIGRATION_58 }),
    ])
    try {
      const fx = await seedFixture(database)
      const columns = (target: TestDatabase) =>
        target.asService(
          `select column_name, data_type, is_nullable, column_default
             from information_schema.columns
            where table_schema = 'public' and table_name = 'medication_schedule' order by 1`,
        )
      const triggers = (target: TestDatabase) =>
        target.asService(
          `select tgname from pg_trigger
            where tgrelid = 'public.medication_schedule'::regclass and not tgisinternal order by 1`,
        )
      const doses = () =>
        database.asService('select * from public.medication_log order by medication_log_id')
      const dosesBefore = await doses()

      await database.db.exec(await script(ROLLBACK_59))

      expect(await columns(database)).toEqual(await columns(through58))
      expect(await triggers(database)).toEqual(await triggers(through58))
      expect(await functionFacts(database)).toEqual(await functionFacts(through58))
      expect(await doses()).toEqual(dosesBefore)
      expect(
        await database.asService(
          `select 1 from pg_proc where proname = 'medication_schedule_stamp_reminders'`,
        ),
      ).toEqual([])

      await expect(database.db.exec(await script(ROLLBACK_59))).rejects.toThrow(
        /Migration 59 is not applied/,
      )

      // 53's down-script restores the reminder functions without the switch,
      // so it refuses while 59 is installed.
      await database.applyMigration(MIGRATION_59)
      await expect(database.db.exec(await script(ROLLBACK_53))).rejects.toThrow(
        /Roll back migration 59 first/,
      )
      await database.db.exec(await script(ROLLBACK_59))

      await database.applyMigration(MIGRATION_59)
      const rows = await database.asUser(
        fx.doctorAUserId,
        `update public.medication_schedule set medication_schedule_reminders_is_enabled = false
          where medication_schedule_id = $1 returning medication_schedule_id`,
        [fx.aliceScheduleId],
      )
      expect(rows).toHaveLength(1)
    } finally {
      await Promise.all([database.close(), through58.close()])
    }
  })
})
