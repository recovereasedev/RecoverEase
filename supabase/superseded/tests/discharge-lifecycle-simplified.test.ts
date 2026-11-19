import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 60: the care case has two statuses, Active and Discharged, and
 * the doctor alone moves between them. The "ready for discharge" flag and its
 * daily job are gone, and a discharged patient gets no reminders for the care
 * that ended. tests/db/discharge-reopen.test.ts covers who may discharge and
 * reopen, the history and the patient's check-ins.
 */

const MIGRATION_58 = '20260902100058'
const MIGRATION_59 = '20260902100059'
const MIGRATION_60 = '20260902100060'
const MIGRATION_60_FILE = 'supabase/migrations/20260902100060_simplify_discharge_lifecycle.sql'
const ROLLBACK_60 = 'supabase/rollbacks/20260902100060_simplify_discharge_lifecycle.down.sql'
const ROLLBACK_59 = 'supabase/rollbacks/20260902100059_medication_schedule_reminder_control.down.sql'
const ROLLBACK_57 = 'supabase/rollbacks/20260902100057_discharge_reopen_treatment_case.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')
/** What an operator does, after exporting them, before rollback 60 will run. */
const clearCarePlanLinks = async (database: TestDatabase) => {
  await database.asService('update public.prescription set treatment_plan_id = null where treatment_plan_id is not null')
  await database.asService('update public.appointment set treatment_plan_id = null where treatment_plan_id is not null')
}

const DISCHARGE = 'select * from public.doctor_discharge_treatment_plan($1, $2)'
const REOPEN = 'select * from public.doctor_reopen_treatment_plan($1)'

const READERS = [
  'public.dispatch_medication_reminders(integer)',
  'public.dispatch_medication_pre_dose_reminders()',
  'public.dispatch_appointment_reminders(integer)',
  'app_private.push_source_is_current(text, uuid, uuid, timestamptz, uuid)',
] as const

const readerFacts = (database: TestDatabase) =>
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
    [[...READERS]],
  )

describe('the two-status care case (migration 60)', () => {
  let database: TestDatabase
  let fx: Fixture
  let medicine: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await database.asService<{ n: number }>(sql, params))[0]!.n)
  const preDose = () => count('select public.dispatch_medication_pre_dose_reminders() as n')
  const followUp = () => count('select public.dispatch_medication_reminders(30) as n')
  const appointmentReminders = () => count('select public.dispatch_appointment_reminders(24) as n')
  const remindersFor = (doseId: string) =>
    count('select count(*) as n from public.notification where notification_medication_log_id = $1', [doseId])
  const appointmentRemindersFor = (appointmentId: string) =>
    count('select count(*) as n from public.notification where notification_appointment_id = $1', [appointmentId])

  /** A pending dose of Alice's medicine due `minutes` from now (negative: already due). */
  const dose = async (minutes: number) =>
    (await database.asService<{ id: string }>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + make_interval(mins => $2::int)) returning medication_log_id as id`,
      [medicine, minutes],
    ))[0]!.id
  /** An appointment for Alice `hours` from now, booked by `userId`. */
  const book = async (userId: string, hours: number) =>
    (await database.asUser<{ id: string; follow_up: string | null }>(
      userId,
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, now() + make_interval(hours => $3::int))
       returning appointment_id as id, appointment_follow_up_of_plan_id as follow_up`,
      [fx.alicePatId, fx.doctorAId, hours],
    ))[0]!
  const pushIsCurrent = async (event: string, doseId: string) =>
    (await database.asService<{ ok: boolean }>(
      `select app_private.push_source_is_current($1, ml.medication_log_id, null, ml.medication_log_scheduled_at, $3) as ok
         from public.medication_log ml where ml.medication_log_id = $2`,
      [event, doseId, fx.aliceUserId],
    ))[0]!.ok
  const appointmentPushIsCurrent = async (appointmentId: string) =>
    (await database.asService<{ ok: boolean }>(
      `select app_private.push_source_is_current('appointment_reminder', null, a.appointment_id, a.appointment_date, $2) as ok
         from public.appointment a where a.appointment_id = $1`,
      [appointmentId, fx.aliceUserId],
    ))[0]!.ok
  const planStatus = async () =>
    (await database.asService<{ s: string }>(
      'select treatment_plan_status::text as s from public.treatment_plan where treatment_plan_id = $1',
      [fx.alicePlanId],
    ))[0]!.s

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  // Each test starts with Alice's one plan active, one medicine with no
  // doses, no notifications, and every other appointment already reminded.
  beforeEach(async () => {
    if ((await planStatus()) === 'discharged') await asDoctorA(REOPEN, [fx.alicePlanId])
    // As if any earlier reopening were long ago, so it does not hold back a follow-up.
    await database.db.exec(
      `update public.treatment_plan_lifecycle_event set treatment_plan_changed_at = now() - interval '30 days'`,
    )
    await database.asService('delete from public.notification')
    await database.asService('delete from public.medication_schedule')
    await database.asService('update public.appointment set appointment_reminder_sent_at = now()')
    await database.asService(
      'update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null',
    )
    ;[{ id: medicine }] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times, medication_schedule_start_date)
       values ($1, 'Medicine A', '500mg', 1, '{08:00}'::time[], public.app_today() - 3)
       returning medication_schedule_id as id`,
      [fx.alicePrescriptionId],
    )
    await database.asService('delete from public.medication_log where medication_schedule_id = $1', [medicine])
  })

  describe('the status', () => {
    it('accepts only active and discharged, whoever writes', async () => {
      for (const status of ['draft', 'ready_for_discharge', 'completed', 'cancelled']) {
        await expect(
          database.asService(
            `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_status)
             values ($1, $2, 'Plan', $3::public.treatment_plan_status)`,
            [fx.alicePatId, fx.doctorAId, status],
          ),
        ).rejects.toThrow(/treatment_plan_status_valid/)
        await expect(
          database.asService(
            `update public.treatment_plan set treatment_plan_status = $2::public.treatment_plan_status
              where treatment_plan_id = $1`,
            [fx.alicePlanId, status],
          ),
        ).rejects.toThrow(/treatment_plan_status_valid/)
      }
      expect(await planStatus()).toBe('active')
    })

    it('has no readiness check left, and no job for one', async () => {
      expect(
        await database.asService(`select 1 from pg_proc where proname = 'mark_treatment_plans_ready_for_discharge'`),
      ).toEqual([])
      const migration = await script(MIGRATION_60_FILE)
      expect(migration).toMatch(/cron\.unschedule/)
      expect(migration).not.toMatch(/cron\.schedule/)
    })

    it('leaves a plan past its end date, with every goal achieved, active until the doctor discharges it', async () => {
      await database.asService(
        `update public.treatment_plan
            set treatment_plan_start_date = public.app_today() - 40, treatment_plan_end_date = public.app_today() - 5
          where treatment_plan_id = $1`,
        [fx.alicePlanId],
      )
      await database.asService(`update public.treatment_goal set treatment_goal_status = 'achieved' where treatment_plan_id = $1`, [
        fx.alicePlanId,
      ])
      await database.asService('select public.mark_missed_treatment_goals()')
      expect(await planStatus()).toBe('active')
      expect(await count(`select count(*) as n from public.notification where notification_type = 'treatment'`)).toBe(0)
    })

    it('keeps the discharge in the history, with its reason and time, when the case is reopened', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'transferred'])
      const [{ at }] = await database.asService<{ at: string }>(
        'select treatment_plan_discharged_at::text as at from public.treatment_plan where treatment_plan_id = $1',
        [fx.alicePlanId],
      )
      await asDoctorA(REOPEN, [fx.alicePlanId])

      expect(
        await database.asService(
          `select treatment_plan_status::text as status, treatment_plan_closure_reason as reason, treatment_plan_discharged_at as at
             from public.treatment_plan where treatment_plan_id = $1`,
          [fx.alicePlanId],
        ),
      ).toEqual([{ status: 'active', reason: null, at: null }])
      const history = await database.asService(
        `select treatment_plan_new_status::text as event, treatment_plan_closure_reason as reason,
                treatment_plan_changed_by as actor, treatment_plan_changed_at::text as at
           from public.treatment_plan_lifecycle_event
          where treatment_plan_id = $1
          order by treatment_plan_changed_at desc, treatment_plan_new_status::text limit 2`,
        [fx.alicePlanId],
      )
      expect(history).toEqual(
        expect.arrayContaining([
          { event: 'discharged', reason: 'transferred', actor: fx.doctorAUserId, at },
          { event: 'active', reason: null, actor: fx.doctorAUserId, at: expect.any(String) },
        ]),
      )
    })
  })

  describe('medication reminders', () => {
    it('reminds an active case as before', async () => {
      const soon = await dose(5)
      const overdue = await dose(-40)
      expect(await preDose()).toBe(1)
      expect(await followUp()).toBe(1)
      expect(await remindersFor(soon)).toBe(1)
      expect(await remindersFor(overdue)).toBe(1)
    })

    it('sends none once the case is discharged, and marks no dose as reminded', async () => {
      const soon = await dose(5)
      const overdue = await dose(-40)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])

      expect(await preDose()).toBe(0)
      expect(await followUp()).toBe(0)
      expect(await count('select count(*) as n from public.notification where user_id = $1', [fx.aliceUserId])).toBe(0)
      expect(
        await count(
          `select count(*) as n from public.medication_log
            where medication_log_pre_dose_sent_at is not null or medication_log_follow_up_sent_at is not null`,
        ),
      ).toBe(0)
      // The doses themselves are untouched.
      expect(
        await database.asService(
          `select medication_log_status::text as status from public.medication_log where medication_log_id = any($1::uuid[])`,
          [[soon, overdue]],
        ),
      ).toEqual([{ status: 'pending' }, { status: 'pending' }])
    })

    it('drops a phone reminder still waiting when the case is discharged, and accepts one again once reopened', async () => {
      const id = await dose(5)
      expect(await pushIsCurrent('medication_pre_dose', id)).toBe(true)
      expect(await pushIsCurrent('medication_follow_up', id)).toBe(true)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'withdrew'])
      expect(await pushIsCurrent('medication_pre_dose', id)).toBe(false)
      expect(await pushIsCurrent('medication_follow_up', id)).toBe(false)
      await asDoctorA(REOPEN, [fx.alicePlanId])
      expect(await pushIsCurrent('medication_pre_dose', id)).toBe(true)
    })

    it('keeps a medicine the doctor switched off silent, discharged or reopened', async () => {
      await asDoctorA(
        'update public.medication_schedule set medication_schedule_reminders_is_enabled = false where medication_schedule_id = $1',
        [medicine],
      )
      await dose(5)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'referred'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      expect(await preDose()).toBe(0)
      expect(await followUp()).toBe(0)
    })

    it('does not chase, on reopening, the doses that came due before it', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'lost_to_follow_up'])
      const whileClosed = [await dose(-40), await dose(-200)]
      await asDoctorA(REOPEN, [fx.alicePlanId])

      expect(await followUp()).toBe(0)
      for (const id of whileClosed) expect(await remindersFor(id)).toBe(0)
    })

    it('resumes with the doses due after the reopening, once each', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'lost_to_follow_up'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      // As if the case had been reopened two hours ago.
      await database.db.exec(
        `update public.treatment_plan_lifecycle_event set treatment_plan_changed_at = now() - interval '2 hours'
          where treatment_plan_changed_at > now() - interval '1 day'`,
      )
      const before = await dose(-200)
      const after = await dose(-40)
      const ahead = await dose(5)

      expect(await followUp()).toBe(1)
      expect(await followUp()).toBe(0)
      expect(await preDose()).toBe(1)
      expect(await preDose()).toBe(0)
      expect(await remindersFor(before)).toBe(0)
      expect(await remindersFor(after)).toBe(1)
      expect(await remindersFor(ahead)).toBe(1)
    })

    it('makes no new dose and changes none when the case is discharged and reopened', async () => {
      await dose(5)
      await dose(-40)
      const doses = () => database.asService('select * from public.medication_log order by medication_log_id')
      const before = await doses()
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      expect(await doses()).toEqual(before)
      // The slot job, run again, adds nothing that is already there.
      await database.asService('select public.extend_all_medication_log_slots(30)')
      const once = await doses()
      await database.asService('select public.extend_all_medication_log_slots(30)')
      expect(await doses()).toEqual(once)
    })

    it('still reminds a patient who has no care plan at all', async () => {
      const [{ id: bobPrescription }] = await database.asService<{ id: string }>(
        `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning prescription_id as id`,
        [fx.bobPatId, fx.doctorAId],
      )
      const [{ id: bobMedicine }] = await database.asService<{ id: string }>(
        `insert into public.medication_schedule
           (prescription_id, medication_schedule_name, medication_schedule_dosage,
            medication_schedule_frequency, medication_schedule_times, medication_schedule_start_date)
         values ($1, 'Medicine B', '5mg', 1, '{08:00}'::time[], public.app_today() - 3)
         returning medication_schedule_id as id`,
        [bobPrescription],
      )
      await database.asService('delete from public.medication_log where medication_schedule_id = $1', [bobMedicine])
      await database.asService(
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         values ($1, now() + interval '5 minutes')`,
        [bobMedicine],
      )
      expect(await preDose()).toBe(1)
    })
  })

  describe('appointments', () => {
    it('sends no reminder for an appointment of the care that ended, and none later for the time it was closed', async () => {
      const { id, follow_up } = await book(fx.aliceUserId, 3)
      expect(follow_up).toBeNull()
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])

      expect(await appointmentPushIsCurrent(id)).toBe(false)
      expect(await appointmentReminders()).toBe(0)
      expect(await appointmentRemindersFor(id)).toBe(0)
      // The appointment itself is untouched.
      expect(
        await database.asService('select appointment_status::text as status from public.appointment where appointment_id = $1', [id]),
      ).toEqual([{ status: 'scheduled' }])
    })

    it('lets a discharged patient book, marks it a follow-up request, and reminds about it', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      const { id, follow_up } = await book(fx.aliceUserId, 3)
      expect(follow_up).toBe(fx.alicePlanId)

      expect(await appointmentPushIsCurrent(id)).toBe(true)
      expect(await appointmentReminders()).toBe(2) // the doctor's and the patient's
      expect(await appointmentRemindersFor(id)).toBe(2)
      expect(await appointmentReminders()).toBe(0)
    })

    it('keeps the follow-up mark when the case is reopened, and marks nothing booked while it is active', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      const followUp = await book(fx.aliceUserId, 30)
      await asDoctorA(REOPEN, [fx.alicePlanId])
      const duringCare = await book(fx.aliceUserId, 31)

      expect(
        await asDoctorA(
          `select appointment_id as id, appointment_follow_up_of_plan_id as follow_up from public.appointment
            where appointment_id = any($1::uuid[]) order by appointment_date`,
          [[followUp.id, duringCare.id]],
        ),
      ).toEqual([
        { id: followUp.id, follow_up: fx.alicePlanId },
        { id: duringCare.id, follow_up: null },
      ])
    })

    it('reminds again, once, about a still-upcoming appointment after the case is reopened', async () => {
      const { id } = await book(fx.aliceUserId, 3)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      expect(await appointmentReminders()).toBe(0)
      await asDoctorA(REOPEN, [fx.alicePlanId])
      expect(await appointmentReminders()).toBe(2)
      expect(await appointmentReminders()).toBe(0)
      expect(await appointmentRemindersFor(id)).toBe(2)
    })

    it('still lets a discharged patient cancel and ask to move an appointment', async () => {
      const { id } = await book(fx.aliceUserId, 72)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      const rows = await asAlice(
        `update public.appointment set appointment_status = 'cancelled' where appointment_id = $1 returning appointment_id`,
        [id],
      )
      expect(rows).toHaveLength(1)
    })
  })
})

/**
 * Each prescription and appointment belongs to one care plan (migration 60),
 * so one plan's discharge stops that plan's reminders and no other's.
 */
describe('reminders follow their own care plan (migration 60)', () => {
  let database: TestDatabase
  let fx: Fixture
  let planB: string
  let prescriptionA: string
  let prescriptionB: string
  let medicineA: string
  let medicineB: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await database.asService<{ n: number }>(sql, params))[0]!.n)
  const preDose = () => count('select public.dispatch_medication_pre_dose_reminders() as n')
  const followUp = () => count('select public.dispatch_medication_reminders(30) as n')
  const appointmentReminders = () => count('select public.dispatch_appointment_reminders(24) as n')
  const remindersFor = (doseId: string) =>
    count('select count(*) as n from public.notification where notification_medication_log_id = $1', [doseId])
  const appointmentRemindersFor = (appointmentId: string) =>
    count('select count(*) as n from public.notification where notification_appointment_id = $1', [appointmentId])

  const newPlan = async (patId: string) =>
    (await database.asService<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title) values ($1, $2, 'Second plan')
       returning treatment_plan_id as id`,
      [patId, fx.doctorAId],
    ))[0]!.id
  const newMedicine = async (prescriptionId: string, name: string) => {
    const [{ id }] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times, medication_schedule_start_date)
       values ($1, $2, '500mg', 1, '{08:00}'::time[], public.app_today() - 3)
       returning medication_schedule_id as id`,
      [prescriptionId, name],
    )
    await database.asService('delete from public.medication_log where medication_schedule_id = $1', [id])
    return id
  }
  const dose = async (scheduleId: string, minutes: number) =>
    (await database.asService<{ id: string }>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + make_interval(mins => $2::int)) returning medication_log_id as id`,
      [scheduleId, minutes],
    ))[0]!.id
  /** An appointment of Alice's `hours` from now, as the service, on the plan given. */
  const appointmentOn = async (planId: string | null, hours: number) =>
    (await database.asService<{ id: string }>(
      `insert into public.appointment (pat_id, doc_id, appointment_date, treatment_plan_id)
       values ($1, $2, now() + make_interval(hours => $3::int), $4) returning appointment_id as id`,
      [fx.alicePatId, fx.doctorAId, hours, planId],
    ))[0]!.id
  const pushIsCurrent = async (event: string, doseId: string) =>
    (await database.asService<{ ok: boolean }>(
      `select app_private.push_source_is_current($1, ml.medication_log_id, null, ml.medication_log_scheduled_at, $3) as ok
         from public.medication_log ml where ml.medication_log_id = $2`,
      [event, doseId, fx.aliceUserId],
    ))[0]!.ok
  const appointmentPushIsCurrent = async (appointmentId: string) =>
    (await database.asService<{ ok: boolean }>(
      `select app_private.push_source_is_current('appointment_reminder', null, a.appointment_id, a.appointment_date, $2) as ok
         from public.appointment a where a.appointment_id = $1`,
      [appointmentId, fx.aliceUserId],
    ))[0]!.ok
  /** As if the plan's latest lifecycle event happened `hours` ago. */
  const backdateEvents = (planId: string, hours: number) =>
    database.db.exec(
      `update public.treatment_plan_lifecycle_event
          set treatment_plan_changed_at = now() - interval '${hours} hours'
        where treatment_plan_id = '${planId}'`,
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  // Alice has plan A (the fixture's, active) and plan B (active), with one
  // prescription and one medicine on each; nothing reminded yet.
  beforeEach(async () => {
    await database.asService('delete from public.notification')
    await database.asService('delete from app_private.push_delivery')
    await database.asService('delete from app_private.push_subscription')
    await database.asService('delete from public.medication_schedule')
    await database.asService('delete from public.treatment_plan where pat_id = $1 and treatment_plan_id <> $2', [
      fx.alicePatId,
      fx.alicePlanId,
    ])
    await database.asService('delete from public.treatment_plan where pat_id = $1', [fx.bobPatId])
    if (
      (await database.asService<{ s: string }>(
        'select treatment_plan_status::text as s from public.treatment_plan where treatment_plan_id = $1',
        [fx.alicePlanId],
      ))[0]!.s === 'discharged'
    ) {
      await asDoctorA(REOPEN, [fx.alicePlanId])
    }
    await database.db.exec(
      `update public.treatment_plan_lifecycle_event set treatment_plan_changed_at = now() - interval '30 days'`,
    )
    await database.asService('update public.appointment set appointment_reminder_sent_at = now()')
    await database.asService('update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null')

    planB = await newPlan(fx.alicePatId)
    prescriptionA = fx.alicePrescriptionId
    ;[{ id: prescriptionB }] = await database.asService<{ id: string }>(
      `insert into public.prescription (pat_id, doc_id, treatment_plan_id) values ($1, $2, $3) returning prescription_id as id`,
      [fx.alicePatId, fx.doctorAId, planB],
    )
    medicineA = await newMedicine(prescriptionA, 'Medicine A')
    medicineB = await newMedicine(prescriptionB, 'Medicine B')
  })

  describe('which plan a prescription or appointment belongs to', () => {
    it('links the fixture’s prescription and appointment to the patient’s one plan', async () => {
      expect(
        await database.asService(
          `select (select treatment_plan_id from public.prescription where prescription_id = $1) as prescription,
                  (select treatment_plan_id from public.appointment where appointment_id = $2) as appointment`,
          [fx.alicePrescriptionId, fx.aliceAppointmentId],
        ),
      ).toEqual([{ prescription: fx.alicePlanId, appointment: fx.alicePlanId }])
    })

    it('makes the doctor choose the plan once the patient has two active ones, and keeps the choice', async () => {
      await expect(
        asDoctorA(`insert into public.prescription (pat_id, doc_id) values ($1, $2)`, [fx.alicePatId, fx.doctorAId]),
      ).rejects.toThrow(/Choose which care plan/)
      const [row] = await asDoctorA<{ plan: string }>(
        `insert into public.prescription (pat_id, doc_id, treatment_plan_id) values ($1, $2, $3)
         returning treatment_plan_id as plan`,
        [fx.alicePatId, fx.doctorAId, planB],
      )
      expect(row!.plan).toBe(planB)
    })

    it('makes the patient choose the plan when booking with two active ones', async () => {
      await expect(
        asAlice(`insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '5 days')`, [
          fx.alicePatId,
          fx.doctorAId,
        ]),
      ).rejects.toThrow(/Choose which care plan/)
      const [row] = await asAlice<{ plan: string; follow_up: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date, treatment_plan_id)
         values ($1, $2, now() + interval '5 days', $3)
         returning treatment_plan_id as plan, appointment_follow_up_of_plan_id as follow_up`,
        [fx.alicePatId, fx.doctorAId, planB],
      )
      expect(row).toEqual({ plan: planB, follow_up: null })
    })

    it('fills in the plan by itself when the patient has exactly one active plan', async () => {
      await asDoctorA(DISCHARGE, [planB, 'transferred'])
      const [prescription] = await asDoctorA<{ plan: string }>(
        `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning treatment_plan_id as plan`,
        [fx.alicePatId, fx.doctorAId],
      )
      const [appointment] = await asAlice<{ plan: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '6 days')
         returning treatment_plan_id as plan`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect([prescription!.plan, appointment!.plan]).toEqual([fx.alicePlanId, fx.alicePlanId])
    })

    it('refuses another patient’s plan, from anyone', async () => {
      const carolPlan = fx.carolPlanId
      await expect(
        asDoctorA(`insert into public.prescription (pat_id, doc_id, treatment_plan_id) values ($1, $2, $3)`, [
          fx.alicePatId,
          fx.doctorAId,
          carolPlan,
        ]),
      ).rejects.toThrow(/another patient/)
      await expect(
        database.asService(`insert into public.prescription (pat_id, doc_id, treatment_plan_id) values ($1, $2, $3)`, [
          fx.alicePatId,
          fx.doctorAId,
          carolPlan,
        ]),
      ).rejects.toThrow(/another patient/)
      await expect(
        asAlice(
          `insert into public.appointment (pat_id, doc_id, appointment_date, treatment_plan_id)
           values ($1, $2, now() + interval '5 days', $3)`,
          [fx.alicePatId, fx.doctorAId, carolPlan],
        ),
      ).rejects.toThrow(/another patient/)
      await expect(
        database.asService(`update public.appointment set treatment_plan_id = $2 where appointment_id = $1`, [
          fx.aliceAppointmentId,
          carolPlan,
        ]),
      ).rejects.toThrow(/another patient/)
    })

    describe('a link always names a plan of the row’s own patient', () => {
      const prescriptionRow = (id: string) =>
        database.asService('select * from public.prescription where prescription_id = $1', [id])
      const appointmentRow = (id: string) =>
        database.asService('select * from public.appointment where appointment_id = $1', [id])
      const planRow = (id: string) =>
        database.asService('select * from public.treatment_plan where treatment_plan_id = $1', [id])

      it('refuses moving a linked prescription to another patient while its plan stays, and changes nothing', async () => {
        const before = await prescriptionRow(prescriptionB)
        await expect(
          database.asService('update public.prescription set pat_id = $2 where prescription_id = $1', [prescriptionB, fx.bobPatId]),
        ).rejects.toThrow(/another patient|treatment_plan_same_patient/)
        expect(await prescriptionRow(prescriptionB)).toEqual(before)
      })

      it('refuses moving a linked appointment to another patient while its plan stays, and changes nothing', async () => {
        const onB = await appointmentOn(planB, 30)
        const before = await appointmentRow(onB)
        await expect(
          database.asService('update public.appointment set pat_id = $2 where appointment_id = $1', [onB, fx.bobPatId]),
        ).rejects.toThrow(/another patient|treatment_plan_same_patient/)
        expect(await appointmentRow(onB)).toEqual(before)
      })

      it('refuses giving a plan to another patient while a prescription or appointment is linked to it, and changes nothing', async () => {
        // Plan B has prescription B linked.
        const planBBefore = await planRow(planB)
        await expect(
          database.asService('update public.treatment_plan set pat_id = $2 where treatment_plan_id = $1', [planB, fx.bobPatId]),
        ).rejects.toThrow(/treatment_plan_same_patient/)
        expect(await planRow(planB)).toEqual(planBBefore)

        // A plan with only an appointment linked.
        const planC = await newPlan(fx.alicePatId)
        const onC = await appointmentOn(planC, 31)
        const planCBefore = await planRow(planC)
        const appointmentBefore = await appointmentRow(onC)
        await expect(
          database.asService('update public.treatment_plan set pat_id = $2 where treatment_plan_id = $1', [planC, fx.bobPatId]),
        ).rejects.toThrow(/treatment_plan_same_patient/)
        expect(await planRow(planC)).toEqual(planCBefore)
        expect(await appointmentRow(onC)).toEqual(appointmentBefore)
      })

      it('still lets the service role place a row by hand on its own patient’s plan, and move a row with its plan', async () => {
        // A legacy row on no plan, placed by hand on the same patient's plan.
        const [{ id: legacy }] = await database.asService<{ id: string }>(
          `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning prescription_id as id`,
          [fx.alicePatId, fx.doctorAId],
        )
        await database.asService('update public.prescription set treatment_plan_id = $2 where prescription_id = $1', [legacy, planB])
        expect((await prescriptionRow(legacy))[0]).toMatchObject({ treatment_plan_id: planB })

        // A correction that moves the patient and the plan together stays consistent.
        const bobPlan = await newPlan(fx.bobPatId)
        await database.asService('update public.prescription set pat_id = $2, treatment_plan_id = $3 where prescription_id = $1', [
          legacy,
          fx.bobPatId,
          bobPlan,
        ])
        expect((await prescriptionRow(legacy))[0]).toMatchObject({ pat_id: fx.bobPatId, treatment_plan_id: bobPlan })

        // A row on no plan, and a plan nothing is linked to, are not held back.
        await database.asService('update public.prescription set treatment_plan_id = null, pat_id = $2 where prescription_id = $1', [
          legacy,
          fx.alicePatId,
        ])
        await database.asService('update public.treatment_plan set pat_id = $2 where treatment_plan_id = $1', [bobPlan, fx.alicePatId])
        expect((await planRow(bobPlan))[0]).toMatchObject({ pat_id: fx.alicePatId })
        await database.asService('delete from public.prescription where prescription_id = $1', [legacy])
      })

      it('sets only the link to null, not the patient, when a linked plan is deleted', async () => {
        const planC = await newPlan(fx.alicePatId)
        const onC = await appointmentOn(planC, 32)
        await database.asService('delete from public.treatment_plan where treatment_plan_id = $1', [planC])
        expect((await appointmentRow(onC))[0]).toMatchObject({ pat_id: fx.alicePatId, treatment_plan_id: null })
      })
    })

    it('refuses a discharged plan for a new prescription or appointment', async () => {
      await asDoctorA(DISCHARGE, [planB, 'withdrew'])
      await expect(
        asDoctorA(`insert into public.prescription (pat_id, doc_id, treatment_plan_id) values ($1, $2, $3)`, [
          fx.alicePatId,
          fx.doctorAId,
          planB,
        ]),
      ).rejects.toThrow(/active care plan/)
      await expect(
        asAlice(
          `insert into public.appointment (pat_id, doc_id, appointment_date, treatment_plan_id)
           values ($1, $2, now() + interval '5 days', $3)`,
          [fx.alicePatId, fx.doctorAId, planB],
        ),
      ).rejects.toThrow(/active care plan/)
    })

    it('lets no session move a prescription or appointment to another plan', async () => {
      await expect(
        asDoctorA(`update public.prescription set treatment_plan_id = $2 where prescription_id = $1`, [prescriptionA, planB]),
      ).rejects.toThrow(/care plan is set when/)
      await expect(
        asAlice(`update public.appointment set treatment_plan_id = $2 where appointment_id = $1`, [fx.aliceAppointmentId, planB]),
      ).rejects.toThrow(/care plan is set when/)
    })

    it('books a follow-up request, on no plan, once every plan is discharged', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      await asDoctorA(DISCHARGE, [planB, 'completed_recovery'])
      const [row] = await asAlice<{ plan: string | null; follow_up: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '3 hours')
         returning treatment_plan_id as plan, appointment_follow_up_of_plan_id as follow_up`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect(row!.plan).toBeNull()
      expect([fx.alicePlanId, planB]).toContain(row!.follow_up)
    })
  })

  describe('one plan discharged, the other active', () => {
    it('stops the discharged plan’s medicine and keeps the active plan’s', async () => {
      const soonA = await dose(medicineA, 5)
      const soonB = await dose(medicineB, 5)
      const lateA = await dose(medicineA, -40)
      const lateB = await dose(medicineB, -40)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'transferred'])

      expect(await preDose()).toBe(1)
      expect(await followUp()).toBe(1)
      expect(await remindersFor(soonA)).toBe(0)
      expect(await remindersFor(lateA)).toBe(0)
      expect(await remindersFor(soonB)).toBe(1)
      expect(await remindersFor(lateB)).toBe(1)
      expect(await pushIsCurrent('medication_pre_dose', soonA)).toBe(false)
      expect(await pushIsCurrent('medication_pre_dose', soonB)).toBe(true)
    })

    it('stops the discharged plan’s appointment and keeps the active plan’s', async () => {
      const onA = await appointmentOn(fx.alicePlanId, 3)
      const onB = await appointmentOn(planB, 4)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'transferred'])

      expect(await appointmentPushIsCurrent(onA)).toBe(false)
      expect(await appointmentPushIsCurrent(onB)).toBe(true)
      expect(await appointmentReminders()).toBe(2) // B's, to the doctor and the patient
      expect(await appointmentRemindersFor(onA)).toBe(0)
      expect(await appointmentRemindersFor(onB)).toBe(2)
    })

    it('keeps reminding about a follow-up request whatever happens to the plans', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      await asDoctorA(DISCHARGE, [planB, 'completed_recovery'])
      const [{ id }] = await asAlice<{ id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '3 hours')
         returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      await asDoctorA(REOPEN, [planB])
      expect(await appointmentPushIsCurrent(id)).toBe(true)
      expect(await appointmentReminders()).toBe(2)
      expect(await appointmentRemindersFor(id)).toBe(2)
    })

    it('reopening one plan leaves the other plan’s reminders as they were', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'lost_to_follow_up'])
      // B's dose came due an hour ago, while A was closed; B was open throughout.
      const lateB = await dose(medicineB, -60)
      const lateA = await dose(medicineA, -60)
      await asDoctorA(REOPEN, [fx.alicePlanId])

      expect(await followUp()).toBe(1)
      expect(await remindersFor(lateB)).toBe(1)
      // A's came due before A was reopened: not chased.
      expect(await remindersFor(lateA)).toBe(0)
    })

    it('chases an active plan’s doses due after its own reopening, once each', async () => {
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'lost_to_follow_up'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      await backdateEvents(fx.alicePlanId, 2)
      const before = await dose(medicineA, -200)
      const after = await dose(medicineA, -40)
      expect(await followUp()).toBe(1)
      expect(await followUp()).toBe(0)
      expect(await remindersFor(before)).toBe(0)
      expect(await remindersFor(after)).toBe(1)
    })

  })

  // A row on no plan while the patient has plans (from before 60, for a
  // patient with several plans) could be any plan's: it fails closed.
  describe('a legacy prescription or appointment on no plan', () => {
    /** As the service, with both plans active, so the trigger leaves it on no plan. */
    const legacyPrescription = async () =>
      (await database.asService<{ id: string; plan: string | null }>(
        `insert into public.prescription (pat_id, doc_id) values ($1, $2)
         returning prescription_id as id, treatment_plan_id as plan`,
        [fx.alicePatId, fx.doctorAId],
      ))[0]!

    it('gets no medicine reminder, discharged plan A and active plan B, until it is placed on a plan by hand', async () => {
      const legacy = await legacyPrescription()
      expect(legacy.plan).toBeNull()
      const legacyMedicine = await newMedicine(legacy.id, 'Legacy medicine')
      const soonLegacy = await dose(legacyMedicine, 5)
      const lateLegacy = await dose(legacyMedicine, -40)
      const soonA = await dose(medicineA, 5)
      const soonB = await dose(medicineB, 5)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'transferred'])

      expect(await preDose()).toBe(1)
      expect(await followUp()).toBe(0)
      expect(await remindersFor(soonA)).toBe(0) // A's medicine: its plan is discharged
      expect(await remindersFor(soonB)).toBe(1) // B's medicine: its plan is active
      expect(await remindersFor(soonLegacy)).toBe(0) // on no plan: B being active proves nothing
      expect(await remindersFor(lateLegacy)).toBe(0)
      expect(await pushIsCurrent('medication_pre_dose', soonLegacy)).toBe(false)
      expect(await pushIsCurrent('medication_follow_up', lateLegacy)).toBe(false)
      // Nothing is deleted.
      expect(await count('select count(*) as n from public.medication_log where medication_schedule_id = $1', [legacyMedicine])).toBe(2)

      // Placed on plan B by hand (the service role, with approval): reminded from then on.
      await database.asService('update public.prescription set treatment_plan_id = $2 where prescription_id = $1', [
        legacy.id,
        planB,
      ])
      expect(await preDose()).toBe(1)
      expect(await remindersFor(soonLegacy)).toBe(1)
      expect(await followUp()).toBe(1)
      expect(await remindersFor(lateLegacy)).toBe(1)
    })

    it('gets no medicine reminder even while every plan of the patient is active', async () => {
      const legacy = await legacyPrescription()
      await dose(await newMedicine(legacy.id, 'Legacy medicine'), 5)
      expect(await preDose()).toBe(0)
    })

    it('gets no ordinary appointment reminder, while a follow-up request still does', async () => {
      const legacy = await appointmentOn(null, 3)
      const onB = await appointmentOn(planB, 4)
      expect(
        await database.asService('select treatment_plan_id as plan from public.appointment where appointment_id = $1', [legacy]),
      ).toEqual([{ plan: null }])
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'transferred'])
      expect(await appointmentPushIsCurrent(legacy)).toBe(false)
      expect(await appointmentPushIsCurrent(onB)).toBe(true)
      expect(await appointmentReminders()).toBe(2) // B's only
      expect(await appointmentRemindersFor(legacy)).toBe(0)

      await asDoctorA(DISCHARGE, [planB, 'transferred'])
      const [{ id: followUpRequest }] = await asAlice<{ id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '5 hours')
         returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect(await appointmentPushIsCurrent(followUpRequest)).toBe(true)
      expect(await appointmentReminders()).toBe(2)
      expect(await appointmentRemindersFor(followUpRequest)).toBe(2)
      expect(await appointmentRemindersFor(legacy)).toBe(0)
    })

    it('never lets a plan speak for another patient’s row', async () => {
      const allowed = async (planId: string, patId: string) =>
        (await database.asService<{ ok: boolean }>('select app_private.care_reminders_allowed($1, $2) as ok', [planId, patId]))[0]!.ok
      expect(await allowed(fx.alicePlanId, fx.alicePatId)).toBe(true)
      // Carol's plan is active, but it is not Alice's.
      expect(await allowed(fx.carolPlanId, fx.alicePatId)).toBe(false)
      expect(await allowed(planB, fx.bobPatId)).toBe(false)
    })
  })

  describe('a phone reminder queued before a discharge', () => {
    const register = () =>
      asAlice(`select public.register_push_subscription($1, $2, $3, 'Android Chrome')`, [
        'https://fcm.googleapis.com/fcm/send/device-token-000060:APA91b',
        'B' + 'A'.repeat(86),
        'abcdefghijklmnopqrstuv',
      ])
    const claim = () =>
      database.asService<{ push_kind: string }>('select * from public.claim_push_deliveries(50)')
    const deliveries = () =>
      database.asService<{ source_event: string; delivery_status: string; last_error_code: string | null }>(
        `select source_event, delivery_status, last_error_code from app_private.push_delivery order by delivery_created_at`,
      )

    it('is skipped for good when the plan is discharged and reopened before it is delivered', async () => {
      await register()
      const late = await dose(medicineA, -45)
      expect(await followUp()).toBe(1)
      expect(await deliveries()).toEqual([{ source_event: 'medication_follow_up', delivery_status: 'pending', last_error_code: null }])

      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'withdrew'])
      await asDoctorA(REOPEN, [fx.alicePlanId])

      expect(await claim()).toEqual([])
      expect(await deliveries()).toEqual([
        { source_event: 'medication_follow_up', delivery_status: 'skipped', last_error_code: 'source_no_longer_valid' },
      ])
      expect(await claim()).toEqual([])
      expect(await remindersFor(late)).toBe(1) // the one written before; none again
      expect(await followUp()).toBe(0)
    })

    it('still delivers a reminder for a dose still to come after the reopening', async () => {
      await register()
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'withdrew'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      await dose(medicineA, 5)
      expect(await preDose()).toBe(1)
      expect((await claim()).map((row) => row.push_kind)).toEqual(['medication_reminder'])
    })

    it('is skipped for good when it is for a medicine on no plan and the patient has a plan', async () => {
      // Queued while Bob had no care plan at all (reminded as before 60)...
      await database.asUser(fx.bobUserId, `select public.register_push_subscription($1, $2, $3, 'Android Chrome')`, [
        'https://fcm.googleapis.com/fcm/send/device-token-000061:APA91b',
        'B' + 'A'.repeat(86),
        'abcdefghijklmnopqrstuv',
      ])
      const [{ id: bobPrescription }] = await database.asService<{ id: string }>(
        `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning prescription_id as id`,
        [fx.bobPatId, fx.doctorAId],
      )
      const late = await dose(await newMedicine(bobPrescription, 'Legacy medicine'), -45)
      expect(await followUp()).toBe(1)
      expect(await deliveries()).toEqual([{ source_event: 'medication_follow_up', delivery_status: 'pending', last_error_code: null }])

      // ...then Bob is given a plan: nothing says the medicine is on it.
      await newPlan(fx.bobPatId)
      expect(await claim()).toEqual([])
      expect(await deliveries()).toEqual([
        { source_event: 'medication_follow_up', delivery_status: 'skipped', last_error_code: 'source_no_longer_valid' },
      ])
      expect(await claim()).toEqual([])
      expect(await remindersFor(late)).toBe(1) // the one already written stays
    })

    it('leaves the other plan’s queued reminder to be delivered', async () => {
      await register()
      await dose(medicineB, -45)
      expect(await followUp()).toBe(1)
      await asDoctorA(DISCHARGE, [fx.alicePlanId, 'withdrew'])
      await asDoctorA(REOPEN, [fx.alicePlanId])
      expect((await claim()).map((row) => row.push_kind)).toEqual(['medication_reminder'])
    })
  })
})

describe('migration 60 and the reminder jobs', () => {
  it('keeps each reminder function as it was, but for the lines that ask whether care is open', async () => {
    const [before, after] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_59 }),
      createTestDatabase({ stopAfter: MIGRATION_60 }),
    ])
    try {
      const was = await readerFacts(before)
      const is = await readerFacts(after)
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
      const withoutNewLines = (definition: unknown) =>
        String(definition)
          .split('\n')
          .filter((line) => !/app_private\.care_|-- \(60\)/.test(line))
          .join('\n')
      for (const [index, fact] of is.entries()) {
        expect(fact['definition']).toContain('app_private.care_reminders_allowed')
        expect(withoutNewLines(fact['definition'])).toBe(String(was[index]!['definition']))
      }
    } finally {
      await Promise.all([before.close(), after.close()])
    }
  })
})

describe('migration 60 on existing data, and its rollback', () => {
  it('makes a plan ready for discharge active, keeps a discharged one, and changes nothing else', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_59 })
    try {
      const fx = await seedFixture(database)
      await database.asUser(fx.doctorAUserId, DISCHARGE, [fx.alicePlanId, 'referred'])
      await database.asService(
        `update public.treatment_plan set treatment_plan_status = 'ready_for_discharge' where treatment_plan_id = $1`,
        [fx.carolPlanId],
      )
      const others = () =>
        database.asService(
          `select to_jsonb(tp) - 'treatment_plan_updated_at' as row from public.treatment_plan tp
            where treatment_plan_id <> $1 order by treatment_plan_id`,
          [fx.carolPlanId],
        )
      const records = () =>
        database.asService(
          `select (select count(*) from public.medication_log)::int as doses,
                  (select count(*) from public.recovery_log)::int as logs,
                  (select count(*) from public.appointment)::int as appointments,
                  (select count(*) from public.notification)::int as notifications`,
        )
      const before = { others: await others(), records: await records() }

      await database.applyMigration(MIGRATION_60)

      expect({ others: await others(), records: await records() }).toEqual(before)
      expect(
        await database.asService(
          `select treatment_plan_id as id, treatment_plan_status::text as status, treatment_plan_closure_reason as reason
             from public.treatment_plan where treatment_plan_id = any($1::uuid[]) order by treatment_plan_status::text`,
          [[fx.alicePlanId, fx.carolPlanId]],
        ),
      ).toEqual([
        { id: fx.carolPlanId, status: 'active', reason: null },
        { id: fx.alicePlanId, status: 'discharged', reason: 'referred' },
      ])
      const [{ timeout }] = await database.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')
    } finally {
      await database.close()
    }
  })

  it('links existing prescriptions and appointments only where the patient has one plan, and never a follow-up request', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_59 })
    try {
      const fx = await seedFixture(database)
      // Alice: one plan, then discharged, then a follow-up request booked.
      await database.asUser(fx.doctorAUserId, DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      const [{ id: followUp }] = await database.asUser<{ id: string }>(
        fx.aliceUserId,
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '9 days')
         returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      // Bob: two plans, so his prescription and appointment cannot be placed.
      for (const title of ['First', 'Second']) {
        await database.asService(
          `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title) values ($1, $2, $3)`,
          [fx.bobPatId, fx.doctorAId, title],
        )
      }
      const [{ id: bobPrescription }] = await database.asService<{ id: string }>(
        `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning prescription_id as id`,
        [fx.bobPatId, fx.doctorAId],
      )
      const [{ id: bobAppointment }] = await database.asService<{ id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '8 days')
         returning appointment_id as id`,
        [fx.bobPatId, fx.doctorAId],
      )

      await database.applyMigration(MIGRATION_60)

      const plan = async (table: 'prescription' | 'appointment', id: string) =>
        (await database.asService<{ plan: string | null }>(
          `select treatment_plan_id as plan from public.${table} where ${table}_id = $1`,
          [id],
        ))[0]!.plan
      expect(await plan('prescription', fx.alicePrescriptionId)).toBe(fx.alicePlanId)
      expect(await plan('appointment', fx.aliceAppointmentId)).toBe(fx.alicePlanId)
      expect(await plan('appointment', fx.carolAppointmentId)).toBe(fx.carolPlanId)
      expect(await plan('appointment', followUp)).toBeNull()
      expect(await plan('prescription', bobPrescription)).toBeNull()
      expect(await plan('appointment', bobAppointment)).toBeNull()
    } finally {
      await database.close()
    }
  })

  it('refuses, changing nothing, without migration 59', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_58 })
    try {
      await seedFixture(database)
      await expect(database.applyMigration(MIGRATION_60)).rejects.toThrow(/Migration 59 is not applied/)
      expect(
        await database.asService(`select 1 from pg_proc where proname = 'mark_treatment_plans_ready_for_discharge'`),
      ).toHaveLength(1)
      expect(
        await database.asService(
          `select 1 from information_schema.columns where table_name = 'prescription' and column_name = 'treatment_plan_id'`,
        ),
      ).toEqual([])
      expect(await database.asService(`select 1 from pg_constraint where conname = 'treatment_plan_status_valid'`)).toEqual([])
    } finally {
      await database.close()
    }
  })

  it('refuses, changing nothing, while a plan has a status it has no rule for', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_59 })
    try {
      const fx = await seedFixture(database)
      await database.asService(`update public.treatment_plan set treatment_plan_status = 'completed' where treatment_plan_id = $1`, [
        fx.carolPlanId,
      ])
      await expect(database.applyMigration(MIGRATION_60)).rejects.toThrow(/draft, completed or cancelled/)
      expect(
        await database.asService(`select 1 from pg_proc where proname = 'mark_treatment_plans_ready_for_discharge'`),
      ).toHaveLength(1)
    } finally {
      await database.close()
    }
  })

  describe('rollback 60 and the care-plan links it would delete', () => {
    const links = (database: TestDatabase) =>
      database.asService<{ kind: string; id: string; plan: string }>(
        `select 'prescription' as kind, prescription_id as id, treatment_plan_id as plan
           from public.prescription where treatment_plan_id is not null
         union all
         select 'appointment', appointment_id, treatment_plan_id
           from public.appointment where treatment_plan_id is not null
         order by 1, 2`,
      )

    /** Refused, and nothing at all changed: schema, readers, links and plans. */
    const expectRefusedUnchanged = async (database: TestDatabase, message: RegExp) => {
      const before = {
        schema: await catalog(database),
        readers: await readerFacts(database),
        links: await links(database),
        plans: await database.asService('select * from public.treatment_plan order by treatment_plan_id'),
        jobs: await database.asService(`select jobname from cron.job order by jobname`).catch(() => []),
      }
      await expect(database.db.exec(await script(ROLLBACK_60))).rejects.toThrow(message)
      expect({
        schema: await catalog(database),
        readers: await readerFacts(database),
        links: await links(database),
        plans: await database.asService('select * from public.treatment_plan order by treatment_plan_id'),
        jobs: await database.asService(`select jobname from cron.job order by jobname`).catch(() => []),
      }).toEqual(before)
    }

    it('refuses, changing nothing, while a prescription is linked to a care plan', async () => {
      const database = await createTestDatabase({ stopAfter: MIGRATION_60 })
      try {
        await seedFixture(database)
        await database.asService('update public.appointment set treatment_plan_id = null')
        const remaining = await links(database)
        expect(remaining.length).toBeGreaterThan(0)
        expect(remaining.every((row) => row.kind === 'prescription')).toBe(true)
        await expectRefusedUnchanged(database, new RegExp(`${remaining.length} prescription and 0 appointment care-plan links`))
        await expectRefusedUnchanged(database, /Export them first.*Nothing was changed/s)
      } finally {
        await database.close()
      }
    })

    it('refuses, changing nothing, while an appointment is linked to a care plan', async () => {
      const database = await createTestDatabase({ stopAfter: MIGRATION_60 })
      try {
        await seedFixture(database)
        await database.asService('update public.prescription set treatment_plan_id = null')
        const remaining = await links(database)
        expect(remaining.length).toBeGreaterThan(0)
        expect(remaining.every((row) => row.kind === 'appointment')).toBe(true)
        await expectRefusedUnchanged(database, new RegExp(`0 prescription and ${remaining.length} appointment care-plan links`))
      } finally {
        await database.close()
      }
    })

    it('runs once the links are exported and cleared, and refuses again if one comes back first', async () => {
      const database = await createTestDatabase({ stopAfter: MIGRATION_60 })
      try {
        const fx = await seedFixture(database)
        const exported = await links(database)
        expect(exported.length).toBeGreaterThan(0)
        await clearCarePlanLinks(database)
        // One link put back between clearing and rolling back: still refused.
        await database.asService('update public.prescription set treatment_plan_id = $2 where prescription_id = $1', [
          fx.alicePrescriptionId,
          fx.alicePlanId,
        ])
        await expectRefusedUnchanged(database, /1 prescription and 0 appointment care-plan links/)
        await clearCarePlanLinks(database)
        await database.db.exec(await script(ROLLBACK_60))
        expect(
          await database.asService(
            `select count(*)::int as n from information_schema.columns
              where table_schema = 'public' and table_name in ('prescription', 'appointment')
                and column_name = 'treatment_plan_id'`,
          ),
        ).toEqual([{ n: 0 }])
      } finally {
        await database.close()
      }
    })
  })

  it('rolls back to exactly what 59 left, refuses a second run, and can be applied again', async () => {
    const [database, through59] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_60 }),
      createTestDatabase({ stopAfter: MIGRATION_59 }),
    ])
    try {
      const fx = await seedFixture(database)
      const after60 = await catalog(database)
      await database.asUser(fx.doctorAUserId, DISCHARGE, [fx.alicePlanId, 'withdrew'])
      const plans = () => database.asService('select * from public.treatment_plan order by treatment_plan_id')
      const history = () =>
        database.asService('select * from public.treatment_plan_lifecycle_event order by treatment_plan_lifecycle_event_id')
      const before = { plans: await plans(), history: await history() }

      // The earlier rollbacks would put back reminder functions that do not
      // ask whether care is open, or drop what 60's functions read.
      await expect(database.db.exec(await script(ROLLBACK_59))).rejects.toThrow(/Roll back migration 60 first/)
      await expect(database.db.exec(await script(ROLLBACK_57))).rejects.toThrow(/Roll back migration 60 first/)

      // The links are handled deliberately first; with none left it runs.
      await clearCarePlanLinks(database)
      await database.db.exec(await script(ROLLBACK_60))
      expect(await catalog(database)).toEqual(await catalog(through59))
      expect(await readerFacts(database)).toEqual(await readerFacts(through59))
      expect({ plans: await plans(), history: await history() }).toEqual(before)
      await expect(database.db.exec(await script(ROLLBACK_60))).rejects.toThrow(/Migration 60 is not applied/)

      await database.applyMigration(MIGRATION_60)
      await database.applyMigration(MIGRATION_60)
      expect(await catalog(database)).toEqual(after60)
      expect({ plans: await plans(), history: await history() }).toEqual(before)
    } finally {
      await Promise.all([database.close(), through59.close()])
    }
  })
})
