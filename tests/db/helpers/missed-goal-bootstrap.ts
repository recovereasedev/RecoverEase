import type { TestDatabase } from './database'

/**
 * Migration 64's missed-goal job refuses to run until its one-time first run
 * has been armed and consumed (tests/db/missed-goal-first-run.test.ts). A
 * suite that exercises the ordinary hourly job arms it with exactly the goals
 * eligible now - none, in a freshly seeded database - and runs it once, so
 * every later run is the ordinary automation.
 */
export async function completeMissedGoalFirstRun(database: TestDatabase): Promise<void> {
  await database.asService(
    'select app_private.arm_missed_goal_bootstrap(array(select app_private.missable_treatment_goal_ids()))',
  )
  await database.asService('select public.mark_missed_treatment_goals()')
}
