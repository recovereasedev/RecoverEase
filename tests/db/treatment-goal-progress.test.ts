import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 55: treatment goal progress. The doctor sets a goal; the patient
 * records their own progress through one function (pending → in progress →
 * achieved); a scheduled job marks a goal missed once its target date has
 * passed in the clinic's own time zone; and every change is kept in
 * `treatment_goal_status_event`, telling the patient's changes from the
 * system's.
 */

const MIGRATION_55_FILE = 'supabase/migrations/20260902100064_treatment_goal_progress.sql'
const ROLLBACK_55 = 'supabase/rollbacks/20260902100064_treatment_goal_progress.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

// In FROM, as PostgREST calls a function.
const PROGRESS = 'select * from public.patient_update_treatment_goal_status($1, $2::public.treatment_goal_status)'
const MARK_MISSED = 'select public.mark_missed_treatment_goals() as changed'

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type Event = { previous: string | null; next: string; by: string | null; source: string | null }

describe('treatment goal progress (migration 55)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string
  let doctorDUserId: string
  let tokyoPatientUserId: string
  let tokyoPlanId: string
  let tokyoToday: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)

  /** A goal on Alice's plan, written as the service would (any status, any date). */
  const seedGoal = async (status = 'pending', target: string | null = null, planId?: string) =>
    (
      await database.asService<{ id: string }>(
        `insert into public.treatment_goal
           (treatment_plan_id, treatment_goal_description, treatment_goal_target_date, treatment_goal_status)
         values ($1, 'Seeded goal', $2::date, $3::public.treatment_goal_status)
         returning treatment_goal_id as id`,
        [planId ?? fx.alicePlanId, target, status],
      )
    )[0]!.id

  const statusOf = async (goalId: string) =>
    (
      await database.asService<{ status: string }>(
        'select treatment_goal_status::text as status from public.treatment_goal where treatment_goal_id = $1',
        [goalId],
      )
    )[0]!.status

  const history = (goalId: string) =>
    database.asService<Event>(
      `select treatment_goal_previous_status::text as previous,
              treatment_goal_new_status::text as next,
              treatment_goal_changed_by as by,
              treatment_goal_change_source as source
         from public.treatment_goal_status_event
        where treatment_goal_id = $1
        order by treatment_goal_changed_at, treatment_goal_status_event_id`,
      [goalId],
    )

  /** The job, as pg_cron runs it: the owner, with no signed-in user. */
  const runJob = async () => (await database.asService<{ changed: number }>(MARK_MISSED))[0]!.changed

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    ;[{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')

    // A second clinic, a day ahead of most of the world, with its own
    // active doctor and patient.
    await liftSingleClinicGate(database)
    const tokyo = await addClinic(database, 'Second Street Clinic', 'Pacific/Kiritimati')
    ;[{ id: doctorDUserId }] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'doctor.d@second.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'doctor.d@second.test', 'doctor')`,
      [doctorDUserId],
    )
    const [{ id: doctorDId }] = await database.asService<{ id: string }>(
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Dana', 'Lim', 'LIC-D-001', true, $2) returning doc_id as id`,
      [doctorDUserId, tokyo],
    )
    ;[{ id: tokyoPatientUserId }] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'erin@second.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'erin@second.test', 'patient')`,
      [tokyoPatientUserId],
    )
    const [{ id: erinPatId }] = await database.asService<{ id: string }>(
      `insert into public.patient (user_id, pat_first_name, pat_last_name, doc_id)
       values ($1, 'Erin', 'Sato', $2) returning pat_id as id`,
      [tokyoPatientUserId, doctorDId],
    )
    ;[{ id: tokyoPlanId }] = await database.asService<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date)
       values ($1, $2, 'Shoulder recovery', current_date - 30) returning treatment_plan_id as id`,
      [erinPatId, doctorDId],
    )
    ;[{ tokyoToday }] = await database.asService<{ tokyoToday: string }>(
      'select app_private.clinic_today($1)::text as "tokyoToday"',
      [tokyo],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('the doctor creates goals', () => {
    it('1. lets the assigned doctor add a goal for their own patient, starting pending', async () => {
      const [goal] = await asDoctorA<{ id: string; status: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
         values ($1, 'Climb one flight of stairs', $2::date)
         returning treatment_goal_id as id, treatment_goal_status::text as status`,
        [fx.alicePlanId, plusDays(today, 14)],
      )
      expect(goal!.status).toBe('pending')
      // The patient sees it.
      const seen = await asAlice('select 1 from public.treatment_goal where treatment_goal_id = $1', [goal!.id])
      expect(seen).toHaveLength(1)
    })

    it('2. refuses a goal on another clinic\'s patient, another doctor\'s patient, or as a patient', async () => {
      const insert = `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description)
                      values ($1, 'Not mine') returning treatment_goal_id`
      await expect(asDoctorA(insert, [tokyoPlanId])).rejects.toThrow(/row-level security/)
      await expect(database.asUser(doctorDUserId, insert, [fx.alicePlanId])).rejects.toThrow(/row-level security/)
      await expect(database.asUser(fx.doctorBUserId, insert, [fx.alicePlanId])).rejects.toThrow(/row-level security/)
      await expect(asAlice(insert, [fx.alicePlanId])).rejects.toThrow(/row-level security/)
    })

    it('starts every new goal pending and keeps its target date within today and the plan', async () => {
      await expect(
        asDoctorA(
          `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_status)
           values ($1, 'Already done', 'achieved')`,
          [fx.alicePlanId],
        ),
      ).rejects.toThrow(/patient records/)
      await expect(
        asDoctorA(
          `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
           values ($1, 'Yesterday', $2::date)`,
          [fx.alicePlanId, plusDays(today, -1)],
        ),
      ).rejects.toThrow(/target date/)
      // Today is allowed.
      await asDoctorA(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
         values ($1, 'Today', $2::date)`,
        [fx.alicePlanId, today],
      )
      // Past the plan's end date is refused.
      const [{ id: shortPlan }] = await database.asService<{ id: string }>(
        `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date, treatment_plan_end_date)
         values ($1, $2, 'Short plan', $3::date, $4::date) returning treatment_plan_id as id`,
        [fx.alicePatId, fx.doctorAId, today, plusDays(today, 7)],
      )
      await expect(
        asDoctorA(
          `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
           values ($1, 'Too late', $2::date)`,
          [shortPlan, plusDays(today, 8)],
        ),
      ).rejects.toThrow(/target date/)
    })

    it('10. refuses the doctor setting progress, achieved or missed', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      for (const status of ['in_progress', 'achieved', 'missed']) {
        await expect(
          asDoctorA('update public.treatment_goal set treatment_goal_status = $2 where treatment_goal_id = $1', [
            goalId,
            status,
          ]),
        ).rejects.toThrow(/patient records/)
        await expect(asDoctorA(PROGRESS, [goalId, status])).rejects.toThrow(/Only the patient/)
      }
      expect(await statusOf(goalId)).toBe('pending')
      // Legitimate editing still works.
      await asDoctorA('update public.treatment_goal set treatment_goal_description = $2 where treatment_goal_id = $1', [
        goalId,
        'Seeded goal, reworded',
      ])
    })
  })

  describe('the patient records progress', () => {
    it('3–4. moves their own goal pending → in progress → achieved, persisted', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      const [started] = await asAlice<{ treatment_goal_status: string }>(PROGRESS, [goalId, 'in_progress'])
      expect(started!.treatment_goal_status).toBe('in_progress')
      const [done] = await asAlice<{ treatment_goal_status: string }>(PROGRESS, [goalId, 'achieved'])
      expect(done!.treatment_goal_status).toBe('achieved')
      // Read back in a later session.
      const [row] = await asAlice<{ status: string }>(
        'select treatment_goal_status::text as status from public.treatment_goal where treatment_goal_id = $1',
        [goalId],
      )
      expect(row!.status).toBe('achieved')
    })

    it('may mark a pending goal achieved directly, but refuses going back or repeating', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      await asAlice(PROGRESS, [goalId, 'achieved'])
      await expect(asAlice(PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/cannot move/)
      await expect(asAlice(PROGRESS, [goalId, 'achieved'])).rejects.toThrow(/already/)
    })

    it('5. refuses another patient\'s goal, a guessed id and a goal that does not exist', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      await expect(database.asUser(fx.bobUserId, PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/Only the patient/)
      await expect(database.asUser(tokyoPatientUserId, PROGRESS, [goalId, 'achieved'])).rejects.toThrow(/Only the patient/)
      await expect(
        asAlice(PROGRESS, ['00000000-0000-4000-8000-000000000000', 'in_progress']),
      ).rejects.toThrow(/Only the patient/)
      expect(await statusOf(goalId)).toBe('pending')
    })

    it('6–8. cannot change the description, target date, plan, phase or status directly', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      // Migration 56 gives every goal its own generated roadmap phase.
      const [{ phase }] = await database.asService<{ phase: string }>(
        'select recovery_phase_id as phase from public.treatment_goal where treatment_goal_id = $1',
        [goalId],
      )
      for (const change of [
        "treatment_goal_description = 'Rewritten'",
        `treatment_goal_target_date = '${plusDays(today, 60)}'`,
        `treatment_plan_id = '${fx.carolPlanId}'`,
        'recovery_phase_id = null',
        "treatment_goal_status = 'achieved'",
        'treatment_goal_id = gen_random_uuid()',
      ]) {
        await expectDenied(() =>
          asAlice(`update public.treatment_goal set ${change} where treatment_goal_id = $1 returning *`, [goalId]),
        )
      }
      await expectDenied(() => asAlice('delete from public.treatment_goal where treatment_goal_id = $1 returning *', [goalId]))
      const [row] = await database.asService<Record<string, unknown>>(
        `select treatment_goal_description, treatment_goal_target_date::text as target, treatment_plan_id,
                recovery_phase_id, treatment_goal_status::text as status
           from public.treatment_goal where treatment_goal_id = $1`,
        [goalId],
      )
      expect(row).toEqual({
        treatment_goal_description: 'Seeded goal',
        target: plusDays(today, 10),
        treatment_plan_id: fx.alicePlanId,
        recovery_phase_id: phase,
        status: 'pending',
      })
      // The function itself takes only a status.
      await expect(asAlice(PROGRESS, [goalId, 'pending'])).rejects.toThrow(/cannot move/)
    })

    it('9. cannot set missed', async () => {
      const goalId = await seedGoal('in_progress', plusDays(today, 10))
      await expect(asAlice(PROGRESS, [goalId, 'missed'])).rejects.toThrow(/missed/)
      expect(await statusOf(goalId)).toBe('in_progress')
    })

    it('refuses progress while the plan is not active', async () => {
      const [{ id: closedPlan }] = await database.asService<{ id: string }>(
        `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_status, treatment_plan_start_date)
         values ($1, $2, 'Closed plan', 'active', $3::date) returning treatment_plan_id as id`,
        [fx.alicePatId, fx.doctorAId, today],
      )
      // A plan is active or discharged (migration 60); the doctor closes this one.
      await database.asUser(fx.doctorAUserId, 'select public.doctor_discharge_treatment_plan($1, $2)', [closedPlan, 'withdrew'])
      const goalId = await seedGoal('pending', null, closedPlan)
      await expect(asAlice(PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/active/)
    })

    it('11. refuses visitors, the Clinic Admin and a deactivated doctor', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 10))
      await expect(database.asAnon(PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/permission denied/)
      await expect(database.asUser(fx.adminUserId, PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/Only the patient/)
      await expect(database.asUser(fx.doctorCUserId, PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/Only the patient/)
      // Nobody but the service may run the job, or write the history.
      for (const run of [
        () => database.asAnon(MARK_MISSED),
        () => asAlice(MARK_MISSED),
        () => asDoctorA(MARK_MISSED),
        () => database.asUser(fx.adminUserId, MARK_MISSED),
      ]) {
        await expect(run()).rejects.toThrow(/permission denied/)
      }
      await expect(
        asAlice(
          `insert into public.treatment_goal_status_event (treatment_goal_id, treatment_goal_new_status) values ($1, 'achieved')`,
          [goalId],
        ),
      ).rejects.toThrow(/permission denied/)
      expect(await statusOf(goalId)).toBe('pending')
    })

    it('completes a missed goal late, keeping the missed event', async () => {
      const goalId = await seedGoal('pending', plusDays(today, -3))
      expect(await runJob()).toBeGreaterThanOrEqual(1)
      await expect(asAlice(PROGRESS, [goalId, 'in_progress'])).rejects.toThrow(/cannot move/)
      await asAlice(PROGRESS, [goalId, 'achieved'])
      expect((await history(goalId)).map((e) => e.next)).toEqual(['pending', 'missed', 'achieved'])
      // The job leaves it achieved.
      await runJob()
      expect(await statusOf(goalId)).toBe('achieved')
    })
  })

  describe('the missed job', () => {
    it('12–16. marks only overdue goals that are neither achieved nor missed, in the clinic\'s date', async () => {
      const future = await seedGoal('pending', plusDays(today, 1))
      const dueToday = await seedGoal('in_progress', today)
      const overduePending = await seedGoal('pending', plusDays(today, -1))
      const overdueStarted = await seedGoal('in_progress', plusDays(today, -40))
      const achieved = await seedGoal('achieved', plusDays(today, -5))
      const undated = await seedGoal('pending', null)
      // Erin's clinic is ahead: her "today" is not yet overdue, her yesterday is.
      const erinToday = await seedGoal('pending', tokyoToday, tokyoPlanId)
      const erinYesterday = await seedGoal('pending', plusDays(tokyoToday, -1), tokyoPlanId)

      await runJob()

      expect(await statusOf(future)).toBe('pending')
      expect(await statusOf(dueToday)).toBe('in_progress')
      expect(await statusOf(overduePending)).toBe('missed')
      expect(await statusOf(overdueStarted)).toBe('missed')
      expect(await statusOf(achieved)).toBe('achieved')
      expect(await statusOf(undated)).toBe('pending')
      expect(await statusOf(erinToday)).toBe('pending')
      expect(await statusOf(erinYesterday)).toBe('missed')
    })

    it('17. is idempotent: a second run changes nothing and writes no event', async () => {
      const goalId = await seedGoal('pending', plusDays(today, -2))
      await runJob()
      const [{ count: before }] = await database.asService<{ count: number }>(
        'select count(*)::int as count from public.treatment_goal_status_event',
      )
      expect(await runJob()).toBe(0)
      expect(await runJob()).toBe(0)
      const [{ count: after }] = await database.asService<{ count: number }>(
        'select count(*)::int as count from public.treatment_goal_status_event',
      )
      expect(after).toBe(before)
      expect((await history(goalId)).filter((e) => e.next === 'missed')).toHaveLength(1)
    })
  })

  describe('the history', () => {
    it('18. tells the patient\'s changes from the system\'s, inventing no actor', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 2))
      await asAlice(PROGRESS, [goalId, 'in_progress'])
      // The date passes.
      await database.asService(
        'update public.treatment_goal set treatment_goal_target_date = $2::date where treatment_goal_id = $1',
        [goalId, plusDays(today, -1)],
      )
      await runJob()

      expect(await history(goalId)).toEqual([
        { previous: null, next: 'pending', by: null, source: 'service' },
        { previous: 'pending', next: 'in_progress', by: fx.aliceUserId, source: 'user' },
        { previous: 'in_progress', next: 'missed', by: null, source: 'system' },
      ])

      // A doctor's new goal is the doctor's.
      const [{ id: doctorGoal }] = await asDoctorA<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description)
         values ($1, 'Doctor goal') returning treatment_goal_id as id`,
        [fx.alicePlanId],
      )
      expect(await history(doctorGoal)).toEqual([
        { previous: null, next: 'pending', by: fx.doctorAUserId, source: 'user' },
      ])

      // The patient and their doctor read it; another patient does not.
      expect(await asAlice('select 1 from public.treatment_goal_status_event where treatment_goal_id = $1', [goalId])).toHaveLength(3)
      expect(await asDoctorA('select 1 from public.treatment_goal_status_event where treatment_goal_id = $1', [goalId])).toHaveLength(3)
      await expectDenied(() =>
        database.asUser(fx.bobUserId, 'select 1 from public.treatment_goal_status_event where treatment_goal_id = $1', [goalId]),
      )
    })

    it('cannot be labelled system by a signed-in session', async () => {
      const goalId = await seedGoal('pending', plusDays(today, 5))
      // The job's flag, set by the session itself before its own change.
      const { db } = database
      await db.exec('begin')
      try {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.aliceUserId })])
        await db.exec('set local role authenticated')
        await db.query("select set_config('recoverease.goal_status_source', 'system', true)")
        await db.query(PROGRESS, [goalId, 'in_progress'])
        await db.exec('commit')
      } catch (error) {
        await db.exec('rollback')
        throw error
      }
      const events = await history(goalId)
      expect(events.at(-1)).toMatchObject({ next: 'in_progress', source: 'user', by: fx.aliceUserId })
    })

    it('keeps events written before migration 55 with no source', async () => {
      const [{ count }] = await database.asService<{ count: number }>(
        `select count(*)::int as count from public.treatment_goal_status_event
          where treatment_goal_id = $1 and treatment_goal_change_source is null`,
        [fx.aliceGoalId],
      )
      // The fixture's goal was set after 55 replayed, so it has a source;
      // the column itself accepts none for older rows.
      expect(count).toBe(0)
      const [column] = await database.asService<{ nullable: string }>(
        `select is_nullable as nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'treatment_goal_status_event'
            and column_name = 'treatment_goal_change_source'`,
      )
      expect(column!.nullable).toBe('YES')
    })
  })

  describe('the schedule and the privileges', () => {
    it('schedules the job hourly on pg_cron, guarded, and the scheduled command runs', async () => {
      const sql = await script(MIGRATION_55_FILE)
      expect(sql).toMatch(/where name = 'pg_cron'/)
      expect(sql).toMatch(
        /cron\.schedule\(\s*'recoverease-mark-missed-treatment-goals',\s*'10 \* \* \* \*',\s*\$job\$ select public\.mark_missed_treatment_goals\(\) \$job\$\s*\)/,
      )
      // The exact command pg_cron will run, run here as its owner.
      const command = /\$job\$(.*)\$job\$/.exec(sql)![1]!
      await database.asService(command)
      expect(sql.trimStart()).toMatch(/^(--.*\n|\s)*set lock_timeout = '3s';/)
      expect(sql.trimEnd()).toMatch(/reset lock_timeout;$/)
    })

    it('gives every new function an empty search path and only the grants it needs', async () => {
      const rows = await database.asService<{ name: string; definer: boolean; config: string[] | null }>(
        `select p.proname as name, p.prosecdef as definer, p.proconfig as config
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('patient_update_treatment_goal_status', 'mark_missed_treatment_goals',
                              'treatment_goal_guard_progress', 'treatment_goal_record_status')`,
      )
      expect(rows).toHaveLength(4)
      for (const row of rows) expect(row.config).toContain('search_path=""')
      const can = async (role: string, fn: string) =>
        (
          await database.asService<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])
        )[0]!.ok
      const rpc = 'public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status)'
      const job = 'public.mark_missed_treatment_goals()'
      expect(await can('anon', rpc)).toBe(false)
      expect(await can('authenticated', rpc)).toBe(true)
      expect(await can('anon', job)).toBe(false)
      expect(await can('authenticated', job)).toBe(false)
      expect(await can('service_role', job)).toBe(true)
      expect(await can('authenticated', 'public.treatment_goal_guard_progress()')).toBe(false)
    })

    it('has a rollback that refuses to run where 55 is not applied', async () => {
      const rollback = await script(ROLLBACK_55)
      expect(rollback).toMatch(/Migration 64 is not applied/)
    })
  })

  it('19. keeps the existing plan and goal workflows', async () => {
    // A plan, a goal on it, the roadmap link, and the plan's update - as before.
    const [{ id: planId }] = await asDoctorA<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title)
       values ($1, $2, 'Second plan') returning treatment_plan_id as id`,
      [fx.alicePatId, fx.doctorAId],
    )
    const [{ id: goalId }] = await asDoctorA<{ id: string }>(
      `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description)
       values ($1, 'Balance on one leg') returning treatment_goal_id as id`,
      [planId],
    )
    // Its roadmap phase is generated (migration 56), not placed by hand.
    const [{ phase }] = await database.asService<{ phase: string | null }>(
      'select recovery_phase_id as phase from public.treatment_goal where treatment_goal_id = $1',
      [goalId],
    )
    expect(phase).not.toBeNull()
    await asDoctorA("update public.treatment_plan set treatment_plan_title = 'Second plan, revised' where treatment_plan_id = $1", [
      planId,
    ])
    await asDoctorA('delete from public.treatment_goal where treatment_goal_id = $1', [goalId])
    expect(await asAlice('select 1 from public.treatment_goal where treatment_goal_id = $1', [goalId])).toHaveLength(0)
  })
})

describe('migration 55, before and after', () => {
  it('can be run twice, and rolls back to exactly what 54 left, keeping every goal and event', async () => {
    const [full, through54] = await Promise.all([
      // Migration 56 builds on 55; this round trip is 55's alone.
      createTestDatabase({ stopAfter: '20260902100064' }),
      createTestDatabase({ stopAfter: '20260902100063' }),
    ])
    try {
      const fx = await seedFixture(full)
      await full.applyMigration('20260902100064')
      const [{ timeout }] = await full.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')
      const after55 = await catalog(full)

      await full.asUser(fx.aliceUserId, PROGRESS, [fx.aliceGoalId, 'in_progress'])
      const fingerprint = () =>
        full.asService(
          `select treatment_goal_id, treatment_goal_status::text, treatment_goal_target_date::text
             from public.treatment_goal order by treatment_goal_id`,
        )
      const events = () =>
        full.asService(
          `select treatment_goal_status_event_id, treatment_goal_previous_status::text, treatment_goal_new_status::text,
                  treatment_goal_changed_by
             from public.treatment_goal_status_event order by treatment_goal_status_event_id`,
        )
      const [goalsBefore, eventsBefore] = [await fingerprint(), await events()]

      await full.db.exec(await script(ROLLBACK_55))
      expect(await catalog(full)).toEqual(await catalog(through54))
      expect(await fingerprint()).toEqual(goalsBefore)
      expect(await events()).toEqual(eventsBefore)
      await expect(full.db.exec(await script(ROLLBACK_55))).rejects.toThrow(/Migration 64 is not applied/)

      await full.applyMigration('20260902100064')
      expect(await catalog(full)).toEqual(after55)

      // Supabase grants EXECUTE on every new function to anon and
      // authenticated by default; the test database does not. Grant it as
      // production would, apply 55 once more, and only the intended callers
      // remain.
      await full.db.exec(`
        grant execute on function public.mark_missed_treatment_goals() to anon, authenticated;
        grant execute on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) to anon;
        grant execute on function public.treatment_goal_guard_progress() to anon, authenticated;`)
      await full.applyMigration('20260902100064')
      const [acl] = await full.asService<Record<string, boolean>>(
        `select has_function_privilege('anon', 'public.mark_missed_treatment_goals()', 'execute') as job_anon,
                has_function_privilege('authenticated', 'public.mark_missed_treatment_goals()', 'execute') as job_auth,
                has_function_privilege('service_role', 'public.mark_missed_treatment_goals()', 'execute') as job_service,
                has_function_privilege('anon', 'public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status)', 'execute') as rpc_anon,
                has_function_privilege('authenticated', 'public.treatment_goal_guard_progress()', 'execute') as guard_auth`,
      )
      expect(acl).toEqual({ job_anon: false, job_auth: false, job_service: true, rpc_anon: false, guard_auth: false })
      expect(await catalog(full)).toEqual(after55)
    } finally {
      await Promise.all([full.close(), through54.close()])
    }
  })
})
