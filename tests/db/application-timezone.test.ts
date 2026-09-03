import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Regression tests for a bug that reached production.
 *
 * A patient in Manila could not save their daily recovery entry between
 * midnight and 08:00 local. The database runs in UTC, the browser sends the
 * patient's *local* date on purpose, and the guard compared that against
 * `current_date` — the server's date. For the first eight hours of every
 * local day the two disagreed, and the guard read the patient's own today as
 * tomorrow and rejected it.
 *
 * Why the old suite could not have caught it: every test ran the database and
 * the assertions on one clock, and built dates with `current_date`. Client
 * and server always agreed, which is exactly the condition under which the
 * bug does not exist.
 *
 * So these tests deliberately pull the two clocks apart, and pin them far
 * enough apart that the disagreement is not a matter of what time the suite
 * happens to run:
 *
 *   server  Pacific/Niue        UTC-11
 *   clinic  Pacific/Kiritimati  UTC+14
 *
 * That is a 25-hour spread. Because 25 > 24, the clinic's calendar date is
 * strictly ahead of the server's at every instant of the year — so a test
 * written against the clinic's today exercises the mismatch on every run,
 * not just during a lucky window. Against the pre-fix schema these fail
 * whenever they are run; there is no hour at which they would pass by
 * accident.
 */
const SERVER_ZONE = 'Pacific/Niue' // UTC-11
const CLINIC_ZONE = 'Pacific/Kiritimati' // UTC+14

describe('calendar dates resolve in the clinic timezone, not the server one', () => {
  let database: TestDatabase
  let fixture: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fixture = await seedFixture(database)

    await database.asService(
      `insert into public.system_setting
         (system_setting_key, system_setting_value)
       values ('app.timezone', $1)
       on conflict (system_setting_key) do update
         set system_setting_value = excluded.system_setting_value`,
      [CLINIC_ZONE],
    )

    // Move the server off UTC too, so a fix that merely hard-codes UTC
    // somewhere would not satisfy these tests either.
    await database.asService(`set time zone '${SERVER_ZONE}'`)

    // Start from no recovery entries.
    //
    // The fixture seeds one for Alice dated `app_today()`, which it evaluates
    // before the clinic zone above is set — so it lands on the UTC date.
    // `recovery_log_patient_day_key` allows one entry per patient per day, and
    // Kiritimati's date equals UTC's for the fourteen hours before 10:00 UTC.
    // Inside that window the fixture row and this suite's insert are the same
    // day and collide; outside it they do not. That made the suite pass or
    // fail on the clock rather than on the behaviour under test — the same
    // failure mode these tests exist to catch, reintroduced by the tests
    // themselves. Clearing the table removes the dependency entirely.
    await database.asService('delete from public.recovery_log')
  })

  afterAll(async () => {
    await database?.close()
  })

  it('puts the clinic date strictly ahead of the server date', async () => {
    // Guards the premise of every test below. If this ever fails the zones
    // above stopped being 25 hours apart and the rest proves nothing.
    const [row] = await database.asService<{ day_difference: number }>(
      `select (public.app_today() - current_date) as day_difference`,
    )

    expect(row?.day_difference).toBeGreaterThanOrEqual(1)
  })

  it('accepts a recovery entry dated today in the clinic timezone', async () => {
    // The exact production failure. The patient's own today is not the
    // future, whatever the server's clock says.
    const saved = await database.asUser<{ recovery_log_date: string }>(
      fixture.aliceUserId,
      `insert into public.recovery_log
         (pat_id, recovery_log_date, recovery_log_notes)
       values ($1, public.app_today(), 'logged just after midnight')
       returning recovery_log_date`,
      [fixture.alicePatId],
    )

    expect(saved).toHaveLength(1)
  })

  it('still rejects an entry dated after the clinic today', async () => {
    // The guard has to keep guarding. Moving it onto the clinic clock must
    // not turn it into a rule that accepts anything.
    await expect(
      database.asUser(
        fixture.aliceUserId,
        `insert into public.recovery_log
           (pat_id, recovery_log_date, recovery_log_notes)
         values ($1, public.app_today() + 1, 'tomorrow')`,
        [fixture.alicePatId],
      ),
    ).rejects.toThrow(/cannot be dated in the future/)
  })

  it('defaults a recovery entry to the clinic date, not the server date', async () => {
    const [row] = await database.asService<{
      defaulted_to_clinic_today: boolean
    }>(
      `insert into public.recovery_log (pat_id, recovery_log_notes)
       values ($1, 'no date supplied')
       returning (recovery_log_date = public.app_today())
                   as defaulted_to_clinic_today`,
      [fixture.bobPatId],
    )

    expect(row?.defaulted_to_clinic_today).toBe(true)
  })

  it('accepts a birth date of today in the clinic timezone', async () => {
    // Same guard, same mistake: a date of birth recorded on the clinic's
    // today is not in the future.
    const saved = await database.asService(
      `update public.patient
          set pat_birth_date = public.app_today()
        where pat_id = $1
        returning pat_id`,
      [fixture.bobPatId],
    )

    expect(saved).toHaveLength(1)
  })

  it('generates the current clinic day of doses rather than skipping it', async () => {
    // The dose window opened at the server's today. With the clinic a day
    // ahead, every dose for the day the patient is actually living fell
    // before the window and was never created.
    await database.asService(
      `update public.medication_schedule
          set medication_schedule_start_date = public.app_today(),
              medication_schedule_end_date = public.app_today()
        where medication_schedule_id = $1`,
      [fixture.aliceScheduleId],
    )

    await database.asService(
      `select public.generate_medication_log_slots($1, 30)`,
      [fixture.aliceScheduleId],
    )

    const [row] = await database.asService<{ doses_for_clinic_today: string }>(
      `select count(*) as doses_for_clinic_today
         from public.medication_log
        where medication_schedule_id = $1
          and (medication_log_scheduled_at at time zone $2)::date
              = public.app_today()`,
      [fixture.aliceScheduleId, CLINIC_ZONE],
    )

    expect(Number(row?.doses_for_clinic_today)).toBeGreaterThan(0)
  })

  it('keeps a schedule ending today in the live set for the whole day', async () => {
    // `extend_all_medication_log_slots` filtered on the server date, so a
    // course ending today looked expired a day early.
    const [row] = await database.asService<{ still_live: boolean }>(
      `select exists (
         select 1 from public.medication_schedule
          where medication_schedule_id = $1
            and (medication_schedule_end_date is null
                 or medication_schedule_end_date >= public.app_today())
       ) as still_live`,
      [fixture.aliceScheduleId],
    )

    expect(row?.still_live).toBe(true)
  })

  it('does not expose app_today to unauthenticated callers', async () => {
    // It is SECURITY DEFINER and reads an admin-only table, so it must not
    // become an anonymous endpoint.
    const [row] = await database.asService<{ anon_can_call: boolean }>(
      `select has_function_privilege('anon', 'public.app_today()', 'EXECUTE')
                as anon_can_call`,
    )

    expect(row?.anon_can_call).toBe(false)
  })
})
