import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 56: the recovery roadmap is generated. Every treatment plan has
 * exactly goals + 2 current phases - Initial Recovery first, one Recovery
 * and Monitoring phase per goal, Follow-up and Assessment last - kept in
 * step with the plan and its goals by the database alone. No session
 * creates, edits, archives or reorders a phase; activities stay the
 * doctor's to manage and the patient's to mark.
 */

const MIGRATION_55 = '20260902100055'
const MIGRATION_56 = '20260902100056'
const ROLLBACK_56 = 'supabase/rollbacks/20260902100056_automatic_recovery_roadmap.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

type PhaseRow = {
  id: string
  kind: string
  ord: number
  goal: string | null
  title: string
  start: string | null
  end: string | null
}

const PHASES = `
  select recovery_phase_id as id, recovery_phase_kind as kind, recovery_phase_order as ord,
         treatment_goal_id as goal, recovery_phase_title as title,
         recovery_phase_start_date::text as start, recovery_phase_target_end_date::text as "end"
    from public.recovery_phase
   where treatment_plan_id = $1 and recovery_phase_archived_at is null
   order by recovery_phase_order`

const ADD_GOAL = `
  insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
  values ($1, $2, $3::date) returning treatment_goal_id as id`

const ADD_ACTIVITY = `
  insert into public.recovery_activity (recovery_phase_id, recovery_activity_title)
  values ($1, $2) returning recovery_activity_id as id`

const COMPLETE = 'select * from public.patient_complete_recovery_activity($1)'
const PROGRESS = 'select * from public.patient_update_treatment_goal_status($1, $2::public.treatment_goal_status)'

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

describe('the generated recovery roadmap (migration 56)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string
  let doctorDUserId: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)
  const phases = (planId: string) => database.asService<PhaseRow>(PHASES, [planId])

  /** A new plan of Alice's, by her doctor, with `goals` goals. */
  const planWithGoals = async (goals: number, end: string | null = null) => {
    const [{ id: planId }] = await asDoctorA<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date, treatment_plan_end_date)
       values ($1, $2, 'Knee plan', $3::date, $4::date) returning treatment_plan_id as id`,
      [fx.alicePatId, fx.doctorAId, today, end],
    )
    const goalIds: string[] = []
    for (let index = 0; index < goals; index += 1) {
      const [{ id }] = await asDoctorA<{ id: string }>(ADD_GOAL, [planId, `Goal ${index + 1}`, plusDays(today, 10 + index)])
      goalIds.push(id)
    }
    return { planId, goalIds }
  }

  beforeAll(async () => {
    database = await createTestDatabase({ preparedTransactions: true })
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

  afterEach(async () => {
    const left = await database.asService<{ gid: string }>('select gid from pg_prepared_xacts')
    for (const { gid } of left) await database.db.exec(`rollback prepared '${gid}'`)
  })

  describe('generation', () => {
    it.each([
      [0, 2],
      [1, 3],
      [3, 5],
      [5, 7],
    ])('a plan with %i goals has exactly %i phases', async (goals, expected) => {
      const { planId, goalIds } = await planWithGoals(goals)
      const rows = await phases(planId)
      expect(rows).toHaveLength(expected)
      expect(rows.map((row) => row.kind)).toEqual(['initial', ...goalIds.map(() => 'goal'), 'follow_up'])
      // One phase per goal, in the order the goals were set.
      expect(rows.filter((row) => row.kind === 'goal').map((row) => row.goal)).toEqual(goalIds)
    })

    it('generates the two fixed phases when the plan is created, with the plan dates', async () => {
      const end = plusDays(today, 60)
      const { planId } = await planWithGoals(0, end)
      const rows = await phases(planId)
      expect(rows.map(({ kind, title, start, end: last }) => ({ kind, title, start, end: last }))).toEqual([
        { kind: 'initial', title: 'Initial Recovery', start: today, end: null },
        { kind: 'follow_up', title: 'Follow-up and Assessment', start: null, end },
      ])
    })

    it('gives each goal phase the goal and its target date, and links the goal to it', async () => {
      const { planId, goalIds } = await planWithGoals(2)
      const rows = await phases(planId)
      const goalPhases = rows.filter((row) => row.kind === 'goal')
      expect(goalPhases.map((row) => [row.title, row.end])).toEqual([
        ['Recovery and Monitoring', plusDays(today, 10)],
        ['Recovery and Monitoring', plusDays(today, 11)],
      ])
      const links = await database.asService<{ id: string; phase: string }>(
        `select treatment_goal_id as id, recovery_phase_id as phase from public.treatment_goal
          where treatment_plan_id = $1 order by treatment_goal_created_at, treatment_goal_id`,
        [planId],
      )
      expect(links).toEqual(goalIds.map((id, index) => ({ id, phase: goalPhases[index]!.id })))
    })

    it('keeps Initial Recovery first and Follow-up and Assessment last as goals are added', async () => {
      const { planId } = await planWithGoals(1)
      await asDoctorA(ADD_GOAL, [planId, 'Later goal', plusDays(today, 3)])
      const rows = await phases(planId)
      expect(rows[0]!.kind).toBe('initial')
      expect(rows.at(-1)!.kind).toBe('follow_up')
      expect(rows).toHaveLength(4)
    })

    it('generates the existing fixture plan too (applied over existing data)', async () => {
      const rows = await phases(fx.alicePlanId)
      expect(rows.map((row) => row.kind)).toEqual(['initial', 'goal', 'follow_up'])
      expect(rows[1]!.goal).toBe(fx.aliceGoalId)
    })

    it('is idempotent: running the sync again creates nothing', async () => {
      const { planId } = await planWithGoals(3)
      const before = await phases(planId)
      for (let run = 0; run < 3; run += 1) {
        await database.asService('select app_private.sync_recovery_roadmap($1)', [planId])
      }
      expect(await phases(planId)).toEqual(before)
    })

    it('refuses a duplicate fixed phase or a second phase for one goal, even from the owner', async () => {
      const { planId, goalIds } = await planWithGoals(1)
      await expect(
        database.asService(
          `insert into public.recovery_phase (treatment_plan_id, recovery_phase_title, recovery_phase_kind, recovery_phase_order)
           values ($1, 'Initial Recovery', 'initial', 1)`,
          [planId],
        ),
      ).rejects.toThrow(/duplicate key|unique/)
      await expect(
        database.asService(
          `insert into public.recovery_phase
             (treatment_plan_id, recovery_phase_title, recovery_phase_kind, recovery_phase_order, treatment_goal_id)
           values ($1, 'Recovery and Monitoring', 'goal', 50, $2)`,
          [planId, goalIds[0]],
        ),
      ).rejects.toThrow(/duplicate key|unique/)
      await expect(
        database.asService(
          `insert into public.recovery_phase (treatment_plan_id, recovery_phase_title, recovery_phase_kind, recovery_phase_order)
           values ($1, 'Somewhere', 'follow_up', 3)`,
          [planId],
        ),
      ).rejects.toThrow(/check constraint|duplicate key/)
    })

    it('serialises goal creation on one plan: a second writer waits for the plan lock', async () => {
      const { planId } = await planWithGoals(0)
      const db = database.db
      await db.exec('begin')
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: fx.doctorAUserId })])
      await db.exec('set local role authenticated')
      await db.query(ADD_GOAL, [planId, 'Held goal', plusDays(today, 5)])
      await db.exec('reset role')
      await db.exec(`prepare transaction 'goal-a'`)

      // Another writer cannot take the plan's generation lock meanwhile.
      await expect(
        database.asService('select 1 from public.treatment_plan where treatment_plan_id = $1 for no key update nowait', [planId]),
      ).rejects.toThrow(/could not obtain lock/)

      await db.exec(`commit prepared 'goal-a'`)
      await asDoctorA(ADD_GOAL, [planId, 'Second goal', plusDays(today, 6)])
      const rows = await phases(planId)
      expect(rows.map((row) => row.kind)).toEqual(['initial', 'goal', 'goal', 'follow_up'])
      expect(new Set(rows.map((row) => row.goal).filter(Boolean)).size).toBe(2)
    })
  })

  describe('synchronisation', () => {
    it('moves the fixed phases with the plan dates', async () => {
      const { planId } = await planWithGoals(1, plusDays(today, 30))
      await asDoctorA(
        `update public.treatment_plan set treatment_plan_start_date = $2::date, treatment_plan_end_date = $3::date
          where treatment_plan_id = $1`,
        [planId, plusDays(today, 1), plusDays(today, 90)],
      )
      const rows = await phases(planId)
      expect(rows[0]!.start).toBe(plusDays(today, 1))
      expect(rows.at(-1)!.end).toBe(plusDays(today, 90))
    })

    it('moves a goal phase with its goal target date', async () => {
      const { planId, goalIds } = await planWithGoals(2)
      await asDoctorA('update public.treatment_goal set treatment_goal_target_date = $2::date where treatment_goal_id = $1', [
        goalIds[1],
        plusDays(today, 20),
      ])
      const rows = await phases(planId)
      expect(rows.filter((row) => row.kind === 'goal').map((row) => row.end)).toEqual([
        plusDays(today, 10),
        plusDays(today, 20),
      ])
    })

    it('shows the goal status set through the Treatment Goals workflow, never a copy', async () => {
      const { planId, goalIds } = await planWithGoals(1)
      await asAlice(PROGRESS, [goalIds[0], 'in_progress'])
      const statusOf = () =>
        asAlice<{ status: string }>(
          `select g.treatment_goal_status::text as status
             from public.recovery_phase ph join public.treatment_goal g on g.treatment_goal_id = ph.treatment_goal_id
            where ph.treatment_plan_id = $1`,
          [planId],
        )
      expect(await statusOf()).toEqual([{ status: 'in_progress' }])
      await asAlice(PROGRESS, [goalIds[0], 'achieved'])
      expect(await statusOf()).toEqual([{ status: 'achieved' }])
      const columns = await database.asService<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'recovery_phase' and column_name like '%status%'`,
      )
      expect(columns).toEqual([])
    })

    it('when a goal is deleted, archives its phase and moves its activities to Initial Recovery with their history', async () => {
      const { planId, goalIds } = await planWithGoals(2)
      const goalPhase = (await phases(planId))[1]!
      const [{ id: activityId }] = await asDoctorA<{ id: string }>(ADD_ACTIVITY, [goalPhase.id, 'Walk daily'])
      await asAlice(COMPLETE, [activityId])

      await asDoctorA('delete from public.treatment_goal where treatment_goal_id = $1', [goalIds[0]])

      const rows = await phases(planId)
      expect(rows.map((row) => row.kind)).toEqual(['initial', 'goal', 'follow_up'])
      const [moved] = await database.asService<{ phase: string; done: boolean }>(
        `select recovery_phase_id as phase, recovery_activity_completed_at is not null as done
           from public.recovery_activity where recovery_activity_id = $1`,
        [activityId],
      )
      expect(moved).toEqual({ phase: rows[0]!.id, done: true })
      const events = await database.asService('select 1 from public.recovery_activity_event where recovery_activity_id = $1', [
        activityId,
      ])
      expect(events).toHaveLength(1)
      const [archived] = await database.asService<{ archived: boolean }>(
        'select recovery_phase_archived_at is not null as archived from public.recovery_phase where recovery_phase_id = $1',
        [goalPhase.id],
      )
      expect(archived).toEqual({ archived: true })
    })

    it('deletes a whole plan, goals and phases, without tripping the goal trigger', async () => {
      const { planId } = await planWithGoals(2)
      await database.asService('delete from public.treatment_plan where treatment_plan_id = $1', [planId])
      expect(await database.asService('select 1 from public.recovery_phase where treatment_plan_id = $1', [planId])).toEqual([])
    })

    it('keeps a legacy goal whose target date is outside its plan from blocking generation', async () => {
      const { planId } = await planWithGoals(0, plusDays(today, 5))
      await database.asService(ADD_GOAL, [planId, 'Old goal', plusDays(today, 400)])
      expect((await phases(planId)).map((row) => row.kind)).toEqual(['initial', 'goal', 'follow_up'])
    })
  })

  describe('no manual phases', () => {
    it('refuses the assigned doctor creating, editing, archiving, deleting or reordering a phase', async () => {
      const { planId } = await planWithGoals(1)
      const [initial] = await phases(planId)
      await expect(
        asDoctorA(`insert into public.recovery_phase (treatment_plan_id, recovery_phase_title) values ($1, 'Mine')`, [planId]),
      ).rejects.toThrow(/permission denied/)
      for (const change of [
        `recovery_phase_title = 'Renamed'`,
        'recovery_phase_archived_at = now()',
        'recovery_phase_order = 99',
        'recovery_phase_description = null',
      ]) {
        await expect(
          asDoctorA(`update public.recovery_phase set ${change} where recovery_phase_id = $1`, [initial!.id]),
        ).rejects.toThrow(/generated by the system/)
      }
      await expect(asDoctorA('delete from public.recovery_phase where recovery_phase_id = $1', [initial!.id])).rejects.toThrow(
        /permission denied/,
      )
      await expect(
        asDoctorA('select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [planId, []]),
      ).rejects.toThrow(/does not exist/)
      expect((await phases(planId)).map((row) => [row.kind, row.title])).toEqual([
        ['initial', 'Initial Recovery'],
        ['goal', 'Recovery and Monitoring'],
        ['follow_up', 'Follow-up and Assessment'],
      ])
    })

    it('refuses the patient creating or reordering a phase', async () => {
      const { planId } = await planWithGoals(0)
      await expect(
        asAlice(`insert into public.recovery_phase (treatment_plan_id, recovery_phase_title) values ($1, 'Mine')`, [planId]),
      ).rejects.toThrow(/permission denied/)
      await expectDenied(() =>
        asAlice(`update public.recovery_phase set recovery_phase_order = 5 where treatment_plan_id = $1 returning *`, [planId]),
      )
      await expect(asAlice('delete from public.recovery_phase where treatment_plan_id = $1', [planId])).rejects.toThrow(
        /permission denied/,
      )
    })

    it('refuses a session moving a goal to another phase or another plan', async () => {
      const { planId, goalIds } = await planWithGoals(2)
      const rows = await phases(planId)
      await expect(
        asDoctorA('update public.treatment_goal set recovery_phase_id = $2 where treatment_goal_id = $1', [goalIds[0], rows[0]!.id]),
      ).rejects.toThrow(/roadmap phase is set by the system/)
      await expect(
        asDoctorA('update public.treatment_goal set recovery_phase_id = null where treatment_goal_id = $1', [goalIds[0]]),
      ).rejects.toThrow(/roadmap phase is set by the system/)
      const other = await planWithGoals(0)
      await expect(
        asDoctorA('update public.treatment_goal set treatment_plan_id = $2 where treatment_goal_id = $1', [goalIds[0], other.planId]),
      ).rejects.toThrow(/stays in its own treatment plan/)
    })

    it('ignores a phase a session names when adding a goal', async () => {
      const { planId } = await planWithGoals(0)
      const [initial] = await phases(planId)
      const [{ id }] = await asDoctorA<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description, recovery_phase_id)
         values ($1, 'Placed by hand', $2) returning treatment_goal_id as id`,
        [planId, initial!.id],
      )
      const [{ phase }] = await database.asService<{ phase: string }>(
        'select recovery_phase_id as phase from public.treatment_goal where treatment_goal_id = $1',
        [id],
      )
      expect(phase).not.toBe(initial!.id)
      expect((await phases(planId)).find((row) => row.goal === id)?.id).toBe(phase)
    })
  })

  describe('activities and access', () => {
    it('lets the doctor manage activities in generated phases and the patient mark them', async () => {
      const { planId } = await planWithGoals(1)
      const rows = await phases(planId)
      const ids: string[] = []
      for (const row of rows) {
        const [{ id }] = await asDoctorA<{ id: string }>(ADD_ACTIVITY, [row.id, `Do ${row.kind}`])
        ids.push(id)
      }
      await asAlice(COMPLETE, [ids[2]])
      const seen = await asAlice<{ title: string; done: boolean }>(
        `select a.recovery_activity_title as title, a.recovery_activity_completed_at is not null as done
           from public.recovery_activity a join public.recovery_phase ph using (recovery_phase_id)
          where ph.treatment_plan_id = $1 order by ph.recovery_phase_order`,
        [planId],
      )
      expect(seen).toEqual([
        { title: 'Do initial', done: false },
        { title: 'Do goal', done: false },
        { title: 'Do follow_up', done: true },
      ])
      // Still only the patient marks: the doctor cannot.
      await expect(asDoctorA(COMPLETE, [ids[0]])).rejects.toThrow(/Only the patient/)
    })

    it('shows a roadmap to its patient and their active doctor only', async () => {
      const { planId } = await planWithGoals(1)
      expect(await asAlice(PHASES, [planId])).toHaveLength(3)
      expect(await asDoctorA(PHASES, [planId])).toHaveLength(3)
      for (const userId of [fx.bobUserId, fx.doctorBUserId, fx.doctorCUserId, doctorDUserId, fx.adminUserId]) {
        await expectDenied(() => database.asUser(userId, PHASES, [planId]))
      }
      await expectDenied(() => database.asAnon(PHASES, [planId]))
      await expect(
        database.asAnon(`insert into public.recovery_phase (treatment_plan_id, recovery_phase_title) values ($1, 'x')`, [planId]),
      ).rejects.toThrow(/permission denied/)
    })

    it('refuses a doctor of another clinic adding a goal (and so a phase) to the plan', async () => {
      const { planId } = await planWithGoals(0)
      await expect(database.asUser(doctorDUserId, ADD_GOAL, [planId, 'Not mine', null])).rejects.toThrow(/row-level security/)
      expect(await phases(planId)).toHaveLength(2)
    })
  })

  describe('the follow-up appointment', () => {
    it('links the plan to one of its own patient’s appointments, read live', async () => {
      const { planId } = await planWithGoals(0)
      const [{ id: appointmentId }] = await database.asService<{ id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '30 days')
         returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      await asDoctorA('update public.treatment_plan set treatment_plan_follow_up_appointment_id = $2 where treatment_plan_id = $1', [
        planId,
        appointmentId,
      ])
      const read = () =>
        asAlice<{ status: string; day: string }>(
          `select a.appointment_status::text as status, (a.appointment_date at time zone 'UTC')::date::text as day
             from public.treatment_plan tp
             join public.appointment a on a.appointment_id = tp.treatment_plan_follow_up_appointment_id
            where tp.treatment_plan_id = $1`,
          [planId],
        )
      expect(await read()).toEqual([{ status: 'scheduled', day: expect.any(String) }])
      await database.asService(
        `update public.appointment set appointment_date = '2099-01-15 09:00+00' where appointment_id = $1`,
        [appointmentId],
      )
      expect(await read()).toEqual([{ status: 'scheduled', day: '2099-01-15' }])
      await database.asService(`update public.appointment set appointment_status = 'cancelled' where appointment_id = $1`, [
        appointmentId,
      ])
      expect(await read()).toEqual([{ status: 'cancelled', day: '2099-01-15' }])
    })

    it('refuses another patient’s appointment', async () => {
      const { planId } = await planWithGoals(0)
      await expect(
        database.asService(
          'update public.treatment_plan set treatment_plan_follow_up_appointment_id = $2 where treatment_plan_id = $1',
          [planId, fx.carolAppointmentId],
        ),
      ).rejects.toThrow(/foreign key/)
    })

    it('has none until the doctor chooses one, and loses it if the appointment is deleted', async () => {
      const { planId } = await planWithGoals(0)
      const [{ id: appointmentId }] = await database.asService<{ id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date) values ($1, $2, now() + interval '20 days')
         returning appointment_id as id`,
        [fx.alicePatId, fx.doctorAId],
      )
      const link = () =>
        database.asService<{ id: string | null }>(
          'select treatment_plan_follow_up_appointment_id as id from public.treatment_plan where treatment_plan_id = $1',
          [planId],
        )
      expect(await link()).toEqual([{ id: null }])
      await asDoctorA('update public.treatment_plan set treatment_plan_follow_up_appointment_id = $2 where treatment_plan_id = $1', [
        planId,
        appointmentId,
      ])
      await database.asService('delete from public.appointment where appointment_id = $1', [appointmentId])
      expect(await link()).toEqual([{ id: null }])
    })
  })

  describe('completing the roadmap is not recovery', () => {
    it('leaves the plan active and the patient and account untouched when everything is done', async () => {
      const { planId, goalIds } = await planWithGoals(2)
      const snapshot = () =>
        database.asService(
          `select tp.treatment_plan_status::text as plan, to_jsonb(p) as patient, to_jsonb(u) - 'user_updated_at' as account
             from public.treatment_plan tp join public.patient p using (pat_id) join public.user_account u on u.user_id = p.user_id
            where tp.treatment_plan_id = $1`,
          [planId],
        )
      const before = await snapshot()
      for (const row of await phases(planId)) {
        const [{ id }] = await asDoctorA<{ id: string }>(ADD_ACTIVITY, [row.id, `Task ${row.ord}`])
        await asAlice(COMPLETE, [id])
      }
      for (const goalId of goalIds) await asAlice(PROGRESS, [goalId, 'achieved'])
      const after = await snapshot()
      expect(after).toEqual(before)
      expect(after[0]).toMatchObject({ plan: 'active' })
    })
  })
})

describe('migration 56 over existing roadmaps', () => {
  it('converts single-goal phases, moves other activities to Initial Recovery, and loses no history', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_55 })
    try {
      const fx = await seedFixture(database)
      const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        database.asUser<T>(fx.doctorAUserId, sql, params)
      const addPhase = async (title: string) =>
        (await asDoctorA<{ id: string }>(
          `insert into public.recovery_phase (treatment_plan_id, recovery_phase_title, recovery_phase_description)
           values ($1, $2, 'Written by the doctor') returning recovery_phase_id as id`,
          [fx.alicePlanId, title],
        ))[0]!.id
      const first = await addPhase('First weeks')
      const linked = await addPhase('Walking')
      const empty = await addPhase('Nothing here')
      await asDoctorA('update public.treatment_goal set recovery_phase_id = $2 where treatment_goal_id = $1', [
        fx.aliceGoalId,
        linked,
      ])
      const activity = async (phaseId: string, title: string) =>
        (await asDoctorA<{ id: string }>(ADD_ACTIVITY, [phaseId, title]))[0]!.id
      const a1 = await activity(first, 'Rest')
      const a2 = await activity(first, 'Ice')
      const a3 = await activity(linked, 'Walk 100 m')
      await database.asUser(fx.aliceUserId, COMPLETE, [a1])
      await database.asUser(fx.aliceUserId, COMPLETE, [a3])
      const archived = await activity(first, 'Old task')
      await asDoctorA('update public.recovery_activity set recovery_activity_archived_at = now() where recovery_activity_id = $1', [
        archived,
      ])
      const history = () =>
        database.asService('select * from public.recovery_activity_event order by recovery_activity_event_id')
      const eventsBefore = await history()
      const countBefore = await database.asService<{ n: number }>('select count(*)::int as n from public.recovery_activity')

      await database.applyMigration(MIGRATION_56)

      const rows = await database.asService<PhaseRow & { description: string | null }>(
        PHASES.replace('as "end"', 'as "end", recovery_phase_description as description'),
        [fx.alicePlanId],
      )
      expect(rows.map((row) => row.kind)).toEqual(['initial', 'goal', 'follow_up'])
      // The goal's phase is the doctor's own phase, converted in place.
      expect(rows[1]).toMatchObject({ id: linked, goal: fx.aliceGoalId, title: 'Recovery and Monitoring' })
      expect(rows[1]!.description).toBe('Written by the doctor')

      const placed = await database.asService<{ id: string; phase: string; done: boolean; ord: number }>(
        `select recovery_activity_id as id, recovery_phase_id as phase,
                recovery_activity_completed_at is not null as done, recovery_activity_order as ord
           from public.recovery_activity where recovery_activity_archived_at is null order by recovery_activity_order`,
      )
      expect(placed.filter((row) => row.phase === rows[0]!.id).map((row) => [row.id, row.done])).toEqual([
        [a1, true],
        [a2, false],
      ])
      expect(placed.find((row) => row.id === a3)).toMatchObject({ phase: linked, done: true })
      expect(await history()).toEqual(eventsBefore)
      expect(await database.asService('select count(*)::int as n from public.recovery_activity')).toEqual(countBefore)

      // The other doctor-made phases are archived, never deleted.
      const old = await database.asService<{ id: string; archived: boolean }>(
        `select recovery_phase_id as id, recovery_phase_archived_at is not null as archived
           from public.recovery_phase where recovery_phase_id = any($1::uuid[]) order by recovery_phase_title`,
        [[first, empty]],
      )
      expect(old).toEqual([
        { id: first, archived: true },
        { id: empty, archived: true },
      ])

      // Applying it again changes nothing.
      const again = await database.asService(PHASES, [fx.alicePlanId])
      await database.applyMigration(MIGRATION_56)
      expect(await database.asService(PHASES, [fx.alicePlanId])).toEqual(again)
    } finally {
      await database.close()
    }
  })

  it('rolls back to exactly what 55 left, keeping every phase, activity and event', async () => {
    const [full, through55] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: MIGRATION_55 }),
    ])
    try {
      const fx = await seedFixture(full)
      const after56 = await catalog(full)
      const rows = () =>
        full.asService(
          `select (select count(*) from public.recovery_phase)::int as phases,
                  (select count(*) from public.recovery_activity)::int as activities,
                  (select count(*) from public.recovery_activity_event)::int as events`,
        )
      const [{ id: phaseId }] = await full.asService<{ id: string }>(PHASES, [fx.alicePlanId])
      const [{ id }] = await full.asUser<{ id: string }>(fx.doctorAUserId, ADD_ACTIVITY, [phaseId, 'Rest'])
      await full.asUser(fx.aliceUserId, COMPLETE, [id])
      const before = await rows()

      await full.db.exec(await script(ROLLBACK_56))
      expect(await catalog(full)).toEqual(await catalog(through55))
      expect(await rows()).toEqual(before)
      await expect(full.db.exec(await script(ROLLBACK_56))).rejects.toThrow(/Migration 56 is not applied/)

      await full.applyMigration(MIGRATION_56)
      expect(await catalog(full)).toEqual(after56)
      const [{ timeout }] = await full.asService<{ timeout: string }>("select current_setting('lock_timeout') as timeout")
      expect(timeout).toBe('0')
    } finally {
      await Promise.all([full.close(), through55.close()])
    }
  })
})
