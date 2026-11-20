import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 63: a patient's care is In Care or Discharged, and only the
 * patient's assigned, active doctor moves it - by pressing Discharge patient
 * or Reopen case. Nothing else does: not a plan existing or not, a plan's
 * dates or status, goals, the roadmap, appointments, dates or any job. While
 * discharged the patient's care records (plans, goals, roadmap) are
 * read-only for every signed-in person, check-ins stop, and a booking is
 * marked as a follow-up of that discharge. The account is never touched.
 */

const MIGRATION_61 = '20260902100061'
const MIGRATION_62 = '20260902100062'
const MIGRATION_63 = '20260902100063'
const ROLLBACK_63 = 'supabase/rollbacks/20260902100063_patient_care_lifecycle.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const DISCHARGE = 'select * from public.doctor_discharge_patient_care($1, $2)'
const REOPEN = 'select * from public.doctor_reopen_patient_care($1)'
const PLAN_DISCHARGE = 'select * from public.doctor_discharge_treatment_plan($1, $2)'
const PLAN_REOPEN = 'select * from public.doctor_reopen_treatment_plan($1)'
const PROGRESS = 'select * from public.patient_update_treatment_goal_status($1, $2::public.treatment_goal_status)'
const COMPLETE = 'select * from public.patient_complete_recovery_activity($1)'
const UNDO = 'select * from public.patient_reopen_recovery_activity($1)'
const CHECK_IN = `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating)
                  values ($1, $2::date, 3) returning recovery_log_id as id`
const BOOK = `insert into public.appointment (pat_id, doc_id, appointment_date)
              values ($1, $2, now() + interval '10 days')
              returning appointment_id as id, appointment_follow_up_of_care_event_id as "careEvent",
                        appointment_follow_up_of_plan_id as "planMark"`
const ENDED = /Your care has ended\. Book a follow-up if you need more care\./
const READ_ONLY = /care has ended\. Their care records are read-only/

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type Care = { care: string; reason: string | null; at: boolean; account: string }
type CareEvent = { id: string; previous: string; next: string; reason: string | null; by: string | null; doc: string | null; source: string }

describe('the patient-care lifecycle (migration 63)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)
  const asBob = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.bobUserId, sql, params)

  const care = async (patId: string) =>
    (await database.asService<Care>(
      `select pat_care_status as care, pat_care_closure_reason as reason,
              pat_care_discharged_at is not null as at, pat_status::text as account
         from public.patient where pat_id = $1`,
      [patId],
    ))[0]!
  const events = (patId: string) =>
    database.asService<CareEvent>(
      `select patient_care_event_id as id, patient_care_previous_status as previous,
              patient_care_new_status as next, patient_care_closure_reason as reason,
              patient_care_changed_by as by, patient_care_changed_by_doc_id as doc,
              patient_care_change_source as source
         from public.patient_care_event where pat_id = $1
        order by patient_care_changed_at, patient_care_event_id`,
      [patId],
    )
  const newPlan = async (patId: string, start = plusDays(today, -30), end: string | null = null) => {
    const [{ id }] = await asDoctorA<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date, treatment_plan_end_date)
       values ($1, $2, 'Knee plan', $3::date, $4::date) returning treatment_plan_id as id`,
      [patId, fx.doctorAId, start, end],
    )
    return id
  }
  const initialPhase = async (planId: string) =>
    (await database.asService<{ id: string }>(
      `select recovery_phase_id as id from public.recovery_phase
        where treatment_plan_id = $1 and recovery_phase_kind = 'initial' and recovery_phase_archived_at is null`,
      [planId],
    ))[0]!.id
  /** Every patient back in care, so each test starts from the default. */
  const reopenAll = async () => {
    for (const { pat_id } of await database.asService<{ pat_id: string }>(
      `select pat_id from public.patient where pat_care_status = 'discharged'`,
    )) {
      await database.asService(
        `update public.patient set pat_care_status = 'in_care', pat_care_closure_reason = null,
                pat_care_discharged_at = null where pat_id = $1`,
        [pat_id],
      )
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    ;[{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('care never depends on anything but the doctor', () => {
    it('1. starts a new patient In Care, and refuses a session that tries otherwise', async () => {
      expect((await care(fx.alicePatId)).care).toBe('in_care')
      expect(await database.asService('select count(*)::int as n from public.patient where pat_care_status <> $1', ['in_care'])).toEqual([
        { n: 0 },
      ])
    })

    it('2. keeps a patient with no treatment plan In Care', async () => {
      expect(await database.asService('select 1 from public.treatment_plan where pat_id = $1', [fx.bobPatId])).toEqual([])
      expect(await care(fx.bobPatId)).toEqual({ care: 'in_care', reason: null, at: false, account: 'active' })
    })

    it('3–4. keeps a patient In Care with an expired plan, every goal achieved, a discharged plan, and after every job runs', async () => {
      await reopenAll()
      const expired = await newPlan(fx.alicePatId, plusDays(today, -60), plusDays(today, -1))
      const [{ id: goalId }] = await database.asService<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description) values ($1, 'Walk') returning treatment_goal_id as id`,
        [expired],
      )
      await asAlice(PROGRESS, [goalId, 'achieved'])
      const other = await newPlan(fx.alicePatId)
      await asDoctorA(PLAN_DISCHARGE, [other, 'completed_recovery'])

      await database.asService('select public.mark_missed_treatment_goals()')
      await database.asService('select public.mark_overdue_medication_logs()')
      await database.asService('select public.dispatch_medication_reminders(30)')
      await database.asService('select public.dispatch_medication_pre_dose_reminders()')
      await database.asService('select public.dispatch_appointment_reminders()')

      expect((await care(fx.alicePatId)).care).toBe('in_care')
      expect(await events(fx.alicePatId)).toEqual([])
      await asDoctorA(PLAN_REOPEN, [other])
    })

    it('5. has no function but the doctor’s discharge set a patient discharged, and no scheduled job read it to do so', async () => {
      const writers = await database.asService<{ name: string }>(
        `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app_private')
            and p.prosrc ~ 'pat_care_status\\s*=\\s*''discharged'','
          order by 1`,
      )
      expect(writers).toEqual([{ name: 'doctor_discharge_patient_care' }])
    })
  })

  describe('only the assigned, active doctor discharges and reopens', () => {
    it('10–12. discharges with a reason and time, reopens, keeps both in the history and leaves the account alone', async () => {
      await reopenAll()
      const accountBefore = await database.asService('select * from public.user_account where user_id = $1', [fx.aliceUserId])

      const [row] = await asDoctorA<{ pat_care_status: string; pat_status: string }>(DISCHARGE, [fx.alicePatId, 'completed_recovery'])
      expect(row).toMatchObject({ pat_care_status: 'discharged', pat_status: 'active' })
      expect(await care(fx.alicePatId)).toEqual({ care: 'discharged', reason: 'completed_recovery', at: true, account: 'active' })

      await asDoctorA(REOPEN, [fx.alicePatId])
      expect(await care(fx.alicePatId)).toEqual({ care: 'in_care', reason: null, at: false, account: 'active' })

      expect((await events(fx.alicePatId)).map(({ id: _id, ...e }) => e)).toEqual([
        { previous: 'in_care', next: 'discharged', reason: 'completed_recovery', by: fx.doctorAUserId, doc: fx.doctorAId, source: 'doctor' },
        { previous: 'discharged', next: 'in_care', reason: null, by: fx.doctorAUserId, doc: fx.doctorAId, source: 'doctor' },
      ])
      expect(await database.asService('select * from public.user_account where user_id = $1', [fx.aliceUserId])).toEqual(accountBefore)
      // The patient and the doctor both read the history.
      expect(await asAlice('select 1 from public.patient_care_event where pat_id = $1', [fx.alicePatId])).toHaveLength(2)
      expect(await asDoctorA('select 1 from public.patient_care_event where pat_id = $1', [fx.alicePatId])).toHaveLength(2)
      expect(await database.asUser(fx.carolUserId, 'select 1 from public.patient_care_event where pat_id = $1', [fx.alicePatId])).toEqual([])
    })

    it('requires one of the listed reasons, and refuses a repeat either way', async () => {
      await reopenAll()
      for (const reason of ['recovered', '', null]) {
        await expect(asDoctorA(DISCHARGE, [fx.bobPatId, reason])).rejects.toThrow(/closure reason/)
      }
      await expect(asDoctorA(REOPEN, [fx.bobPatId])).rejects.toThrow(/already in care/)
      for (const reason of ['completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred']) {
        await asDoctorA(DISCHARGE, [fx.bobPatId, reason])
        expect((await care(fx.bobPatId)).reason).toBe(reason)
        await expect(asDoctorA(DISCHARGE, [fx.bobPatId, reason])).rejects.toThrow(/already discharged/)
        await asDoctorA(REOPEN, [fx.bobPatId])
      }
      expect(await events(fx.bobPatId)).toHaveLength(10)
    })

    it('6–9. refuses the patient, another patient, another doctor, a deactivated doctor, the Clinic Admin and a visitor', async () => {
      await reopenAll()
      for (const userId of [fx.aliceUserId, fx.bobUserId, fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, DISCHARGE, [fx.alicePatId, 'transferred'])).rejects.toThrow(/assigned doctor/)
      }
      await expect(database.asAnon(DISCHARGE, [fx.alicePatId, 'transferred'])).rejects.toThrow(/permission denied|assigned doctor/)
      // Dave's own doctor is deactivated.
      await expect(database.asUser(fx.doctorCUserId, DISCHARGE, [fx.davePatId, 'transferred'])).rejects.toThrow(/assigned doctor/)
      // A patient that does not exist reads the same.
      await expect(asDoctorA(DISCHARGE, ['00000000-0000-4000-8000-000000000000', 'withdrew'])).rejects.toThrow(/assigned doctor/)

      // Reopening is refused the same way.
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'withdrew'])
      for (const userId of [fx.aliceUserId, fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, REOPEN, [fx.alicePatId])).rejects.toThrow(/assigned doctor/)
      }
      // The assigned doctor, once deactivated, is refused too.
      await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = false where doc_id = $1', [fx.doctorAId])
      try {
        await expect(asDoctorA(REOPEN, [fx.alicePatId])).rejects.toThrow(/assigned doctor/)
      } finally {
        await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = true where doc_id = $1', [fx.doctorAId])
      }
      expect((await care(fx.alicePatId)).care).toBe('discharged')
      await asDoctorA(REOPEN, [fx.alicePatId])
    })

    it('refuses every direct write of the care columns, by the patient, the doctor and the administrator', async () => {
      await reopenAll()
      const attempts: [string, string][] = [
        [fx.aliceUserId, `update public.patient set pat_care_status = 'discharged', pat_care_closure_reason = 'withdrew', pat_care_discharged_at = now() where pat_id = $1 returning 1`],
        [fx.doctorAUserId, `update public.patient set pat_care_status = 'discharged', pat_care_closure_reason = 'withdrew', pat_care_discharged_at = now() where pat_id = $1 returning 1`],
        [fx.adminUserId, `update public.patient set pat_care_status = 'discharged', pat_care_closure_reason = 'withdrew', pat_care_discharged_at = now() where pat_id = $1 returning 1`],
        [fx.doctorAUserId, `update public.patient set pat_care_closure_reason = 'withdrew' where pat_id = $1 returning 1`],
      ]
      for (const [userId, sql] of attempts) {
        await database.asUser(userId, sql, [fx.alicePatId]).then(
          (rows) => expect(rows).toEqual([]),
          (error: Error) => expect(error.message).toMatch(/Discharge patient and Reopen case|row-level security/),
        )
      }
      expect((await care(fx.alicePatId)).care).toBe('in_care')
      // A session cannot write or rewrite the history.
      for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
        await expect(
          database.asUser(
            userId,
            `insert into public.patient_care_event (pat_id, patient_care_previous_status, patient_care_new_status, patient_care_change_source)
             values ($1, 'in_care', 'discharged', 'doctor')`,
            [fx.alicePatId],
          ),
        ).rejects.toThrow(/permission denied/)
      }
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'referred'])
      await expect(database.asService(`update public.patient_care_event set patient_care_closure_reason = 'withdrew'`)).rejects.toThrow(
        /cannot be changed/,
      )
      await asDoctorA(REOPEN, [fx.alicePatId])
    })

    it('lets the doctor still edit the patient’s profile, and the patient their own, while discharged', async () => {
      await reopenAll()
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'transferred'])
      await asDoctorA(`update public.patient set pat_contact_no = '09170000001' where pat_id = $1`, [fx.alicePatId])
      await asAlice(`update public.patient set pat_address = 'Makati' where pat_id = $1`, [fx.alicePatId])
      expect((await care(fx.alicePatId)).care).toBe('discharged')
      await asDoctorA(REOPEN, [fx.alicePatId])
    })
  })

  describe('while discharged', () => {
    it('13. stops check-ins for a patient with no plan, keeps the old ones, and lets them back in on reopening', async () => {
      await reopenAll()
      const [{ id: old }] = await asBob<{ id: string }>(CHECK_IN, [fx.bobPatId, plusDays(today, -20)])
      await asDoctorA(DISCHARGE, [fx.bobPatId, 'lost_to_follow_up'])
      await expect(asBob(CHECK_IN, [fx.bobPatId, plusDays(today, -19)])).rejects.toThrow(ENDED)
      await expect(asBob('update public.recovery_log set recovery_log_mood_rating = 1 where recovery_log_id = $1', [old])).rejects.toThrow(ENDED)
      expect(await asBob('select 1 from public.recovery_log where recovery_log_id = $1', [old])).toHaveLength(1)
      await asDoctorA(REOPEN, [fx.bobPatId])
      await asBob(CHECK_IN, [fx.bobPatId, plusDays(today, -19)])
    })

    it('no longer reads a plan: a patient in care whose only plan is discharged still checks in', async () => {
      await reopenAll()
      const planId = await newPlan(fx.bobPatId)
      await asDoctorA(PLAN_DISCHARGE, [planId, 'completed_recovery'])
      await asBob(CHECK_IN, [fx.bobPatId, plusDays(today, -18)])
      const [{ careEvent, planMark }] = await asBob<{ careEvent: string | null; planMark: string | null }>(BOOK, [fx.bobPatId, fx.doctorAId])
      expect({ careEvent, planMark }).toEqual({ careEvent: null, planMark: null })
      await asDoctorA(PLAN_REOPEN, [planId])
    })

    it('18–21. keeps the plan, goals and roadmap readable but refuses every change, from the doctor and the patient', async () => {
      await reopenAll()
      const planId = await newPlan(fx.alicePatId)
      const [{ id: goalId }] = await asDoctorA<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description) values ($1, 'Climb stairs') returning treatment_goal_id as id`,
        [planId],
      )
      const phase = await initialPhase(planId)
      const [{ id: done }] = await asDoctorA<{ id: string }>(
        `insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'Ice') returning recovery_activity_id as id`,
        [phase],
      )
      const [{ id: open }] = await asDoctorA<{ id: string }>(
        `insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'Stretch') returning recovery_activity_id as id`,
        [phase],
      )
      await asAlice(COMPLETE, [done])
      await asAlice(PROGRESS, [goalId, 'in_progress'])

      await asDoctorA(DISCHARGE, [fx.alicePatId, 'completed_recovery'])

      const refusedForDoctor = [
        [`update public.treatment_plan set treatment_plan_title = 'Changed' where treatment_plan_id = $1`, [planId]],
        [`insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date) values ($1, $2, 'New', current_date)`, [fx.alicePatId, fx.doctorAId]],
        [`insert into public.treatment_goal (treatment_plan_id, treatment_goal_description) values ($1, 'More')`, [planId]],
        [`update public.treatment_goal set treatment_goal_description = 'Changed' where treatment_goal_id = $1`, [goalId]],
        [`delete from public.treatment_goal where treatment_goal_id = $1`, [goalId]],
        [`insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'New')`, [phase]],
        [`update public.recovery_activity set recovery_activity_title = 'Changed' where recovery_activity_id = $1`, [open]],
        [`update public.recovery_activity set recovery_activity_archived_at = now() where recovery_activity_id = $1`, [open]],
        [`select public.doctor_reorder_recovery_activities($1, array[$3, $2]::uuid[])`, [phase, done, open]],
        [PLAN_DISCHARGE, [planId, 'completed_recovery']],
      ] as const
      for (const [sql, params] of refusedForDoctor) {
        await expect(asDoctorA(sql, [...params])).rejects.toThrow(READ_ONLY)
      }
      // No session deletes a plan at all (no policy); the guard would refuse it too.
      await expect(database.asUser(fx.doctorAUserId, 'delete from public.treatment_plan where treatment_plan_id = $1 returning 1', [planId])).resolves.toEqual([])
      await expect(asAlice(COMPLETE, [open])).rejects.toThrow(READ_ONLY)
      await expect(asAlice(UNDO, [done])).rejects.toThrow(READ_ONLY)
      await expect(asAlice(PROGRESS, [goalId, 'achieved'])).rejects.toThrow(ENDED)

      // Everything stays as it was, and readable by both.
      expect(await asAlice('select treatment_plan_title as t from public.treatment_plan where treatment_plan_id = $1', [planId])).toEqual([{ t: 'Knee plan' }])
      expect(await asAlice('select treatment_goal_status::text as s from public.treatment_goal where treatment_goal_id = $1', [goalId])).toEqual([{ s: 'in_progress' }])
      expect(
        await asAlice(
          `select recovery_activity_title as t, recovery_activity_completed_at is not null as done from public.recovery_activity
            where recovery_phase_id = $1 order by recovery_activity_order`,
          [phase],
        ),
      ).toEqual([{ t: 'Ice', done: true }, { t: 'Stretch', done: false }])
      expect(await asDoctorA('select 1 from public.recovery_activity_event where recovery_activity_id = $1', [done])).toHaveLength(1)
      expect(await asDoctorA('select 1 from public.treatment_goal_status_event where treatment_goal_id = $1', [goalId])).toHaveLength(2)

      // Reopened, each works again.
      await asDoctorA(REOPEN, [fx.alicePatId])
      await asDoctorA(`update public.treatment_plan set treatment_plan_title = 'Changed' where treatment_plan_id = $1`, [planId])
      await asDoctorA(`insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'New')`, [phase])
      await asAlice(COMPLETE, [open])
      await asAlice(UNDO, [done])
      await asAlice(PROGRESS, [goalId, 'achieved'])
    })

    it('does not block medicines, notes, appointments or the doctor’s reminder switch', async () => {
      await reopenAll()
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'transferred'])
      await asDoctorA(
        `update public.medication_schedule set medication_schedule_instructions = 'After meals' where medication_schedule_id = $1`,
        [fx.aliceScheduleId],
      )
      await asDoctorA(
        `update public.medication_schedule set medication_schedule_reminders_is_enabled = false where medication_schedule_id = $1`,
        [fx.aliceScheduleId],
      )
      expect(
        await asDoctorA(`insert into public.doctor_note (pat_id, doc_id, doctor_note_text) values ($1, $2, 'Discharged well') returning 1`, [
          fx.alicePatId,
          fx.doctorAId,
        ]),
      ).toHaveLength(1)
      expect(
        await database.asService<{ i: string; r: boolean }>(
          `select medication_schedule_instructions as i, medication_schedule_reminders_is_enabled as r
             from public.medication_schedule where medication_schedule_id = $1`,
          [fx.aliceScheduleId],
        ),
      ).toEqual([{ i: 'After meals', r: false }])
      await asDoctorA(`update public.medication_schedule set medication_schedule_reminders_is_enabled = true where medication_schedule_id = $1`, [
        fx.aliceScheduleId,
      ])
      await asDoctorA(REOPEN, [fx.alicePatId])
    })

    it('22. the missed-goal job skips a discharged patient, and catches up once care reopens', async () => {
      await reopenAll()
      const planId = await newPlan(fx.alicePatId, plusDays(today, -40))
      const [{ id: goalId }] = await database.asService<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
         values ($1, 'Overdue', $2::date) returning treatment_goal_id as id`,
        [planId, plusDays(today, -3)],
      )
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'withdrew'])
      await database.asService('select public.mark_missed_treatment_goals()')
      expect(await database.asService('select treatment_goal_status::text as s from public.treatment_goal where treatment_goal_id = $1', [goalId])).toEqual([
        { s: 'pending' },
      ])
      await asDoctorA(REOPEN, [fx.alicePatId])
      await database.asService('select public.mark_missed_treatment_goals()')
      expect(await database.asService('select treatment_goal_status::text as s from public.treatment_goal where treatment_goal_id = $1', [goalId])).toEqual([
        { s: 'missed' },
      ])
    })

    it('23. leaves the generated roadmap exactly goals + 2 phases through discharge and reopening', async () => {
      await reopenAll()
      const planId = await newPlan(fx.alicePatId)
      for (const goal of ['One', 'Two']) {
        await asDoctorA(`insert into public.treatment_goal (treatment_plan_id, treatment_goal_description) values ($1, $2)`, [planId, goal])
      }
      const shape = () =>
        database.asService<{ kind: string; n: number }>(
          `select recovery_phase_kind as kind, count(*)::int as n from public.recovery_phase
            where treatment_plan_id = $1 and recovery_phase_archived_at is null group by 1 order by 1`,
          [planId],
        )
      const before = await shape()
      expect(before).toEqual([{ kind: 'follow_up', n: 1 }, { kind: 'goal', n: 2 }, { kind: 'initial', n: 1 }])
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'completed_recovery'])
      await expect(
        asDoctorA(`update public.treatment_plan set treatment_plan_end_date = current_date + 30 where treatment_plan_id = $1`, [planId]),
      ).rejects.toThrow(READ_ONLY)
      expect(await shape()).toEqual(before)
      await asDoctorA(REOPEN, [fx.alicePatId])
      await asDoctorA(`insert into public.treatment_goal (treatment_plan_id, treatment_goal_description) values ($1, 'Three')`, [planId])
      expect(await shape()).toEqual([{ kind: 'follow_up', n: 1 }, { kind: 'goal', n: 3 }, { kind: 'initial', n: 1 }])
    })
  })

  describe('follow-ups after discharge', () => {
    it('14–15, 17. marks a booking with the discharge it follows, with or without plans, and keeps each mark across cycles', async () => {
      await reopenAll()
      expect(await database.asService('select 1 from public.treatment_plan where pat_id = $1', [fx.bobPatId])).not.toHaveLength(0)
      // A patient with no plans at all: Carol's is removed for this test.
      await database.asService('delete from public.treatment_plan where pat_id = $1', [fx.carolPatId])
      const asCarol = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        database.asUser<T>(fx.carolUserId, sql, params)
      const asDoctorB = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        database.asUser<T>(fx.doctorBUserId, sql, params)

      const [{ careEvent: before }] = await asCarol<{ careEvent: string | null }>(BOOK, [fx.carolPatId, fx.doctorBId])
      expect(before).toBeNull()

      await asDoctorB(DISCHARGE, [fx.carolPatId, 'completed_recovery'])
      const [firstDischarge] = (await events(fx.carolPatId)).filter((e) => e.next === 'discharged')
      const [{ id: first, careEvent: firstMark }] = await asCarol<{ id: string; careEvent: string }>(BOOK, [fx.carolPatId, fx.doctorBId])
      expect(firstMark).toBe(firstDischarge!.id)
      // The doctor sees it as a follow-up after discharge; no session can change the mark.
      expect(
        await asDoctorB('select appointment_follow_up_of_care_event_id as e from public.appointment where appointment_id = $1', [first]),
      ).toEqual([{ e: firstDischarge!.id }])
      await expect(
        asDoctorB('update public.appointment set appointment_follow_up_of_care_event_id = null where appointment_id = $1', [first]),
      ).rejects.toThrow(/follow-up mark/)
      await asDoctorB(`update public.appointment set appointment_status = 'confirmed' where appointment_id = $1`, [first])

      await asDoctorB(REOPEN, [fx.carolPatId])
      const [{ careEvent: inCare }] = await asCarol<{ careEvent: string | null }>(BOOK, [fx.carolPatId, fx.doctorBId])
      expect(inCare).toBeNull()

      await asDoctorB(DISCHARGE, [fx.carolPatId, 'referred'])
      const discharges = (await events(fx.carolPatId)).filter((e) => e.next === 'discharged')
      expect(discharges).toHaveLength(2)
      const [{ careEvent: secondMark }] = await asCarol<{ careEvent: string }>(BOOK, [fx.carolPatId, fx.doctorBId])
      expect(secondMark).toBe(discharges[1]!.id)
      await asDoctorB(REOPEN, [fx.carolPatId])

      // The first follow-up keeps the first discharge, after both reopenings.
      expect(
        await database.asService('select appointment_follow_up_of_care_event_id as e, appointment_status::text as s from public.appointment where appointment_id = $1', [first]),
      ).toEqual([{ e: firstDischarge!.id, s: 'confirmed' }])
      // No appointment was cancelled along the way.
      expect(
        await database.asService(`select count(*)::int as n from public.appointment where pat_id = $1 and appointment_status = 'cancelled'`, [
          fx.carolPatId,
        ]),
      ).toEqual([{ n: 0 }])
    })

    it('keeps the mark on an event of the appointment’s own patient, for the service role too', async () => {
      await reopenAll()
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'transferred'])
      const [{ id }] = await asAlice<{ id: string }>(BOOK, [fx.alicePatId, fx.doctorAId])
      await expect(database.asService('update public.appointment set pat_id = $2 where appointment_id = $1', [id, fx.bobPatId])).rejects.toThrow(
        /foreign key/,
      )
      await asDoctorA(REOPEN, [fx.alicePatId])
    })
  })

  describe('16, 26. migration 61 keeps working alongside', () => {
    it('discharges and reopens a single plan for a patient in care, with its own history', async () => {
      await reopenAll()
      const planId = await newPlan(fx.alicePatId)
      await asDoctorA(PLAN_DISCHARGE, [planId, 'transferred'])
      await asDoctorA(PLAN_REOPEN, [planId])
      expect(
        await database.asService<{ next: string }>(
          `select treatment_plan_new_status::text as next from public.treatment_plan_lifecycle_event
            where treatment_plan_id = $1 order by treatment_plan_changed_at`,
          [planId],
        ),
      ).toEqual([{ next: 'discharged' }, { next: 'active' }])
      expect((await care(fx.alicePatId)).care).toBe('in_care')
    })

    it('discharging the patient leaves every plan’s status as it was', async () => {
      await reopenAll()
      const plans = () =>
        database.asService('select treatment_plan_id, treatment_plan_status::text as s from public.treatment_plan where pat_id = $1 order by 1', [
          fx.alicePatId,
        ])
      const before = await plans()
      await asDoctorA(DISCHARGE, [fx.alicePatId, 'completed_recovery'])
      expect(await plans()).toEqual(before)
      await asDoctorA(REOPEN, [fx.alicePatId])
      expect(await plans()).toEqual(before)
    })
  })
})

describe('migration 63 against the production shape at 61', () => {
  it('keeps every row and plan-level mark, starts everyone In Care, and rolls back to exactly what 62 left', async () => {
    const [full, through62] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_62 }),
      createTestDatabase({ stopAfter: MIGRATION_62 }),
    ])
    try {
      const fx = await seedFixture(full)
      // Production after 61: one plan discharged, and a follow-up booked on it.
      await full.asUser(fx.doctorAUserId, PLAN_DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      const [{ id: followUp }] = await full.asUser<{ id: string }>(
        fx.aliceUserId,
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '7 days') returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      const patients = () => full.asService('select * from public.patient order by pat_id')
      const appointments = () => full.asService('select * from public.appointment order by appointment_id')
      const plans = () => full.asService('select * from public.treatment_plan order by treatment_plan_id')
      const [beforePatients, beforeAppointments, beforePlans] = [await patients(), await appointments(), await plans()]

      await full.applyMigration(MIGRATION_63)
      const after63 = await catalog(full)
      const care = await full.asService<{ s: string }>('select distinct pat_care_status as s from public.patient')
      expect(care).toEqual([{ s: 'in_care' }])
      const stripCare = (rows: Record<string, unknown>[]) =>
        rows.map(({ pat_care_status: _s, pat_care_closure_reason: _r, pat_care_discharged_at: _d, ...row }) => row)
      expect(stripCare(await patients())).toEqual(beforePatients)
      expect((await appointments()).map(({ appointment_follow_up_of_care_event_id: _e, ...row }) => row)).toEqual(beforeAppointments)
      expect(
        await full.asService('select appointment_follow_up_of_plan_id as p from public.appointment where appointment_id = $1', [followUp]),
      ).toEqual([{ p: fx.alicePlanId }])
      expect(await plans()).toEqual(beforePlans)
      expect(await full.asService('select count(*)::int as n from public.patient_care_event')).toEqual([{ n: 0 }])
      // The patient whose only plan is discharged is in care, and checks in.
      await full.asUser(fx.aliceUserId, CHECK_IN, [fx.alicePatId, '2026-01-02'])
      const [{ timeout }] = await full.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')

      // Re-running it changes nothing.
      await full.applyMigration(MIGRATION_63)
      expect(await catalog(full)).toEqual(after63)

      // The rollback refuses while a patient is discharged.
      await full.asUser(fx.doctorAUserId, DISCHARGE, [fx.bobPatId, 'withdrew'])
      await expect(full.db.exec(await script(ROLLBACK_63))).rejects.toThrow(/patients are discharged; reopen each first/)
      expect(await catalog(full)).toEqual(after63)
      await full.asUser(fx.doctorAUserId, REOPEN, [fx.bobPatId])

      await full.db.exec(await script(ROLLBACK_63))
      expect(await catalog(full)).toEqual(await catalog(through62))
      expect(
        await full.asService('select appointment_follow_up_of_plan_id as p from public.appointment where appointment_id = $1', [followUp]),
      ).toEqual([{ p: fx.alicePlanId }])
      await expect(full.db.exec(await script(ROLLBACK_63))).rejects.toThrow(/Migration 63 is not applied/)

      await full.applyMigration(MIGRATION_63)
      expect(await catalog(full)).toEqual(after63)
    } finally {
      await Promise.all([full.close(), through62.close()])
    }
  })

  it('refuses to roll back under migration 64', async () => {
    const database = await createTestDatabase()
    try {
      await expect(database.db.exec(await script(ROLLBACK_63))).rejects.toThrow(/Migration 64 is applied/)
    } finally {
      await database.close()
    }
  })

  it('is built on 61, which stays applied once', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_61 })
    try {
      expect(await database.asService("select to_regprocedure('public.doctor_discharge_patient_care(uuid, text)') as f")).toEqual([{ f: null }])
    } finally {
      await database.close()
    }
  })
})
