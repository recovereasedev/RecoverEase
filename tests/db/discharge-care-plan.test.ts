import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 61: a care plan is Active or Discharged, on top of migration 53
 * with nothing from 54-60. The patient's assigned, active doctor alone
 * discharges (with a reason) and reopens; nothing else moves a plan into or
 * out of a discharge. Every move is kept in an append-only history. The
 * patient's account and records are never touched; once their care has ended
 * they can book a follow-up (marked for the doctor) but cannot log new
 * check-ins or mark roadmap activities. Reminders are left exactly as 53 has
 * them.
 */

const MIGRATION_53 = '20260902100053'
const MIGRATION_61 = '20260902100061'
const ROLLBACK_61 = 'supabase/rollbacks/20260902100061_discharge_care_plan.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const DISCHARGE = 'select * from public.doctor_discharge_treatment_plan($1, $2)'
const REOPEN = 'select * from public.doctor_reopen_treatment_plan($1)'
const ENDED = /Your care plan has ended\. Book a follow-up if you need more care\./

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type PlanRow = { status: string; reason: string | null; discharged: boolean }
type EventRow = { previous: string | null; next: string; reason: string | null; actor: string | null; source: string }

describe('the care-plan lifecycle (migration 61)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string
  let doctorDUserId: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)

  /** A new active plan for a patient of doctorA (Alice by default), as the service. */
  const newPlan = async (patId?: string) => {
    const [{ id }] = await database.asService<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date)
       values ($1, $2, 'Knee plan', $3::date)
       returning treatment_plan_id as id`,
      [patId ?? fx.alicePatId, fx.doctorAId, plusDays(today, -30)],
    )
    return id
  }
  const plan = async (planId: string) =>
    (await database.asService<PlanRow>(
      `select treatment_plan_status::text as status, treatment_plan_closure_reason as reason,
              treatment_plan_discharged_at is not null as discharged
         from public.treatment_plan where treatment_plan_id = $1`,
      [planId],
    ))[0]!
  const events = (planId: string) =>
    database.asService<EventRow>(
      `select treatment_plan_previous_status::text as previous, treatment_plan_new_status::text as next,
              treatment_plan_closure_reason as reason, treatment_plan_changed_by as actor,
              treatment_plan_change_source as source
         from public.treatment_plan_lifecycle_event
        where treatment_plan_id = $1
        order by treatment_plan_changed_at, treatment_plan_lifecycle_event_id`,
      [planId],
    )
  /** Plans other tests left are removed first, so a patient's care is only what this test makes it. */
  const quietOthers = async () => {
    await database.asService('delete from public.treatment_plan')
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    ;[{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')

    // A doctor in another clinic, who must not reach Alice's plan.
    await liftSingleClinicGate(database)
    const otherClinic = await addClinic(database, 'Second Street Clinic', 'Asia/Tokyo')
    ;[{ id: doctorDUserId }] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'doctor.d@second.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'doctor.d@second.test', 'doctor')`,
      [doctorDUserId],
    )
    await database.asService(
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Dana', 'Lim', 'LIC-D-001', true, $2)`,
      [doctorDUserId, otherClinic],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('stands on migration 53 alone', () => {
    it('adds no object of migrations 54-60, and only the one enum label', async () => {
      const [facts] = await database.asService<Record<string, unknown>>(
        `select to_regprocedure('public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status)') as goal_rpc,
                to_regprocedure('public.mark_missed_treatment_goals()') as missed_job,
                to_regprocedure('public.mark_treatment_plans_ready_for_discharge()') as ready_job,
                to_regprocedure('app_private.care_reminders_allowed(uuid, uuid)') as reminder_gate,
                to_regprocedure('public.medication_schedule_stamp_reminders()') as reminder_switch,
                (select array_agg(enumlabel::text order by enumsortorder) from pg_enum
                  where enumtypid = 'public.treatment_plan_status'::regtype) as labels,
                (select array_agg(column_name::text order by column_name) from information_schema.columns
                  where table_schema = 'public'
                    and ((table_name = 'prescription' and column_name = 'treatment_plan_id')
                      or (table_name = 'appointment' and column_name = 'treatment_plan_id')
                      or (table_name = 'treatment_plan' and column_name = 'treatment_plan_follow_up_appointment_id')
                      or (table_name = 'recovery_phase' and column_name = 'recovery_phase_kind')
                      or (table_name = 'medication_schedule' and column_name like 'medication_schedule_%instructions%')
                      or (table_name = 'medication_schedule' and column_name like 'medication_schedule_reminders_%'))) as later_columns`,
      )
      expect(facts).toEqual({
        goal_rpc: null,
        missed_job: null,
        ready_job: null,
        reminder_gate: null,
        reminder_switch: null,
        labels: ['draft', 'active', 'discharged', 'completed', 'cancelled'],
        later_columns: null,
      })
    })

    it('leaves the patient no write to a goal, as at 53', async () => {
      await quietOthers()
      const planId = await newPlan()
      const [{ id: goalId }] = await database.asService<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description)
         values ($1, 'Walk unaided') returning treatment_goal_id as id`,
        [planId],
      )
      await expectDenied(() =>
        asAlice(
          `update public.treatment_goal set treatment_goal_status = 'achieved' where treatment_goal_id = $1 returning *`,
          [goalId],
        ),
      )
    })
  })

  describe('the doctor discharges and reopens', () => {
    it('discharges an active plan with a reason and a timestamp, recorded as the doctor’s', async () => {
      const planId = await newPlan()
      const [row] = await asDoctorA<{ treatment_plan_status: string }>(DISCHARGE, [planId, 'completed_recovery'])
      expect(row!.treatment_plan_status).toBe('discharged')
      expect(await plan(planId)).toEqual({ status: 'discharged', reason: 'completed_recovery', discharged: true })
      expect(await events(planId)).toEqual([
        { previous: 'active', next: 'discharged', reason: 'completed_recovery', actor: fx.doctorAUserId, source: 'doctor' },
      ])
    })

    it('accepts every listed reason and refuses any other or none', async () => {
      for (const reason of ['completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred']) {
        const planId = await newPlan()
        await asDoctorA(DISCHARGE, [planId, reason])
        expect((await plan(planId)).reason).toBe(reason)
      }
      const planId = await newPlan()
      for (const reason of ['recovered', '', null]) {
        await expect(asDoctorA(DISCHARGE, [planId, reason])).rejects.toThrow(/closure reason/)
      }
      expect(await plan(planId)).toEqual({ status: 'active', reason: null, discharged: false })
      expect(await events(planId)).toEqual([])
    })

    it('refuses the patient, another patient, another doctor, a doctor elsewhere, a deactivated doctor, the Clinic Admin and a visitor', async () => {
      const planId = await newPlan()
      for (const userId of [fx.aliceUserId, fx.bobUserId, fx.doctorBUserId, doctorDUserId, fx.doctorCUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, DISCHARGE, [planId, 'transferred'])).rejects.toThrow(/assigned doctor/)
      }
      await expect(database.asAnon(DISCHARGE, [planId, 'transferred'])).rejects.toThrow(/permission denied|assigned doctor/)
      // The assigned doctor, once deactivated, is refused too.
      await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = false where doc_id = $1', [fx.doctorAId])
      try {
        await expect(asDoctorA(DISCHARGE, [planId, 'transferred'])).rejects.toThrow(/assigned doctor/)
      } finally {
        await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = true where doc_id = $1', [fx.doctorAId])
      }
      expect((await plan(planId)).status).toBe('active')
      expect(await events(planId)).toEqual([])
    })

    it('refuses a plan that does not exist in the same words as someone else’s', async () => {
      await expect(asDoctorA(DISCHARGE, ['00000000-0000-4000-8000-000000000000', 'withdrew'])).rejects.toThrow(
        /assigned doctor can discharge/,
      )
      await expect(asDoctorA(REOPEN, ['00000000-0000-4000-8000-000000000000'])).rejects.toThrow(/assigned doctor can reopen/)
    })

    it('discharges only an active plan, once', async () => {
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'withdrew'])
      await expect(asDoctorA(DISCHARGE, [planId, 'withdrew'])).rejects.toThrow(/only an active plan/)
      expect(await events(planId)).toHaveLength(1)
    })

    it('reopens a discharged plan, clearing the reason and time, and keeps every event through repeated cycles', async () => {
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'lost_to_follow_up'])
      await asDoctorA(REOPEN, [planId])
      expect(await plan(planId)).toEqual({ status: 'active', reason: null, discharged: false })
      await asDoctorA(DISCHARGE, [planId, 'transferred'])
      await asDoctorA(REOPEN, [planId])
      expect((await events(planId)).map((event) => [event.previous, event.next, event.reason, event.source])).toEqual([
        ['active', 'discharged', 'lost_to_follow_up', 'doctor'],
        ['discharged', 'active', null, 'doctor'],
        ['active', 'discharged', 'transferred', 'doctor'],
        ['discharged', 'active', null, 'doctor'],
      ])
    })

    it('reopens only a discharged plan, and only for its assigned doctor', async () => {
      const active = await newPlan()
      await expect(asDoctorA(REOPEN, [active])).rejects.toThrow(/only a discharged plan/)

      const closed = await newPlan()
      await asDoctorA(DISCHARGE, [closed, 'withdrew'])
      for (const userId of [fx.aliceUserId, fx.doctorBUserId, doctorDUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, REOPEN, [closed])).rejects.toThrow(/assigned doctor/)
      }
      await expect(database.asAnon(REOPEN, [closed])).rejects.toThrow(/permission denied|assigned doctor/)
      expect((await plan(closed)).status).toBe('discharged')
    })

    it('refuses every direct write that would bypass the lifecycle', async () => {
      const planId = await newPlan()
      for (const change of [
        "treatment_plan_status = 'discharged', treatment_plan_closure_reason = 'withdrew', treatment_plan_discharged_at = now()",
        "treatment_plan_closure_reason = 'withdrew'",
        'treatment_plan_discharged_at = now()',
      ]) {
        await expect(
          asDoctorA(`update public.treatment_plan set ${change} where treatment_plan_id = $1`, [planId]),
        ).rejects.toThrow(/discharge|lifecycle/)
      }
      // Migration 1's other labels are refused for every writer.
      for (const status of ['draft', 'completed', 'cancelled']) {
        await expect(
          asDoctorA(`update public.treatment_plan set treatment_plan_status = $2::public.treatment_plan_status where treatment_plan_id = $1`, [
            planId,
            status,
          ]),
        ).rejects.toThrow(/treatment_plan_status_valid/)
        await expect(
          database.asService(
            `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_status, treatment_plan_start_date)
             values ($1, $2, 'Old status', $3::public.treatment_plan_status, $4::date)`,
            [fx.alicePatId, fx.doctorAId, status, today],
          ),
        ).rejects.toThrow(/treatment_plan_status_valid/)
      }
      await asDoctorA(DISCHARGE, [planId, 'withdrew'])
      await expect(
        asDoctorA(`update public.treatment_plan set treatment_plan_status = 'active' where treatment_plan_id = $1`, [planId]),
      ).rejects.toThrow(/discharge|lifecycle/)
      await expect(
        asDoctorA(
          `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_status, treatment_plan_start_date)
           values ($1, $2, 'Shortcut', 'discharged', $3::date)`,
          [fx.alicePatId, fx.doctorAId, today],
        ),
      ).rejects.toThrow(/discharge|lifecycle/)
      // The patient has no update path at all.
      await expectDenied(() =>
        asAlice(`update public.treatment_plan set treatment_plan_status = 'active' where treatment_plan_id = $1 returning *`, [planId]),
      )
      expect((await plan(planId)).status).toBe('discharged')
      // The doctor may still edit a discharged plan's own text; its discharge stays.
      await asDoctorA(`update public.treatment_plan set treatment_plan_title = 'Knee plan (closed)' where treatment_plan_id = $1`, [planId])
      expect(await plan(planId)).toEqual({ status: 'discharged', reason: 'withdrew', discharged: true })
      // Even the owner cannot leave a discharge without its reason and time.
      const other = await newPlan()
      await expect(
        database.asService(`update public.treatment_plan set treatment_plan_status = 'discharged' where treatment_plan_id = $1`, [other]),
      ).rejects.toThrow(/check constraint/)
    })

    it('records a change made with no one signed in as the service’s', async () => {
      const planId = await newPlan()
      await database.asService(
        `update public.treatment_plan
            set treatment_plan_status = 'discharged', treatment_plan_closure_reason = 'referred', treatment_plan_discharged_at = now()
          where treatment_plan_id = $1`,
        [planId],
      )
      expect(await events(planId)).toEqual([
        { previous: 'active', next: 'discharged', reason: 'referred', actor: null, source: 'service' },
      ])
      // Text-only edits write no event.
      await database.asService(`update public.treatment_plan set treatment_plan_title = 'Renamed' where treatment_plan_id = $1`, [planId])
      expect(await events(planId)).toHaveLength(1)
    })

    it('keeps the history append-only and readable only by those who may read the plan', async () => {
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'withdrew'])
      for (const userId of [fx.doctorAUserId, fx.aliceUserId]) {
        await expect(
          database.asUser(userId, `update public.treatment_plan_lifecycle_event set treatment_plan_closure_reason = null where treatment_plan_id = $1`, [planId]),
        ).rejects.toThrow(/permission denied/)
        await expect(
          database.asUser(userId, 'delete from public.treatment_plan_lifecycle_event where treatment_plan_id = $1', [planId]),
        ).rejects.toThrow(/permission denied/)
        await expect(
          database.asUser(
            userId,
            `insert into public.treatment_plan_lifecycle_event (treatment_plan_id, treatment_plan_new_status, treatment_plan_change_source)
             values ($1, 'active', 'doctor')`,
            [planId],
          ),
        ).rejects.toThrow(/permission denied/)
      }
      const read = 'select treatment_plan_new_status::text as next from public.treatment_plan_lifecycle_event where treatment_plan_id = $1'
      expect(await asAlice(read, [planId])).toEqual([{ next: 'discharged' }])
      expect(await asDoctorA(read, [planId])).toEqual([{ next: 'discharged' }])
      for (const userId of [fx.bobUserId, fx.doctorBUserId, doctorDUserId, fx.adminUserId]) {
        await expectDenied(() => database.asUser(userId, read, [planId]))
      }
      await expectDenied(() => database.asAnon(read, [planId]))
    })
  })

  describe('the patient after discharge', () => {
    it('keeps the account, profile, records and history; only new check-ins stop', async () => {
      await quietOthers()
      const planId = await newPlan()
      const [{ id: logId }] = await asAlice<{ id: string }>(
        `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating)
         values ($1, $2::date, 4) returning recovery_log_id as id`,
        [fx.alicePatId, plusDays(today, -1)],
      )
      const account = () =>
        database.asService(
          `select to_jsonb(p) as patient, to_jsonb(u) as account
             from public.patient p join public.user_account u using (user_id) where p.pat_id = $1`,
          [fx.alicePatId],
        )
      const records = () =>
        database.asService(
          `select (select count(*) from public.recovery_log where pat_id = $1)::int as logs,
                  (select count(*) from public.appointment where pat_id = $1)::int as appointments,
                  (select count(*) from public.prescription where pat_id = $1)::int as prescriptions,
                  (select count(*) from public.medication_schedule ms join public.prescription pr using (prescription_id)
                    where pr.pat_id = $1)::int as schedules`,
          [fx.alicePatId],
        )
      const [beforeAccount, beforeRecords] = [await account(), await records()]

      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])

      expect(await account()).toEqual(beforeAccount)
      expect(await records()).toEqual(beforeRecords)
      expect(await asAlice('select 1 from public.treatment_plan where treatment_plan_id = $1', [planId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.recovery_log where recovery_log_id = $1', [logId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.prescription where pat_id = $1', [fx.alicePatId])).not.toHaveLength(0)

      await expect(
        asAlice(
          `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating) values ($1, $2::date, 3)`,
          [fx.alicePatId, today],
        ),
      ).rejects.toThrow(ENDED)
      await expect(
        asAlice('update public.recovery_log set recovery_log_mood_rating = 1 where recovery_log_id = $1', [logId]),
      ).rejects.toThrow(ENDED)

      // Reopened, the check-ins come back.
      await asDoctorA(REOPEN, [planId])
      await asAlice(
        `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating) values ($1, $2::date, 3)`,
        [fx.alicePatId, plusDays(today, -2)],
      )
      await asAlice('update public.recovery_log set recovery_log_mood_rating = 2 where recovery_log_id = $1', [logId])
    })

    it('blocks check-ins only when no plan is active, and never for a patient with no plans', async () => {
      await quietOthers()
      const insert = (daysAgo: number) =>
        database.asUser(
          fx.bobUserId,
          `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating) values ($1, $2::date, 3)`,
          [fx.bobPatId, plusDays(today, -daysAgo)],
        )
      const bobLogs = async () =>
        (await database.asService<{ n: number }>('select count(*)::int as n from public.recovery_log where pat_id = $1', [fx.bobPatId]))[0]!.n
      const before = await bobLogs()

      await insert(9) // no plans
      const first = await newPlan(fx.bobPatId)
      await insert(8) // an active plan

      await asDoctorA(DISCHARGE, [first, 'transferred'])
      await expect(insert(7)).rejects.toThrow(ENDED) // discharged, nothing active
      expect(await bobLogs()).toBe(before + 2) // earlier check-ins are kept

      const second = await newPlan(fx.bobPatId)
      await insert(7) // a discharged plan and an active one
      await asDoctorA(DISCHARGE, [second, 'referred'])
      await expect(insert(6)).rejects.toThrow(ENDED)
      await asDoctorA(REOPEN, [second])
      await insert(6) // reopened
      expect(await bobLogs()).toBe(before + 4)
      // The service role (no session) is not held back.
      await database.asService(
        `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating) values ($1, $2::date, 3)`,
        [fx.bobPatId, plusDays(today, -12)],
      )
    })

    it('closes roadmap activities once discharged, and opens them again on reopening', async () => {
      await quietOthers()
      const planId = await newPlan()
      const [{ id: phase }] = await asDoctorA<{ id: string }>(
        `insert into public.recovery_phase (treatment_plan_id, recovery_phase_title) values ($1, 'Initial') returning recovery_phase_id as id`,
        [planId],
      )
      const activity = async (title: string) =>
        (await asDoctorA<{ id: string }>(
          `insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, $2) returning recovery_activity_id as id`,
          [phase, title],
        ))[0]!.id
      const [a1, a2] = [await activity('Rest'), await activity('Ice')]
      await asAlice('select * from public.patient_complete_recovery_activity($1)', [a1])

      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])
      await expect(asAlice('select * from public.patient_complete_recovery_activity($1)', [a2])).rejects.toThrow(/active/)
      await expect(asAlice('select * from public.patient_reopen_recovery_activity($1)', [a1])).rejects.toThrow(/active/)

      await asDoctorA(REOPEN, [planId])
      await asAlice('select * from public.patient_complete_recovery_activity($1)', [a2])
    })

    it('lets the patient book a follow-up, marked for the doctor as after discharge', async () => {
      await quietOthers()
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])
      const [{ id, followUp }] = await asAlice<{ id: string; followUp: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '10 days')
         returning appointment_id as id, appointment_follow_up_of_plan_id as "followUp"`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect(followUp).toBe(planId)
      expect(
        await asDoctorA('select appointment_follow_up_of_plan_id as plan from public.appointment where appointment_id = $1', [id]),
      ).toEqual([{ plan: planId }])
      // A session cannot clear or change the mark; the doctor can still confirm the visit.
      await expect(
        asDoctorA('update public.appointment set appointment_follow_up_of_plan_id = null where appointment_id = $1', [id]),
      ).rejects.toThrow(/follow-up/)
      await asDoctorA(`update public.appointment set appointment_status = 'confirmed' where appointment_id = $1`, [id])

      // The doctor books one too, and it is marked the same way.
      const [{ followUp: byDoctor }] = await asDoctorA<{ followUp: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '12 days') returning appointment_follow_up_of_plan_id as "followUp"`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect(byDoctor).toBe(planId)

      // During care, an appointment is not a follow-up, whatever the caller sends.
      await asDoctorA(REOPEN, [planId])
      const [{ followUp: duringCare }] = await asAlice<{ followUp: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_follow_up_of_plan_id)
         values ($1, $2, now() + interval '11 days', $3)
         returning appointment_follow_up_of_plan_id as "followUp"`,
        [fx.alicePatId, fx.doctorAId, planId],
      )
      expect(duringCare).toBeNull()
      // The earlier follow-up keeps its mark after reopening.
      expect(
        await database.asService('select appointment_follow_up_of_plan_id as plan from public.appointment where appointment_id = $1', [id]),
      ).toEqual([{ plan: planId }])
    })

    it('marks a follow-up with the most recently discharged plan', async () => {
      await quietOthers()
      const older = await newPlan()
      const newer = await newPlan()
      await asDoctorA(DISCHARGE, [older, 'transferred'])
      await database.db.exec(
        `update public.treatment_plan set treatment_plan_discharged_at = treatment_plan_discharged_at - interval '5 days'
          where treatment_plan_status::text = 'discharged'`,
      )
      await asDoctorA(DISCHARGE, [newer, 'withdrew'])
      const [{ followUp }] = await asAlice<{ followUp: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '13 days') returning appointment_follow_up_of_plan_id as "followUp"`,
        [fx.alicePatId, fx.doctorAId],
      )
      expect(followUp).toBe(newer)
    })
  })

  describe('reminders are left as they are', () => {
    it('still reminds a discharged patient of an appointment and a medicine dose', async () => {
      await quietOthers()
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])
      await database.asService('delete from public.notification')
      await database.asService('update public.appointment set appointment_reminder_sent_at = now()')
      await database.asService(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '3 hours')`,
        [fx.alicePatId, fx.doctorAId],
      )
      await database.asService('select public.dispatch_appointment_reminders(24)')
      expect(
        await database.asService(
          `select 1 from public.notification where user_id = $1 and notification_type = 'appointment'`,
          [fx.aliceUserId],
        ),
      ).not.toHaveLength(0)

      // A long-term medicine's dose that came due is still followed up.
      await database.asService('update public.patient set pat_reminder_is_enabled = true where pat_id = $1', [fx.alicePatId])
      await database.asService('delete from public.medication_log where medication_schedule_id = $1', [fx.aliceScheduleId])
      await database.asService(
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         values ($1, now() - interval '45 minutes')`,
        [fx.aliceScheduleId],
      )
      const [{ n }] = await database.asService<{ n: number }>('select public.dispatch_medication_reminders(30) as n')
      expect(Number(n)).toBeGreaterThan(0)
    })
  })
})

describe('migration 61 against the production shape at 53', () => {
  it('applies to plans that are all active, refuses older statuses, and rolls back to exactly what 53 left', async () => {
    const [full, through53] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_53 }),
      createTestDatabase({ stopAfter: MIGRATION_53 }),
    ])
    try {
      const fx = await seedFixture(full)
      const plans = () =>
        full.asService(
          `select treatment_plan_id, treatment_plan_status::text as status, treatment_plan_title as title,
                  treatment_plan_updated_at as updated
             from public.treatment_plan order by 1`,
        )
      const appointments = () => full.asService('select * from public.appointment order by appointment_id')
      const logs = () => full.asService('select * from public.recovery_log order by recovery_log_id')

      // A plan in a status 61 does not keep: it refuses, changing nothing.
      await full.asService(`update public.treatment_plan set treatment_plan_status = 'completed' where treatment_plan_id = $1`, [
        fx.carolPlanId,
      ])
      await expect(full.applyMigration(MIGRATION_61)).rejects.toThrow(/draft, completed or cancelled/)
      expect(await catalog(full)).toEqual(await catalog(through53))

      // Production on 2026-11-19: every plan active.
      await full.asService(`update public.treatment_plan set treatment_plan_status = 'active' where treatment_plan_id = $1`, [
        fx.carolPlanId,
      ])
      const [beforePlans, beforeAppointments, beforeLogs] = [await plans(), await appointments(), await logs()]
      await full.applyMigration(MIGRATION_61)
      const after61 = await catalog(full)
      expect(await plans()).toEqual(beforePlans)
      const withMark = (rows: Record<string, unknown>[]) =>
        rows.map((row) => ({ ...row, appointment_follow_up_of_plan_id: null }))
      expect(await appointments()).toEqual(withMark(beforeAppointments))
      expect(await logs()).toEqual(beforeLogs)
      expect(await full.asService('select count(*)::int as n from public.treatment_plan_lifecycle_event')).toEqual([{ n: 0 }])
      const [{ timeout }] = await full.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')

      // Re-running it changes nothing.
      await full.applyMigration(MIGRATION_61)
      expect(await catalog(full)).toEqual(after61)

      // The rollback refuses while a plan is discharged.
      await full.asUser(fx.doctorAUserId, DISCHARGE, [fx.alicePlanId, 'completed_recovery'])
      await expect(full.db.exec(await script(ROLLBACK_61))).rejects.toThrow(/discharged; reopen each first/)
      expect(await catalog(full)).toEqual(after61)

      // Reopened, it returns the schema to exactly what 53 left, keeping every row.
      await full.asUser(fx.doctorAUserId, REOPEN, [fx.alicePlanId])
      const keptPlans = (await plans()).map(({ updated: _updated, ...row }) => row)
      await full.db.exec(await script(ROLLBACK_61))
      expect(await catalog(full)).toEqual(await catalog(through53))
      expect((await plans()).map(({ updated: _updated, ...row }) => row)).toEqual(keptPlans)
      expect(await logs()).toEqual(beforeLogs)
      expect(await full.asService('select count(*)::int as n from public.appointment')).toEqual([{ n: beforeAppointments.length }])
      await expect(full.db.exec(await script(ROLLBACK_61))).rejects.toThrow(/Migration 61 is not applied/)

      // And it applies again cleanly.
      await full.applyMigration(MIGRATION_61)
      expect(await catalog(full)).toEqual(after61)
    } finally {
      await Promise.all([full.close(), through53.close()])
    }
  })
})
