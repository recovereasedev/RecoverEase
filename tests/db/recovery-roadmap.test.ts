import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 45: the recovery roadmap. A treatment plan's phases and the
 * activities the doctor assigns in them; the patient's completion of an
 * activity, kept as events; a goal linked to a phase of its own plan; and
 * every change of a goal's status, kept from now on. Who may do what is the
 * treatment plan's: the patient reads their own and marks their own
 * activities; their assigned, active doctor builds and changes it; nobody
 * else reads or writes a row.
 */

const MIGRATION_44 = '20260902100044'
const MIGRATION_45 = '20260902100045'
const MIGRATION_45_FILE = 'supabase/migrations/20260902100045_recovery_roadmap.sql'
const ROLLBACK_45 = 'supabase/rollbacks/20260902100045_recovery_roadmap.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

/** A script's lines of SQL, without its comments or blank lines. */
const codeLines = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))

const ADD_PHASE = `
  insert into public.recovery_phase
    (treatment_plan_id, recovery_phase_title, recovery_phase_start_date, recovery_phase_target_end_date)
  values ($1, $2, $3::date, $4::date)
  returning recovery_phase_id, recovery_phase_order`

const ADD_ACTIVITY = `
  insert into public.recovery_activity (recovery_phase_id, recovery_activity_title, recovery_activity_target_date)
  values ($1, $2, $3::date)
  returning recovery_activity_id, recovery_activity_order`

// In FROM, as PostgREST calls a function: `select (f()).*` would call it
// once for every column it returns.
const COMPLETE = 'select * from public.patient_complete_recovery_activity($1)'
const REOPEN = 'select * from public.patient_reopen_recovery_activity($1)'

/** A date `days` after a `YYYY-MM-DD` one. */
const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type Activity = {
  recovery_activity_id: string
  recovery_activity_completed_at: string | null
  recovery_activity_completed_by: string | null
}

describe('the recovery roadmap (migration 45)', () => {
  let database: TestDatabase
  let fx: Fixture
  let today: string
  let davePlanId: string
  let doctorDUserId: string

  const asDoctorA = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.doctorAUserId, sql, params)
  const asAlice = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.asUser<T>(fx.aliceUserId, sql, params)

  const phase = async (title: string, start: string | null = null, end: string | null = null) =>
    (await asDoctorA<{ recovery_phase_id: string; recovery_phase_order: number }>(ADD_PHASE, [
      fx.alicePlanId,
      title,
      start,
      end,
    ]))[0]!

  const activity = async (phaseId: string, title: string, target: string | null = null) =>
    (await asDoctorA<{ recovery_activity_id: string; recovery_activity_order: number }>(ADD_ACTIVITY, [
      phaseId,
      title,
      target,
    ]))[0]!

  const events = (activityId: string) =>
    database.asService<{ kind: string; actor: string | null }>(
      `select recovery_activity_event_kind::text as kind, recovery_activity_event_actor as actor
         from public.recovery_activity_event
        where recovery_activity_id = $1
        order by recovery_activity_event_at, recovery_activity_event_kind`,
      [activityId],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    ;[{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')

    // Dave's doctor, doctorC, is deactivated.
    ;[{ id: davePlanId }] = await database.asService<{ id: string }>(
      `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title)
       values ($1, $2, 'Wrist recovery') returning treatment_plan_id as id`,
      [fx.davePatId, fx.doctorCId],
    )

    // An active doctor in another clinic.
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

  describe('the doctor builds it', () => {
    it('lets the assigned doctor add phases and activities, numbered in order', async () => {
      const first = await phase('Initial recovery')
      const second = await phase('Rehabilitation')
      expect([first.recovery_phase_order, second.recovery_phase_order]).toEqual([1, 2])

      const a = await activity(first.recovery_phase_id, 'Follow the rest instructions')
      const b = await activity(first.recovery_phase_id, 'Attend the first consultation')
      expect([a.recovery_activity_order, b.recovery_activity_order]).toEqual([1, 2])

      // The patient reads the same roadmap.
      const seen = await asAlice<{ title: string }>(
        `select recovery_activity_title as title from public.recovery_activity
          where recovery_phase_id = $1 order by recovery_activity_order`,
        [first.recovery_phase_id],
      )
      expect(seen.map((row) => row.title)).toEqual([
        'Follow the rest instructions',
        'Attend the first consultation',
      ])
    })

    it('refuses another doctor, a deactivated doctor and a doctor in another clinic', async () => {
      const { recovery_phase_id } = await phase('Strength building')

      for (const userId of [fx.doctorBUserId, doctorDUserId]) {
        await expect(
          database.asUser(userId, ADD_PHASE, [fx.alicePlanId, 'Not mine', null, null]),
        ).rejects.toThrow(/row-level security/)
        await expectDenied(() =>
          database.asUser(userId, 'select * from public.recovery_phase where recovery_phase_id = $1', [
            recovery_phase_id,
          ]),
        )
        await expectDenied(() =>
          database.asUser(
            userId,
            `update public.recovery_phase set recovery_phase_title = 'Changed'
              where recovery_phase_id = $1 returning *`,
            [recovery_phase_id],
          ),
        )
      }

      // doctorC holds Dave's record but is deactivated.
      await expect(
        database.asUser(fx.doctorCUserId, ADD_PHASE, [davePlanId, 'Wrist mobility', null, null]),
      ).rejects.toThrow(/row-level security/)
    })

    it('shows the roadmap to no one else: another patient, the Clinic Admin, a visitor', async () => {
      for (const read of [
        () => database.asUser(fx.bobUserId, 'select * from public.recovery_phase where treatment_plan_id = $1', [fx.alicePlanId]),
        () => database.asUser(fx.adminUserId, 'select * from public.recovery_phase where treatment_plan_id = $1', [fx.alicePlanId]),
        () => database.asUser(fx.adminUserId, 'select * from public.recovery_activity'),
        () => database.asUser(fx.bobUserId, 'select * from public.treatment_goal_status_event'),
      ]) {
        await expectDenied(read)
      }
      await expectDenied(() => database.asAnon('select * from public.recovery_phase'))
    })

    it('keeps a phase and its activities in their own plan', async () => {
      const mine = await phase('Mobility')
      const [carolPhase] = await database.asUser<{ recovery_phase_id: string }>(fx.doctorBUserId, ADD_PHASE, [
        fx.carolPlanId,
        'Carol only',
        null,
        null,
      ])
      await expect(
        asDoctorA('update public.recovery_phase set treatment_plan_id = $2 where recovery_phase_id = $1', [
          mine.recovery_phase_id,
          fx.carolPlanId,
        ]),
      ).rejects.toThrow()
      const task = await activity(mine.recovery_phase_id, 'Stretch daily')
      await expect(
        asDoctorA('update public.recovery_activity set recovery_phase_id = $2 where recovery_activity_id = $1', [
          task.recovery_activity_id,
          carolPhase!.recovery_phase_id,
        ]),
      ).rejects.toThrow()
    })

    it('validates dates: in order, and inside the plan', async () => {
      await expect(phase('Backwards', plusDays(today, 10), plusDays(today, 5))).rejects.toThrow(
        /recovery_phase_dates_ordered/,
      )
      await expect(
        asDoctorA(ADD_PHASE, [fx.alicePlanId, 'Before the plan', '2000-01-01', null]),
      ).rejects.toThrow(/within its treatment plan/)
      await asDoctorA(`update public.treatment_plan set treatment_plan_end_date = $2::date + 60 where treatment_plan_id = $1`, [
        fx.alicePlanId,
        today,
      ])
      await expect(
        asDoctorA(ADD_PHASE, [fx.alicePlanId, 'After the plan', today, '2999-01-01']),
      ).rejects.toThrow(/within its treatment plan/)
      const inside = await phase('Inside the plan', today, today)
      await expect(
        activity(inside.recovery_phase_id, 'Too late', '2999-01-01'),
      ).rejects.toThrow(/within its treatment plan/)
      await asDoctorA('update public.treatment_plan set treatment_plan_end_date = null where treatment_plan_id = $1', [
        fx.alicePlanId,
      ])
    })

    it('reorders phases and activities in one call, and refuses a partial or foreign order', async () => {
      const [{ id: planId }] = await database.asService<{ id: string }>(
        // Dated here: with two clinics the service role has no clinic day.
        `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date)
         values ($1, $2, 'Ordering plan', $3::date) returning treatment_plan_id as id`,
        [fx.alicePatId, fx.doctorAId, today],
      )
      const add = async (title: string) =>
        (await asDoctorA<{ recovery_phase_id: string }>(ADD_PHASE, [planId, title, null, null]))[0]!.recovery_phase_id
      const [one, two, three] = [await add('One'), await add('Two'), await add('Three')]

      await asDoctorA('select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [planId, [three, one, two]])
      const order = await asAlice<{ recovery_phase_title: string; recovery_phase_order: number }>(
        `select recovery_phase_title, recovery_phase_order from public.recovery_phase
          where treatment_plan_id = $1 order by recovery_phase_order`,
        [planId],
      )
      expect(order).toEqual([
        { recovery_phase_title: 'Three', recovery_phase_order: 1 },
        { recovery_phase_title: 'One', recovery_phase_order: 2 },
        { recovery_phase_title: 'Two', recovery_phase_order: 3 },
      ])

      await expect(
        asDoctorA('select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [planId, [three, one]]),
      ).rejects.toThrow(/each of the plan's current phases once/)
      await expect(
        asDoctorA('select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [planId, [three, one, one]]),
      ).rejects.toThrow(/each of the plan's current phases once/)
      await expect(
        database.asUser(fx.doctorBUserId, 'select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [
          planId,
          [one, two, three],
        ]),
      ).rejects.toThrow(/assigned doctor/)

      // Archived, a phase leaves the order; restored, it goes to the end.
      await asDoctorA('update public.recovery_phase set recovery_phase_archived_at = now() where recovery_phase_id = $1', [one])
      await asDoctorA('select public.doctor_reorder_recovery_phases($1, $2::uuid[])', [planId, [two, three]])
      await asDoctorA('update public.recovery_phase set recovery_phase_archived_at = null where recovery_phase_id = $1', [one])
      const restored = await asDoctorA<{ recovery_phase_order: number }>(
        'select recovery_phase_order from public.recovery_phase where recovery_phase_id = $1',
        [one],
      )
      expect(restored[0]!.recovery_phase_order).toBe(3)

      const tasks = [
        (await activity(two, 'A')).recovery_activity_id,
        (await activity(two, 'B')).recovery_activity_id,
        (await activity(two, 'C')).recovery_activity_id,
      ]
      await asDoctorA('select public.doctor_reorder_recovery_activities($1, $2::uuid[])', [two, [tasks[2], tasks[1], tasks[0]]])
      const titles = await asAlice<{ recovery_activity_title: string }>(
        `select recovery_activity_title from public.recovery_activity
          where recovery_phase_id = $1 order by recovery_activity_order`,
        [two],
      )
      expect(titles.map((row) => row.recovery_activity_title)).toEqual(['C', 'B', 'A'])
      await expect(
        database.asUser(fx.aliceUserId, 'select public.doctor_reorder_recovery_activities($1, $2::uuid[])', [two, tasks]),
      ).rejects.toThrow(/assigned doctor/)
    })
  })

  describe('the patient marks an activity done', () => {
    let taskId: string

    beforeAll(async () => {
      const { recovery_phase_id } = await phase('Daily habits')
      taskId = (await activity(recovery_phase_id, 'Walk ten minutes after lunch')).recovery_activity_id
    })

    it('records when, and who, at the server, and keeps the event', async () => {
      const [done] = await asAlice<Activity & { now: string }>(COMPLETE, [taskId])
      expect(done!.recovery_activity_completed_by).toBe(fx.aliceUserId)
      expect(done!.recovery_activity_completed_at).not.toBeNull()
      expect(await events(taskId)).toEqual([{ kind: 'completed', actor: fx.aliceUserId }])
      // The doctor sees the same completion.
      const [seen] = await asDoctorA<Activity>(
        'select recovery_activity_completed_at, recovery_activity_completed_by from public.recovery_activity where recovery_activity_id = $1',
        [taskId],
      )
      expect(seen!.recovery_activity_completed_at).toEqual(done!.recovery_activity_completed_at)
    })

    it('refuses marking it done twice, and writes nothing the second time', async () => {
      await expect(asAlice(COMPLETE, [taskId])).rejects.toThrow(/already marked done/)
      expect(await events(taskId)).toHaveLength(1)
    })

    it('lets the patient undo it, as an event of its own', async () => {
      const [undone] = await asAlice<Activity>(REOPEN, [taskId])
      expect(undone!.recovery_activity_completed_at).toBeNull()
      expect(undone!.recovery_activity_completed_by).toBeNull()
      expect((await events(taskId)).map((event) => event.kind)).toEqual(['completed', 'reopened'])
      await expect(asAlice(REOPEN, [taskId])).rejects.toThrow(/not marked done/)
    })

    it('refuses anyone but the patient: another patient, the doctor, the Clinic Admin, a visitor', async () => {
      for (const userId of [fx.bobUserId, fx.carolUserId, fx.doctorAUserId, fx.adminUserId]) {
        await expect(database.asUser(userId, COMPLETE, [taskId])).rejects.toThrow(/Only the patient/)
      }
      await expect(database.asAnon(COMPLETE, [taskId])).rejects.toThrow()
      // An activity that does not exist says the same.
      await expect(asAlice(COMPLETE, ['00000000-0000-4000-8000-000000000000'])).rejects.toThrow(/Only the patient/)
    })

    it('never lets the patient change the doctor’s text, dates or order, or write a completion directly', async () => {
      for (const sql of [
        `update public.recovery_activity set recovery_activity_title = 'Easier' where recovery_activity_id = $1 returning *`,
        `update public.recovery_activity set recovery_activity_completed_at = now() where recovery_activity_id = $1 returning *`,
        `update public.recovery_phase set recovery_phase_title = 'Mine' where recovery_phase_id =
           (select recovery_phase_id from public.recovery_activity where recovery_activity_id = $1) returning *`,
        `delete from public.recovery_activity where recovery_activity_id = $1 returning *`,
      ]) {
        await expectDenied(() => asAlice(sql, [taskId]))
      }
      await expect(
        asAlice(`insert into public.recovery_activity_event (recovery_activity_id, recovery_activity_event_kind) values ($1, 'completed')`, [
          taskId,
        ]),
      ).rejects.toThrow(/permission denied/)
      // Nor may the doctor mark it for the patient.
      await expect(
        asDoctorA(`update public.recovery_activity set recovery_activity_completed_at = now() where recovery_activity_id = $1`, [taskId]),
      ).rejects.toThrow(/marked done by the patient/)
    })

    it('refuses an archived activity, one in an archived phase, and any while the plan is not active', async () => {
      const { recovery_phase_id } = await phase('Closing out')
      const archived = (await activity(recovery_phase_id, 'Dropped')).recovery_activity_id
      await asDoctorA('update public.recovery_activity set recovery_activity_archived_at = now() where recovery_activity_id = $1', [archived])
      await expect(asAlice(COMPLETE, [archived])).rejects.toThrow(/no longer on the roadmap/)

      const kept = (await activity(recovery_phase_id, 'Kept')).recovery_activity_id
      await asDoctorA('update public.treatment_plan set treatment_plan_status = $2 where treatment_plan_id = $1', [
        fx.alicePlanId,
        'completed',
      ])
      await expect(asAlice(COMPLETE, [kept])).rejects.toThrow(/plan is active/)
      await asDoctorA('update public.treatment_plan set treatment_plan_status = $2 where treatment_plan_id = $1', [
        fx.alicePlanId,
        'active',
      ])

      await asDoctorA('update public.recovery_phase set recovery_phase_archived_at = now() where recovery_phase_id = $1', [recovery_phase_id])
      await expect(asAlice(COMPLETE, [kept])).rejects.toThrow(/no longer on the roadmap/)
    })

    it('keeps the history when an activity is archived; nothing is deleted through the website', async () => {
      const { recovery_phase_id } = await phase('History')
      const task = (await activity(recovery_phase_id, 'Log symptoms')).recovery_activity_id
      await asAlice(COMPLETE, [task])
      await expectDenied(() => asDoctorA('delete from public.recovery_activity where recovery_activity_id = $1 returning *', [task]))
      await expectDenied(() => asDoctorA('delete from public.recovery_phase where recovery_phase_id = $1 returning *', [recovery_phase_id]))
      await asDoctorA('update public.recovery_activity set recovery_activity_archived_at = now() where recovery_activity_id = $1', [task])
      expect(await events(task)).toEqual([{ kind: 'completed', actor: fx.aliceUserId }])
      const [row] = await asAlice<{ archived: boolean; done: boolean }>(
        `select recovery_activity_archived_at is not null as archived, recovery_activity_completed_at is not null as done
           from public.recovery_activity where recovery_activity_id = $1`,
        [task],
      )
      expect(row).toEqual({ archived: true, done: true })
    })

    it('does not stop a completion when the plan’s dates later move', async () => {
      const inside = await phase('Before the change', today, today)
      const task = (await activity(inside.recovery_phase_id, 'Due today', today)).recovery_activity_id
      await asDoctorA(`update public.treatment_plan set treatment_plan_start_date = $2::date + 1 where treatment_plan_id = $1`, [
        fx.alicePlanId,
        today,
      ])
      await asAlice(COMPLETE, [task])
      await asDoctorA('update public.treatment_plan set treatment_plan_start_date = $2::date where treatment_plan_id = $1', [
        fx.alicePlanId,
        today,
      ])
    })
  })

  describe('treatment goals', () => {
    it('link to a current phase of their own plan only, and leave it when the phase is archived', async () => {
      const { recovery_phase_id } = await phase('Goal phase')
      await asDoctorA('update public.treatment_goal set recovery_phase_id = $2 where treatment_goal_id = $1', [
        fx.aliceGoalId,
        recovery_phase_id,
      ])
      const [carolPhase] = await database.asUser<{ recovery_phase_id: string }>(fx.doctorBUserId, ADD_PHASE, [
        fx.carolPlanId,
        'Carol phase',
        null,
        null,
      ])
      await expect(
        database.asService('update public.treatment_goal set recovery_phase_id = $2 where treatment_goal_id = $1', [
          fx.aliceGoalId,
          carolPhase!.recovery_phase_id,
        ]),
      ).rejects.toThrow(/treatment_goal_phase_in_plan/)
      // The patient cannot move their own goal.
      await expectDenied(() =>
        asAlice('update public.treatment_goal set recovery_phase_id = null where treatment_goal_id = $1 returning *', [fx.aliceGoalId]),
      )

      await asDoctorA('update public.recovery_phase set recovery_phase_archived_at = now() where recovery_phase_id = $1', [recovery_phase_id])
      const [goal] = await asAlice<{ recovery_phase_id: string | null; treatment_goal_status: string }>(
        'select recovery_phase_id, treatment_goal_status from public.treatment_goal where treatment_goal_id = $1',
        [fx.aliceGoalId],
      )
      expect(goal!.recovery_phase_id).toBeNull()
      await expect(
        asDoctorA('update public.treatment_goal set recovery_phase_id = $2 where treatment_goal_id = $1', [
          fx.aliceGoalId,
          recovery_phase_id,
        ]),
      ).rejects.toThrow(/archived/)
    })

    it('keep every change of status from now on, with who and when - and only real changes', async () => {
      const [{ id: goalId }] = await asDoctorA<{ id: string }>(
        `insert into public.treatment_goal (treatment_plan_id, treatment_goal_description)
         values ($1, 'Climb one flight of stairs') returning treatment_goal_id as id`,
        [fx.alicePlanId],
      )
      for (const status of ['in_progress', 'in_progress', 'achieved']) {
        await asDoctorA('update public.treatment_goal set treatment_goal_status = $2 where treatment_goal_id = $1', [goalId, status])
      }
      // Linking to a phase is not a change of status.
      await asDoctorA('update public.treatment_goal set treatment_goal_description = $2 where treatment_goal_id = $1', [
        goalId,
        'Climb one flight of stairs unaided',
      ])

      const history = await asAlice<{ previous: string | null; next: string; by: string }>(
        `select treatment_goal_previous_status::text as previous, treatment_goal_new_status::text as next,
                treatment_goal_changed_by as by
           from public.treatment_goal_status_event
          where treatment_goal_id = $1
          order by treatment_goal_changed_at, treatment_goal_new_status`,
        [goalId],
      )
      expect(history).toEqual([
        { previous: null, next: 'pending', by: fx.doctorAUserId },
        { previous: 'pending', next: 'in_progress', by: fx.doctorAUserId },
        { previous: 'in_progress', next: 'achieved', by: fx.doctorAUserId },
      ])
      await expect(
        asDoctorA(
          `insert into public.treatment_goal_status_event (treatment_goal_id, treatment_goal_new_status) values ($1, 'missed')`,
          [goalId],
        ),
      ).rejects.toThrow(/permission denied/)
    })
  })
})

describe('migration 45, before and after', () => {
  it('waits at most 3 seconds for its lock, and puts the setting back', async () => {
    const lines = codeLines(await script(MIGRATION_45_FILE))
    expect(lines[0]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase({ stopAfter: MIGRATION_44 })
    try {
      await database.applyMigration(MIGRATION_45)
      const [after] = await database.asService<{ lock_timeout: string }>(
        `select current_setting('lock_timeout') as lock_timeout`,
      )
      expect(after!.lock_timeout).toBe('0')
      // Run again from the top, as after a lock it could not get.
      await database.applyMigration(MIGRATION_45)
    } finally {
      await database.close()
    }
  })

  it('leaves doses, appointments, mood check-ins, plans and goals as they were, inventing no history', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_44 })
    try {
      const fx = await seedFixture(database)
      await database.asService(`update public.treatment_goal set treatment_goal_status = 'achieved' where treatment_goal_id = $1`, [
        fx.aliceGoalId,
      ])
      const snapshot = () =>
        database.asService<{ name: string; digest: string }>(`
          select 'medication_log' as name, md5(coalesce(string_agg(t::text, ',' order by t.medication_log_id), '')) as digest from public.medication_log t
          union all select 'medication_schedule', md5(coalesce(string_agg(t::text, ',' order by t.medication_schedule_id), '')) from public.medication_schedule t
          union all select 'appointment', md5(coalesce(string_agg(t::text, ',' order by t.appointment_id), '')) from public.appointment t
          union all select 'recovery_log', md5(coalesce(string_agg(t::text, ',' order by t.recovery_log_id), '')) from public.recovery_log t
          union all select 'treatment_plan', md5(coalesce(string_agg(t::text, ',' order by t.treatment_plan_id), '')) from public.treatment_plan t
          union all select 'treatment_goal', md5(coalesce(string_agg(
            concat_ws('|', t.treatment_goal_id, t.treatment_plan_id, t.treatment_goal_description, t.treatment_goal_target_date,
                      t.treatment_goal_status, t.treatment_goal_created_at), ',' order by t.treatment_goal_id), '')) from public.treatment_goal t
        `)
      const before = await snapshot()

      await database.applyMigration(MIGRATION_45)

      expect(await snapshot()).toEqual(before)
      expect(await database.asService('select * from public.treatment_goal_status_event')).toEqual([])
      expect(
        await database.asService('select 1 from public.treatment_goal where recovery_phase_id is not null'),
      ).toEqual([])
    } finally {
      await database.close()
    }
  })

  it('rolls back to exactly what 44 left - every plan and goal kept - refuses to run twice, and leaves the setting', async () => {
    const lines = codeLines(await script(ROLLBACK_45))
    const checked = lines.indexOf('$$;')
    expect(lines.slice(0, checked + 1).some((line) => /^(drop|create|alter)\b/.test(line))).toBe(false)
    expect(lines[checked + 1]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const [used, through44] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: MIGRATION_44 }),
    ])
    try {
      const fx = await seedFixture(used)
      const [{ recovery_phase_id }] = await used.asUser<{ recovery_phase_id: string }>(fx.doctorAUserId, ADD_PHASE, [
        fx.alicePlanId,
        'Rolled back',
        null,
        null,
      ])
      const [{ recovery_activity_id }] = await used.asUser<{ recovery_activity_id: string }>(fx.doctorAUserId, ADD_ACTIVITY, [
        recovery_phase_id,
        'Gone with it',
        null,
      ])
      await used.asUser(fx.aliceUserId, COMPLETE, [recovery_activity_id])
      await used.asUser(fx.doctorAUserId, 'update public.treatment_goal set recovery_phase_id = $2, treatment_goal_status = $3 where treatment_goal_id = $1', [
        fx.aliceGoalId,
        recovery_phase_id,
        'in_progress',
      ])
      const goalsBefore = await used.asService(
        'select treatment_goal_id, treatment_plan_id, treatment_goal_status::text from public.treatment_goal order by 1',
      )

      await used.db.exec(await script(ROLLBACK_45))

      expect(await catalog(used)).toEqual(await catalog(through44))
      expect(
        await used.asService('select treatment_goal_id, treatment_plan_id, treatment_goal_status::text from public.treatment_goal order by 1'),
      ).toEqual(goalsBefore)
      const [setting] = await used.asService<{ lock_timeout: string }>(`select current_setting('lock_timeout') as lock_timeout`)
      expect(setting!.lock_timeout).toBe('0')

      await expect(used.db.exec(await script(ROLLBACK_45))).rejects.toThrow(/Migration 45 is not applied/)

      // And it goes in again over its own rollback.
      await used.applyMigration(MIGRATION_45)
    } finally {
      await Promise.all([used.close(), through44.close()])
    }
  })
})
