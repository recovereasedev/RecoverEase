import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 57: a treatment plan's case lifecycle. ACTIVE → READY FOR
 * DISCHARGE (the system's daily flag, never a discharge) → DISCHARGED (the
 * patient's assigned, active doctor only, with a reason), and back to ACTIVE
 * when that doctor reopens it. Every move is kept in an append-only history.
 * The patient's account is never touched; once their care has ended they
 * keep their records and can book a follow-up, but cannot log new check-ins.
 */

const MIGRATION_56 = '20260902100056'
const MIGRATION_57 = '20260902100057'
const ROLLBACK_57 = 'supabase/rollbacks/20260902100057_discharge_reopen_treatment_case.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const DISCHARGE = 'select * from public.doctor_discharge_treatment_plan($1, $2)'
const REOPEN = 'select * from public.doctor_reopen_treatment_plan($1)'
const READY_JOB = 'select public.mark_treatment_plans_ready_for_discharge() as changed'
const ENDED = /Your care plan has ended\. Book a follow-up if you need more care\./

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type PlanRow = { status: string; reason: string | null; discharged: boolean }
type EventRow = { previous: string | null; next: string; reason: string | null; actor: string | null; source: string }

describe('the treatment case lifecycle (migration 57)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string
  let doctorDUserId: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)

  /** A new plan for a patient of doctorA (Alice by default), as the service. */
  const newPlan = async (
    options: { patId?: string; status?: string; start?: string; end?: string | null } = {},
  ) => {
    const [{ id }] = await database.asService<{ id: string }>(
      `insert into public.treatment_plan
         (pat_id, doc_id, treatment_plan_title, treatment_plan_status, treatment_plan_start_date, treatment_plan_end_date)
       values ($1, $2, 'Knee plan', $3::public.treatment_plan_status, $4::date, $5::date)
       returning treatment_plan_id as id`,
      [options.patId ?? fx.alicePatId, fx.doctorAId, options.status ?? 'active', options.start ?? plusDays(today, -30), options.end ?? null],
    )
    return id
  }
  const addGoal = async (planId: string, status = 'pending') => {
    const [{ id }] = await database.asService<{ id: string }>(
      `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_status)
       values ($1, 'Walk unaided', $2::public.treatment_goal_status) returning treatment_goal_id as id`,
      [planId, status],
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
      `select treatment_plan_previous_status::text as previous, treatment_plan_new_status::text as next, treatment_plan_closure_reason as reason,
              treatment_plan_changed_by as actor, treatment_plan_change_source as source
         from public.treatment_plan_lifecycle_event
        where treatment_plan_id = $1
        order by treatment_plan_changed_at, treatment_plan_lifecycle_event_id`,
      [planId],
    )
  const runJob = async () => Number((await database.asService<{ changed: number }>(READY_JOB))[0]!.changed)
  /** Plans other tests left open are closed first, so a job run counts only this test's. */
  const quietOthers = async (...keep: string[]) => {
    await database.asService(
      `update public.treatment_plan set treatment_plan_status = 'cancelled'
        where treatment_plan_status in ('active', 'ready_for_discharge') and not (treatment_plan_id = any($1::uuid[]))`,
      [keep],
    )
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    ;[{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')

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

    it('discharges a plan that is ready for discharge', async () => {
      const planId = await newPlan({ status: 'ready_for_discharge' })
      await asDoctorA(DISCHARGE, [planId, 'referred'])
      expect(await plan(planId)).toEqual({ status: 'discharged', reason: 'referred', discharged: true })
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
      expect((await plan(planId)).status).toBe('active')
    })

    it('refuses the patient, another doctor, a doctor elsewhere, a deactivated doctor, the Clinic Admin and a visitor', async () => {
      const planId = await newPlan()
      for (const userId of [fx.aliceUserId, fx.bobUserId, fx.doctorBUserId, doctorDUserId, fx.doctorCUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, DISCHARGE, [planId, 'transferred'])).rejects.toThrow(/assigned doctor/)
      }
      await expect(database.asAnon(DISCHARGE, [planId, 'transferred'])).rejects.toThrow(/permission denied|assigned doctor/)
      expect((await plan(planId)).status).toBe('active')
      expect(await events(planId)).toEqual([])
    })

    it('discharges only an open plan', async () => {
      for (const status of ['draft', 'completed', 'cancelled', 'discharged']) {
        const planId = await newPlan({ status: status === 'discharged' ? 'active' : status })
        if (status === 'discharged') await asDoctorA(DISCHARGE, [planId, 'withdrew'])
        await expect(asDoctorA(DISCHARGE, [planId, 'withdrew'])).rejects.toThrow(/only an active plan|ready for discharge/)
      }
    })

    it('reopens a discharged plan, clearing the reason and time, and keeps every event through repeated cycles', async () => {
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'lost_to_follow_up'])
      await asDoctorA(REOPEN, [planId])
      expect(await plan(planId)).toEqual({ status: 'active', reason: null, discharged: false })
      await asDoctorA(DISCHARGE, [planId, 'transferred'])
      await asDoctorA(REOPEN, [planId])
      expect((await events(planId)).map((event) => [event.previous, event.next, event.reason])).toEqual([
        ['active', 'discharged', 'lost_to_follow_up'],
        ['discharged', 'active', null],
        ['active', 'discharged', 'transferred'],
        ['discharged', 'active', null],
      ])
    })

    it('reopens only a discharged plan, and only for its assigned doctor', async () => {
      const active = await newPlan()
      const ready = await newPlan({ status: 'ready_for_discharge' })
      await expect(asDoctorA(REOPEN, [active])).rejects.toThrow(/only a discharged plan/)
      await expect(asDoctorA(REOPEN, [ready])).rejects.toThrow(/only a discharged plan/)
      expect((await plan(ready)).status).toBe('ready_for_discharge')

      const closed = await newPlan()
      await asDoctorA(DISCHARGE, [closed, 'withdrew'])
      for (const userId of [fx.aliceUserId, fx.doctorBUserId, doctorDUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, REOPEN, [closed])).rejects.toThrow(/assigned doctor/)
      }
      expect((await plan(closed)).status).toBe('discharged')
    })

    it('refuses every direct write that would bypass the lifecycle', async () => {
      const planId = await newPlan()
      for (const change of [
        "treatment_plan_status = 'discharged', treatment_plan_closure_reason = 'withdrew', treatment_plan_discharged_at = now()",
        "treatment_plan_status = 'ready_for_discharge'",
        "treatment_plan_closure_reason = 'withdrew'",
        'treatment_plan_discharged_at = now()',
      ]) {
        await expect(
          asDoctorA(`update public.treatment_plan set ${change} where treatment_plan_id = $1`, [planId]),
        ).rejects.toThrow(/discharge|lifecycle/)
      }
      await asDoctorA(DISCHARGE, [planId, 'withdrew'])
      await expect(
        asDoctorA(`update public.treatment_plan set treatment_plan_status = 'active' where treatment_plan_id = $1`, [planId]),
      ).rejects.toThrow(/discharge|lifecycle/)
      await expect(
        asDoctorA(
          `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_status)
           values ($1, $2, 'Shortcut', 'discharged')`,
          [fx.alicePatId, fx.doctorAId],
        ),
      ).rejects.toThrow(/discharge|lifecycle/)
      // The patient has no update path at all.
      await expectDenied(() =>
        asAlice(`update public.treatment_plan set treatment_plan_status = 'active' where treatment_plan_id = $1 returning *`, [planId]),
      )
      expect((await plan(planId)).status).toBe('discharged')
      // Even the owner cannot leave a discharge without its reason and time.
      const other = await newPlan()
      await expect(
        database.asService(`update public.treatment_plan set treatment_plan_status = 'discharged' where treatment_plan_id = $1`, [other]),
      ).rejects.toThrow(/check constraint/)
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
    })
  })

  describe('the daily readiness check', () => {
    it('flags an active plan whose end date is before the clinic’s today, not one ending today', async () => {
      const past = await newPlan({ end: plusDays(today, -1) })
      const endingToday = await newPlan({ end: today })
      await quietOthers(past, endingToday)
      expect(await runJob()).toBe(1)
      expect((await plan(past)).status).toBe('ready_for_discharge')
      expect((await plan(endingToday)).status).toBe('active')
      expect(await events(past)).toEqual([{ previous: 'active', next: 'ready_for_discharge', reason: null, actor: null, source: 'system' }])
    })

    it('flags a plan once every goal is achieved, and not for a missed or pending one or no goals', async () => {
      const allAchieved = await newPlan()
      await addGoal(allAchieved, 'achieved')
      await addGoal(allAchieved, 'achieved')
      const oneMissed = await newPlan()
      await addGoal(oneMissed, 'achieved')
      await addGoal(oneMissed, 'missed')
      const onePending = await newPlan()
      await addGoal(onePending, 'achieved')
      await addGoal(onePending, 'pending')
      const noGoals = await newPlan()
      await quietOthers(allAchieved, oneMissed, onePending, noGoals)
      expect(await runJob()).toBe(1)
      expect((await plan(allAchieved)).status).toBe('ready_for_discharge')
      for (const planId of [oneMissed, onePending, noGoals]) expect((await plan(planId)).status).toBe('active')
    })

    it('never flags a draft, completed, cancelled or discharged plan, and never discharges', async () => {
      const ids: string[] = []
      for (const status of ['draft', 'completed', 'cancelled']) ids.push(await newPlan({ status, end: plusDays(today, -5) }))
      const discharged = await newPlan({ end: plusDays(today, -5) })
      await asDoctorA(DISCHARGE, [discharged, 'withdrew'])
      const eligible = await newPlan({ end: plusDays(today, -5) })
      await quietOthers(...ids, discharged, eligible)
      const before = await database.asService<{ n: number }>(
        `select count(*)::int as n from public.treatment_plan where treatment_plan_status = 'discharged'`,
      )
      await runJob()
      expect((await Promise.all(ids.map(plan))).map((row) => row.status)).toEqual(['draft', 'completed', 'cancelled'])
      expect((await plan(discharged)).status).toBe('discharged')
      expect((await plan(eligible)).status).toBe('ready_for_discharge')
      expect(
        await database.asService(`select count(*)::int as n from public.treatment_plan where treatment_plan_status = 'discharged'`),
      ).toEqual(before)
    })

    it('tells the assigned doctor once, and the patient nothing, however often it runs', async () => {
      const planId = await newPlan({ end: plusDays(today, -2) })
      await quietOthers(planId)
      await database.asService('delete from public.notification')
      await runJob()
      await runJob()
      expect(await runJob()).toBe(0)
      const sent = await database.asService<{ user_id: string; type: string; message: string }>(
        `select user_id, notification_type::text as type, notification_message as message from public.notification`,
      )
      expect(sent).toEqual([
        { user_id: fx.doctorAUserId, type: 'treatment', message: expect.stringMatching(/ready for discharge review/) },
      ])
      expect(sent[0]!.message).not.toMatch(/discharged/)
      expect(await events(planId)).toHaveLength(1)
    })

    it('waits while the assigned doctor is deactivated, then flags and tells an active doctor', async () => {
      // Dave's doctor (doctorC) is deactivated: no one can review a discharge,
      // so the plan stays active and no notification goes to a closed account.
      const [{ id: planId }] = await database.asService<{ id: string }>(
        `insert into public.treatment_plan
           (pat_id, doc_id, treatment_plan_title, treatment_plan_status, treatment_plan_start_date, treatment_plan_end_date)
         values ($1, $2, 'Hip plan', 'active', $3::date, $4::date) returning treatment_plan_id as id`,
        [fx.davePatId, fx.doctorCId, plusDays(today, -30), plusDays(today, -2)],
      )
      await quietOthers(planId)
      await database.asService('delete from public.notification')
      expect(await runJob()).toBe(0)
      expect((await plan(planId)).status).toBe('active')
      expect(await events(planId)).toEqual([])
      expect(await database.asService('select 1 from public.notification')).toEqual([])

      // Once the patient's doctor is active again, the next run flags it for them.
      const setActive = (active: boolean) =>
        database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = $1 where doc_id = $2', [active, fx.doctorCId])
      await setActive(true)
      try {
        expect(await runJob()).toBe(1)
        expect((await plan(planId)).status).toBe('ready_for_discharge')
        expect(await database.asService<{ user_id: string }>('select user_id from public.notification')).toEqual([
          { user_id: fx.doctorCUserId },
        ])
      } finally {
        await setActive(false)
      }
    })

    it('uses each clinic’s own day', async () => {
      // A patient of a doctor in a UTC+14 clinic: "yesterday" and "today"
      // are that clinic's, whatever the server's date.
      const kiri = await addClinic(database, 'Line Islands Clinic', 'Pacific/Kiritimati')
      const [{ kiriToday }] = await database.asService<{ kiriToday: string }>(
        'select app_private.clinic_today($1)::text as "kiriToday"',
        [kiri],
      )
      const account = async (email: string, role: string) => {
        const [{ id }] = await database.asService<{ id: string }>(
          'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
          [email],
        )
        await database.asService('insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)', [
          id,
          email,
          role,
        ])
        return id
      }
      const doctorUser = await account('kai@line.test', 'doctor')
      const [{ doc }] = await database.asService<{ doc: string }>(
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
         values ($1, 'Kai', 'Tane', 'LIC-K-001', true, $2) returning doc_id as doc`,
        [doctorUser, kiri],
      )
      const patientUser = await account('tia@line.test', 'patient')
      const [{ pat }] = await database.asService<{ pat: string }>(
        `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
         values ($1, $2, 'Tia', 'Rua', now()) returning pat_id as pat`,
        [patientUser, doc],
      )
      const kiriPlan = async (end: string) =>
        (await database.asService<{ id: string }>(
          `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date, treatment_plan_end_date)
           values ($1, $2, 'Line plan', $3::date, $4::date) returning treatment_plan_id as id`,
          [pat, doc, plusDays(kiriToday, -30), end],
        ))[0]!.id
      const yesterday = await kiriPlan(plusDays(kiriToday, -1))
      const endsToday = await kiriPlan(kiriToday)
      await quietOthers(yesterday, endsToday)
      await database.asService('delete from public.notification')
      expect(await runJob()).toBe(1)
      expect((await plan(yesterday)).status).toBe('ready_for_discharge')
      expect((await plan(endsToday)).status).toBe('active')
      // Its own assigned doctor is told.
      expect(await database.asService('select user_id from public.notification')).toEqual([{ user_id: doctorUser }])
    })

    it('is for the service role only', async () => {
      for (const run of [() => asDoctorA(READY_JOB), () => asAlice(READY_JOB), () => database.asAnon(READY_JOB)]) {
        await expect(run()).rejects.toThrow(/permission denied/)
      }
    })
  })

  describe('the patient after discharge', () => {
    it('keeps the account, profile, records and history; only new check-ins stop', async () => {
      await quietOthers()
      const planId = await newPlan()
      await addGoal(planId, 'achieved')
      const [{ id: logId }] = await asAlice<{ id: string }>(
        `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating)
         values ($1, $2::date, 4) returning recovery_log_id as id`,
        [fx.alicePatId, plusDays(today, -1)],
      )
      const account = () =>
        database.asService(
          `select to_jsonb(p) as patient, to_jsonb(u) as account, p.pat_status::text as status
             from public.patient p join public.user_account u using (user_id) where p.pat_id = $1`,
          [fx.alicePatId],
        )
      const before = await account()

      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])

      expect(await account()).toEqual(before)
      expect(before[0]).toMatchObject({ status: 'active' })
      expect(await asAlice('select 1 from public.patient where pat_id = $1', [fx.alicePatId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.treatment_plan where treatment_plan_id = $1', [planId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.treatment_goal where treatment_plan_id = $1', [planId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.recovery_phase where treatment_plan_id = $1', [planId])).not.toHaveLength(0)
      expect(await asAlice('select 1 from public.recovery_log where recovery_log_id = $1', [logId])).toHaveLength(1)
      expect(await asAlice('select 1 from public.appointment where pat_id = $1', [fx.alicePatId])).not.toHaveLength(0)

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

    it('blocks check-ins only when no other care is open, and never for a patient with no plans', async () => {
      await quietOthers()
      // Bob starts with no plans; one check-in per day, so each step uses its own day.
      const insert = (daysAgo: number) =>
        database.asUser(
          fx.bobUserId,
          `insert into public.recovery_log (pat_id, recovery_log_date, recovery_log_mood_rating) values ($1, $2::date, 3)`,
          [fx.bobPatId, plusDays(today, -daysAgo)],
        )
      const bobLogs = async () =>
        (await database.asService<{ n: number }>('select count(*)::int as n from public.recovery_log where pat_id = $1', [fx.bobPatId]))[0]!.n

      await insert(6) // no plans
      await newPlan({ patId: fx.bobPatId, status: 'completed' })
      await newPlan({ patId: fx.bobPatId, status: 'cancelled' })
      await insert(5) // only completed and cancelled plans
      const first = await newPlan({ patId: fx.bobPatId })
      await insert(4) // an active plan

      await asDoctorA(DISCHARGE, [first, 'transferred'])
      await expect(insert(3)).rejects.toThrow(ENDED) // discharged, nothing else open
      expect(await bobLogs()).toBe(3) // earlier check-ins are kept

      const second = await newPlan({ patId: fx.bobPatId })
      await insert(3) // a discharged plan and an active one
      await asDoctorA(DISCHARGE, [second, 'referred'])
      await expect(insert(2)).rejects.toThrow(ENDED)
      await newPlan({ patId: fx.bobPatId, status: 'ready_for_discharge' })
      await insert(2) // ready for discharge is still open care
      expect(await bobLogs()).toBe(5)
    })

    it('keeps activities and goal progress open while ready, and closes them once discharged', async () => {
      const planId = await newPlan({ status: 'ready_for_discharge' })
      const goalId = await addGoal(planId, 'pending')
      const [{ phase }] = await database.asService<{ phase: string }>(
        `select recovery_phase_id as phase from public.recovery_phase
          where treatment_plan_id = $1 and recovery_phase_kind = 'initial'`,
        [planId],
      )
      const [{ id: a1 }] = await asDoctorA<{ id: string }>(
        `insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'Rest') returning recovery_activity_id as id`,
        [phase],
      )
      const [{ id: a2 }] = await asDoctorA<{ id: string }>(
        `insert into public.recovery_activity (recovery_phase_id, recovery_activity_title) values ($1, 'Ice') returning recovery_activity_id as id`,
        [phase],
      )
      await asAlice('select * from public.patient_complete_recovery_activity($1)', [a1])
      await asAlice(`select * from public.patient_update_treatment_goal_status($1, 'in_progress')`, [goalId])

      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])
      await expect(asAlice('select * from public.patient_complete_recovery_activity($1)', [a2])).rejects.toThrow(/active/)
      await expect(asAlice('select * from public.patient_reopen_recovery_activity($1)', [a1])).rejects.toThrow(/active/)
      await expect(asAlice(`select * from public.patient_update_treatment_goal_status($1, 'achieved')`, [goalId])).rejects.toThrow(
        /active/,
      )
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
      // It never becomes the roadmap's chosen follow-up by itself.
      expect(
        await database.asService('select treatment_plan_follow_up_appointment_id as id from public.treatment_plan where treatment_plan_id = $1', [
          planId,
        ]),
      ).toEqual([{ id: null }])
      // A session cannot set or change the mark.
      await expect(
        asDoctorA('update public.appointment set appointment_follow_up_of_plan_id = null where appointment_id = $1', [id]),
      ).rejects.toThrow(/follow-up/)

      await asDoctorA(REOPEN, [planId])
      const [{ followUp: duringCare }] = await asAlice<{ followUp: string | null }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_follow_up_of_plan_id)
         values ($1, $2, now() + interval '11 days', $3)
         returning appointment_follow_up_of_plan_id as "followUp"`,
        [fx.alicePatId, fx.doctorAId, planId],
      )
      expect(duringCare).toBeNull()
    })
  })

  describe('reminders', () => {
    it('keeps appointment reminders for a discharged patient', async () => {
      await quietOthers()
      const planId = await newPlan()
      await asDoctorA(DISCHARGE, [planId, 'completed_recovery'])
      await database.asService('delete from public.notification')
      await database.asService(`update public.appointment set appointment_reminder_sent_at = now() where pat_id <> $1`, [fx.alicePatId])
      await database.asService(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '3 hours')`,
        [fx.alicePatId, fx.doctorAId],
      )
      await database.asService('select public.dispatch_appointment_reminders(24)')
      const reminders = await database.asService(
        `select 1 from public.notification where user_id = $1 and notification_type = 'appointment'`,
        [fx.aliceUserId],
      )
      expect(reminders.length).toBeGreaterThan(0)
    })

    it('stops marking a discharged plan’s goals missed, and starts again once reopened', async () => {
      const planId = await newPlan()
      const goalId = await addGoal(planId, 'pending')
      await database.asService(
        `update public.treatment_goal set treatment_goal_target_date = $2::date where treatment_goal_id = $1`,
        [goalId, plusDays(today, -3)],
      )
      const status = async () =>
        (await database.asService<{ s: string }>(
          'select treatment_goal_status::text as s from public.treatment_goal where treatment_goal_id = $1',
          [goalId],
        ))[0]!.s
      await asDoctorA(DISCHARGE, [planId, 'withdrew'])
      await database.asService('select public.mark_missed_treatment_goals()')
      expect(await status()).toBe('pending')
      await asDoctorA(REOPEN, [planId])
      await database.asService('select public.mark_missed_treatment_goals()')
      expect(await status()).toBe('missed')
    })
  })
})

describe('migration 57, before and after', () => {
  it('leaves existing plans as they were, and rolls back to exactly what 56 left', async () => {
    const [full, through56] = await Promise.all([createTestDatabase(), createTestDatabase({ stopAfter: MIGRATION_56 })])
    try {
      const fx = await seedFixture(full)
      const after57 = await catalog(full)
      await full.asService(`update public.treatment_plan set treatment_plan_status = 'completed' where treatment_plan_id = $1`, [
        fx.carolPlanId,
      ])
      const plans = () =>
        full.asService(
          `select treatment_plan_id, treatment_plan_status::text as status from public.treatment_plan
            where treatment_plan_status::text not in ('ready_for_discharge', 'discharged') order by 1`,
        )
      const before = await plans()
      await full.asUser(fx.doctorAUserId, DISCHARGE, [fx.alicePlanId, 'completed_recovery'])

      await expect(full.db.exec(await script(ROLLBACK_57))).rejects.toThrow(/discharged or ready/)
      await full.asUser(fx.doctorAUserId, REOPEN, [fx.alicePlanId])
      await full.db.exec(await script(ROLLBACK_57))
      expect(await catalog(full)).toEqual(await catalog(through56))
      expect(await plans()).toEqual(before)
      await expect(full.db.exec(await script(ROLLBACK_57))).rejects.toThrow(/Migration 57 is not applied/)

      await full.applyMigration(MIGRATION_57)
      await full.applyMigration(MIGRATION_57)
      expect(await catalog(full)).toEqual(after57)
      const [{ timeout }] = await full.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')
    } finally {
      await Promise.all([full.close(), through56.close()])
    }
  })
})
