import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 64's first run. The missed-goal job's very first execution may
 * change only a set of goals approved in advance and armed by the database
 * owner (`app_private.arm_missed_goal_bootstrap`), all of them or none:
 *
 *   unarmed ──(owner arms: approved set = the goals eligible right now)──▶ armed
 *   armed ──(first run: every approved goal still eligible, under lock)──▶ consumed
 *
 * Until it is consumed the job marks nothing else; once consumed it is the
 * ordinary hourly automation, for good. No session can read, arm or alter the
 * record. Row locks here are real (PREPARE TRANSACTION holds them), not
 * mocked.
 */

const ROLLBACK_64 = 'supabase/rollbacks/20260902100064_treatment_goal_progress.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const RUN = 'select public.mark_missed_treatment_goals() as changed'
const ARM = 'select app_private.arm_missed_goal_bootstrap($1::uuid[]) as armed'
const PROGRESS = 'select * from public.patient_update_treatment_goal_status($1, $2::public.treatment_goal_status)'
const DISCHARGE = 'select * from public.doctor_discharge_patient_care($1, $2)'
const PLAN_DISCHARGE = 'select * from public.doctor_discharge_treatment_plan($1, $2)'

const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

type World = {
  database: TestDatabase
  fx: Fixture
  today: string
  bobPlanId: string
  approved: string[]
  overdue: (planId: string, daysAgo: number, status?: string) => Promise<string>
  status: (goalId: string) => Promise<string>
  state: () => Promise<{ state: string; ids: string[] | null; marked: number | null }>
  systemEvents: () => Promise<number>
  run: () => Promise<number>
}

let open: TestDatabase[] = []

afterEach(async () => {
  for (const database of open) {
    const left = await database.asService<{ gid: string }>('select gid from pg_prepared_xacts')
    for (const { gid } of left) await database.db.exec(`rollback prepared '${gid}'`)
    await database.close()
  }
  open = []
})

/** A fresh database (the first run happens once per database) with three overdue goals. */
async function world(stopAfter?: string): Promise<World> {
  const database = await createTestDatabase({ preparedTransactions: true, ...(stopAfter ? { stopAfter } : {}) })
  open.push(database)
  const fx = await seedFixture(database)
  const [{ today }] = await database.asService<{ today: string }>('select public.app_today()::text as today')
  const [{ doc }] = await database.asService<{ doc: string }>('select doc_id as doc from public.patient where pat_id = $1', [
    fx.bobPatId,
  ])
  const [{ id: bobPlanId }] = await database.asService<{ id: string }>(
    `insert into public.treatment_plan (pat_id, doc_id, treatment_plan_title, treatment_plan_start_date)
     values ($1, $2, 'Hip recovery', current_date - 90) returning treatment_plan_id as id`,
    [fx.bobPatId, doc],
  )
  // Written as the service would: any status, any date.
  const overdue = async (planId: string, daysAgo: number, status = 'pending') =>
    (
      await database.asService<{ id: string }>(
        `insert into public.treatment_goal
           (treatment_plan_id, treatment_goal_description, treatment_goal_target_date, treatment_goal_status)
         values ($1, 'Seeded goal', $2::date, $3::public.treatment_goal_status) returning treatment_goal_id as id`,
        [planId, plusDays(today, -daysAgo), status],
      )
    )[0]!.id
  const approved = [
    await overdue(fx.alicePlanId, 40),
    await overdue(fx.alicePlanId, 5, 'in_progress'),
    await overdue(bobPlanId, 60),
  ]
  const status = async (goalId: string) =>
    (
      await database.asService<{ s: string }>(
        'select treatment_goal_status::text as s from public.treatment_goal where treatment_goal_id = $1',
        [goalId],
      )
    )[0]!.s
  const state = async () =>
    (
      await database.asService<{ state: string; ids: string[] | null; marked: number | null }>(
        `select missed_goal_bootstrap_state as state, missed_goal_bootstrap_goal_ids::text[] as ids,
                missed_goal_bootstrap_marked as marked
           from app_private.missed_goal_bootstrap`,
      )
    )[0]!
  const systemEvents = async () =>
    (
      await database.asService<{ n: number }>(
        "select count(*)::int as n from public.treatment_goal_status_event where treatment_goal_change_source = 'system'",
      )
    )[0]!.n
  const run = async () => (await database.asService<{ changed: number }>(RUN))[0]!.changed
  return { database, fx, today, bobPlanId, approved, overdue, status, state, systemEvents, run }
}

const SQLSTATE = (code: string) => new RegExp(`SQLSTATE ${code}`)

describe('migration 64: the first missed-goal run', () => {
  it('1. refuses to run at all before an approved set is armed, marking nothing', async () => {
    const w = await world()
    expect(await w.state()).toEqual({ state: 'unarmed', ids: null, marked: null })
    await expect(w.run()).rejects.toThrow(SQLSTATE('RE64A'))
    for (const id of w.approved) expect(await w.status(id)).not.toBe('missed')
    expect(await w.systemEvents()).toBe(0)
    expect((await w.state()).state).toBe('unarmed')
  })

  it('arms only with exactly the goals the job would mark now: no fewer, no more, no strangers or repeats', async () => {
    const w = await world()
    const [a, b, c] = w.approved as [string, string, string]
    for (const wrong of [[a, b], [a, b, c, w.fx.aliceGoalId], [a, b, '00000000-0000-0000-0000-000000000001']]) {
      await expect(w.database.asService(ARM, [wrong])).rejects.toThrow(/exactly the goals/)
    }
    await expect(w.database.asService(ARM, [[a, a, b, c]])).rejects.toThrow(/once each/)
    await expect(w.database.asService(ARM, [null])).rejects.toThrow(/once each/)
    expect((await w.state()).state).toBe('unarmed')

    expect(await w.database.asService(ARM, [[c, a, b]])).toEqual([{ armed: 3 }])
    const armed = await w.state()
    expect(armed.state).toBe('armed')
    expect(armed.ids).toEqual([...w.approved].sort())
  })

  it('2, 12. marks exactly the approved goals, as the system with no actor, and consumes the first run', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    expect(await w.run()).toBe(3)
    for (const id of w.approved) expect(await w.status(id)).toBe('missed')
    const events = await w.database.asService<{ goal: string; by: string | null; source: string; previous: string }>(
      `select treatment_goal_id as goal, treatment_goal_changed_by as by, treatment_goal_change_source as source,
              treatment_goal_previous_status::text as previous
         from public.treatment_goal_status_event where treatment_goal_new_status = 'missed' order by treatment_goal_id`,
    )
    expect(events.map((e) => e.goal)).toEqual([...w.approved].sort())
    expect(events.every((e) => e.by === null && e.source === 'system')).toBe(true)
    expect(await w.state()).toMatchObject({ state: 'consumed', marked: 3 })
  })

  it('3, 7, 9. leaves a goal that became overdue after arming for the next, ordinary run', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    const later = await w.overdue(w.bobPlanId, 1)
    const lockedUnapproved = await w.overdue(w.fx.alicePlanId, 2)
    // An unapproved goal held by another transaction is no concern of the first run.
    await w.database.db.exec('begin')
    await w.database.db.query(
      "update public.treatment_goal set treatment_goal_description = 'Being edited' where treatment_goal_id = $1",
      [lockedUnapproved],
    )
    await w.database.db.exec(`prepare transaction 'edit-unapproved'`)

    expect(await w.run()).toBe(3)
    expect(await w.status(later)).toBe('pending')
    expect(await w.status(lockedUnapproved)).toBe('pending')

    await w.database.db.exec(`commit prepared 'edit-unapproved'`)
    expect(await w.run()).toBe(2)
    expect(await w.status(later)).toBe('missed')
    expect(await w.status(lockedUnapproved)).toBe('missed')
    expect(await w.run()).toBe(0)
  })

  it.each([
    ['the patient achieved it', 'achieved'],
    ['its target date moved ahead', 'future'],
    ['its plan was discharged', 'plan'],
    ['the patient was discharged', 'patient'],
  ])('4, 5, 10, 11. refuses the whole first run when an approved goal is no longer eligible (%s)', async (_, change) => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    const target = w.approved[0]!
    if (change === 'achieved') await w.database.asUser(w.fx.aliceUserId, PROGRESS, [target, 'achieved'])
    if (change === 'future')
      await w.database.asService(
        'update public.treatment_goal set treatment_goal_target_date = current_date + 10 where treatment_goal_id = $1',
        [target],
      )
    if (change === 'plan') await w.database.asUser(w.fx.doctorAUserId, PLAN_DISCHARGE, [w.fx.alicePlanId, 'completed_recovery'])
    if (change === 'patient') await w.database.asUser(w.fx.doctorAUserId, DISCHARGE, [w.fx.alicePatId, 'withdrew'])
    const eventsBefore = await w.systemEvents()

    await expect(w.run()).rejects.toThrow(SQLSTATE('RE64B'))
    // Nothing at all: not the other two approved goals either.
    for (const id of w.approved.slice(1)) expect(await w.status(id)).not.toBe('missed')
    expect(await w.systemEvents()).toBe(eventsBefore)
    expect((await w.state()).state).toBe('armed')
    await expect(w.run()).rejects.toThrow(SQLSTATE('RE64B'))
  })

  it('5. undoes every goal and history row when a later step fails, and stays armed', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    // A failure after the first goal has been written.
    await w.database.db.exec(`
      create function public.zz_fail_second() returns trigger language plpgsql as $$
      begin
        if (select count(*) from public.treatment_goal where treatment_goal_status = 'missed') >= 1 then
          raise exception 'injected failure';
        end if;
        return new;
      end $$;
      create trigger zz_fail_second before update of treatment_goal_status on public.treatment_goal
        for each row execute function public.zz_fail_second();`)
    await expect(w.run()).rejects.toThrow(/missed-goal check failed/)
    for (const id of w.approved) expect(await w.status(id)).not.toBe('missed')
    expect(await w.systemEvents()).toBe(0)
    expect((await w.state()).state).toBe('armed')

    await w.database.db.exec('drop trigger zz_fail_second on public.treatment_goal; drop function public.zz_fail_second();')
    expect(await w.run()).toBe(3)
  })

  it('6. cannot be bypassed by a concurrent change: a locked approved goal stops the run, and the run holds its goals', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    const db = w.database.db

    // Another transaction is changing an approved goal: the run refuses at once.
    await db.exec('begin')
    await db.query("update public.treatment_goal set treatment_goal_status = 'achieved' where treatment_goal_id = $1", [
      w.approved[1],
    ])
    await db.exec(`prepare transaction 'patient-change'`)
    await expect(w.run()).rejects.toThrow(SQLSTATE('55P03'))
    expect(await w.systemEvents()).toBe(0)
    expect((await w.state()).state).toBe('armed')
    // That change commits: the goal is no longer eligible, so nothing is marked.
    await db.exec(`commit prepared 'patient-change'`)
    await expect(w.run()).rejects.toThrow(SQLSTATE('RE64B'))
    expect(await w.status(w.approved[0]!)).toBe('pending')
  })

  it('6, 8. while the first run is in flight its goals, patients and record are held; a second run waits for it', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    // Overdue after arming, so not approved. (Made before the run: adding a
    // goal takes its plan's roadmap lock, which would wait for the run.)
    const unapproved = await w.overdue(w.bobPlanId, 4)
    const db = w.database.db
    await db.exec('begin')
    await db.query(RUN)
    await db.exec(`prepare transaction 'first-run'`)

    // PGlite has one connection, so a statement that would wait never
    // returns; NOWAIT shows the lock a waiting writer would queue behind.
    // The patient's progress updates the goal row; the doctor's discharge
    // takes the patient row FOR UPDATE; a second run takes the record FOR
    // UPDATE - each is held by the run in flight.
    const held = /could not obtain lock/
    await expect(
      w.database.asService('select 1 from public.treatment_goal where treatment_goal_id = $1 for update nowait', [w.approved[1]]),
    ).rejects.toThrow(held)
    await expect(
      w.database.asService('select 1 from public.patient where pat_id = $1 for update nowait', [w.fx.alicePatId]),
    ).rejects.toThrow(held)
    await expect(
      w.database.asService('select 1 from public.treatment_plan where treatment_plan_id = $1 for update nowait', [w.bobPlanId]),
    ).rejects.toThrow(held)
    await expect(w.database.asService('select 1 from app_private.missed_goal_bootstrap for update nowait')).rejects.toThrow(held)
    // An unapproved goal is not held.
    await w.database.asService('select 1 from public.treatment_goal where treatment_goal_id = $1 for update nowait', [unapproved])

    await db.exec(`commit prepared 'first-run'`)
    expect(await w.state()).toMatchObject({ state: 'consumed', marked: 3 })
    expect(await w.status(unapproved)).toBe('pending')
    // The patient's own change now goes through, after the run.
    await w.database.asUser(w.fx.aliceUserId, PROGRESS, [w.approved[1], 'achieved'])
    expect(await w.run()).toBe(1)
  })

  it('8. once consumed it never runs again: it cannot be re-armed, rewound or removed', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    await w.run()
    await expect(w.database.asService(ARM, [[]])).rejects.toThrow(/already been consumed/)
    await expect(
      w.database.asService("update app_private.missed_goal_bootstrap set missed_goal_bootstrap_state = 'armed'"),
    ).rejects.toThrow(/already been consumed/)
    await expect(w.database.asService('delete from app_private.missed_goal_bootstrap')).rejects.toThrow(/kept/)
    await expect(w.database.asService('truncate app_private.missed_goal_bootstrap')).rejects.toThrow(/kept/)
    await expect(
      w.database.asService('insert into app_private.missed_goal_bootstrap (missed_goal_bootstrap_singleton) values (true)'),
    ).rejects.toThrow(/duplicate key/)
    expect(await w.state()).toMatchObject({ state: 'consumed', marked: 3 })
  })

  it('may be re-armed by the owner before it runs, still only with the goals eligible then', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    await w.database.asUser(w.fx.aliceUserId, PROGRESS, [w.approved[0], 'achieved'])
    await expect(w.run()).rejects.toThrow(SQLSTATE('RE64B'))
    await expect(w.database.asService(ARM, [w.approved])).rejects.toThrow(/exactly the goals/)
    expect(await w.database.asService(ARM, [w.approved.slice(1)])).toEqual([{ armed: 2 }])
    expect(await w.run()).toBe(2)
  })

  it('arms an empty set where nothing is overdue, and then behaves as the ordinary job', async () => {
    const w = await world()
    for (const id of w.approved)
      await w.database.asService("update public.treatment_goal set treatment_goal_status = 'achieved' where treatment_goal_id = $1", [id])
    expect(await w.database.asService(ARM, [[]])).toEqual([{ armed: 0 }])
    expect(await w.run()).toBe(0)
    expect(await w.state()).toMatchObject({ state: 'consumed', marked: 0 })
    const fresh = await w.overdue(w.bobPlanId, 3)
    expect(await w.run()).toBe(1)
    expect(await w.status(fresh)).toBe('missed')
  })

  it('10, 11. the ordinary runs after it still skip discharged patients and discharged plans', async () => {
    const w = await world()
    await w.database.asService(ARM, [w.approved])
    await w.run()
    const onDischargedPlan = await w.overdue(w.fx.alicePlanId, 3)
    await w.database.asUser(w.fx.doctorAUserId, PLAN_DISCHARGE, [w.fx.alicePlanId, 'completed_recovery'])
    const ofDischargedPatient = await w.overdue(w.bobPlanId, 3)
    const [{ doc }] = await w.database.asService<{ doc: string }>('select doc_id as doc from public.patient where pat_id = $1', [
      w.fx.bobPatId,
    ])
    const [{ uid }] = await w.database.asService<{ uid: string }>('select user_id as uid from public.doctor where doc_id = $1', [doc])
    await w.database.asUser(uid, DISCHARGE, [w.fx.bobPatId, 'transferred'])
    expect(await w.run()).toBe(0)
    expect(await w.status(onDischargedPlan)).toBe('pending')
    expect(await w.status(ofDischargedPatient)).toBe('pending')
  })

  it('13. keeps the record and the arming function from every session, and the job its schedule and grants', async () => {
    const w = await world()
    const [acl] = await w.database.asService<Record<string, boolean>>(
      `select bool_or(has_table_privilege(r, 'app_private.missed_goal_bootstrap', p)) as table_any,
              bool_or(has_function_privilege(r, 'app_private.arm_missed_goal_bootstrap(uuid[])', 'execute')) as arm_any,
              bool_or(has_function_privilege(r, 'app_private.missable_treatment_goal_ids()', 'execute')) as missable_any,
              bool_or(has_function_privilege(r, 'app_private.missed_goal_bootstrap_guard()', 'execute')) as guard_any
         from unnest(array['anon', 'authenticated', 'service_role']) r,
              unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p`,
    )
    expect(acl).toEqual({ table_any: false, arm_any: false, missable_any: false, guard_any: false })
    const [job] = await w.database.asService<Record<string, boolean>>(
      `select has_function_privilege('anon', 'public.mark_missed_treatment_goals()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.mark_missed_treatment_goals()', 'execute') as auth,
              has_function_privilege('service_role', 'public.mark_missed_treatment_goals()', 'execute') as service`,
    )
    expect(job).toEqual({ anon: false, auth: false, service: true })

    await expect(w.database.asUser(w.fx.doctorAUserId, ARM, [w.approved])).rejects.toThrow(/permission denied/)
    await expect(w.database.asUser(w.fx.adminUserId, ARM, [w.approved])).rejects.toThrow(/permission denied/)
    await expect(w.database.asUser(w.fx.aliceUserId, 'select * from app_private.missed_goal_bootstrap')).rejects.toThrow(
      /permission denied/,
    )
    await expect(w.database.asAnon(ARM, [w.approved])).rejects.toThrow(/permission denied/)
    expect((await w.state()).state).toBe('unarmed')

    const source = await script('supabase/migrations/20260902100064_treatment_goal_progress.sql')
    expect(source).toMatch(
      /cron\.schedule\(\s*'recoverease-mark-missed-treatment-goals',\s*'10 \* \* \* \*',\s*\$job\$ select public\.mark_missed_treatment_goals\(\) \$job\$/,
    )
    // No goal is named in the migration: the approved set arrives at apply time.
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('14. rolls back to exactly what 63 left, and a re-apply starts unarmed again', async () => {
    const full = await world('20260902100064')
    const through63 = await createTestDatabase({ stopAfter: '20260902100063' })
    open.push(through63)
    const after64 = await catalog(full.database)
    await full.database.asService(ARM, [full.approved])
    await full.run()

    await full.database.db.exec(await script(ROLLBACK_64))
    expect(await catalog(full.database)).toEqual(await catalog(through63))
    expect(await full.database.asService("select to_regclass('app_private.missed_goal_bootstrap') as t")).toEqual([{ t: null }])

    await full.database.applyMigration('20260902100064')
    expect(await catalog(full.database)).toEqual(after64)
    expect(await full.state()).toEqual({ state: 'unarmed', ids: null, marked: null })
    await expect(full.run()).rejects.toThrow(SQLSTATE('RE64A'))
  })
})
