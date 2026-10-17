import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 31 moves where the time zone comes from, not what it does.
 *
 * The same story is played against two databases: one stopped after 30,
 * with the `app.timezone` setting production has, and one with 31, where
 * the clinic's zone is the same one. Every date, dose slot, missed-dose
 * mark, reminder, notice and date check must come out the same - for the
 * existing clinic, nothing changes.
 */

const ZONE = 'Asia/Manila'

type Outcome = string

async function attempt(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run()
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Plays the story, and returns what it produced - free of any generated id. */
async function story(database: TestDatabase, fx: Fixture) {
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!
  const texts = async (sql: string, params: unknown[] = []) =>
    (await database.asService<{ t: string }>(sql, params)).map((row) => row.t)

  const today = await one<string>('select public.app_today()::text')

  // Doses: a new course, twice a day.
  const prescription = await one<string>(
    `insert into public.prescription (pat_id, doc_id) values ($1, $2) returning prescription_id`,
    [fx.alicePatId, fx.doctorAId],
  )
  const schedule = await one<string>(
    `insert into public.medication_schedule
       (prescription_id, medication_schedule_name, medication_schedule_dosage,
        medication_schedule_frequency, medication_schedule_times)
     values ($1, 'Ibuprofen', '200mg', 2, '{07:15,21:40}'::time[])
     returning medication_schedule_id`,
    [prescription],
  )
  const slots = () =>
    texts(
      `select medication_log_scheduled_at::text as t from public.medication_log
        where medication_schedule_id = $1 order by 1`,
      [schedule],
    )
  const generated = await slots()

  await database.asService(
    `delete from public.medication_log where medication_schedule_id = $1 and medication_log_status = 'pending'`,
    [schedule],
  )
  const extended = await one<number>('select public.extend_all_medication_log_slots(10)')
  const regenerated = await slots()

  // Missed doses, under the administrator's three-hour grace period.
  await database.asService(
    `insert into public.system_setting (system_setting_key, system_setting_value)
     values ('medication.reminder_grace_hours', '3')`,
  )
  const late = async (hours: number) =>
    one<string>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, date_trunc('minute', now()) - make_interval(hours => $2)) returning medication_log_id`,
      [schedule, hours],
    )
  const twoHoursLate = await late(2)
  const fourHoursLate = await late(4)
  await one<number>('select public.mark_overdue_medication_logs(6)')
  const status = (id: string) =>
    one<string>('select medication_log_status::text from public.medication_log where medication_log_id = $1', [id])
  const marked = { twoHoursLate: await status(twoHoursLate), fourHoursLate: await status(fourHoursLate) }

  // A dose reminder, for one due yesterday at 06:05 clinic time.
  await database.asService('update public.medication_log set medication_log_follow_up_sent_at = now()')
  await database.asService(
    `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
     values ($1, ((public.app_today() - 1) + time '06:05') at time zone '${ZONE}')`,
    [schedule],
  )
  await database.asService('delete from public.notification')
  const doseReminders = await one<number>('select public.dispatch_medication_reminders(30)')
  const doseMessages = await texts('select notification_message as t from public.notification order by 1')

  // An appointment tomorrow at 09:45 clinic time: reminded, then cancelled.
  await database.asService('delete from public.notification')
  const appointment = await one<string>(
    `insert into public.appointment (pat_id, doc_id, appointment_date)
     values ($1, $2, ((public.app_today() + 1) + time '09:45') at time zone '${ZONE}')
     returning appointment_id`,
    [fx.alicePatId, fx.doctorAId],
  )
  const appointmentReminders = await one<number>('select public.dispatch_appointment_reminders(48)')
  const reminderMessages = await texts('select notification_message as t from public.notification order by 1')
  await database.asService('delete from public.notification')
  await database.asService(`update public.appointment set appointment_status = 'cancelled' where appointment_id = $1`, [
    appointment,
  ])
  const cancellationMessages = await texts('select notification_message as t from public.notification order by 1')

  // The course ends today: what is left to come.
  await database.asService(
    'update public.medication_schedule set medication_schedule_end_date = public.app_today() where medication_schedule_id = $1',
    [schedule],
  )
  const afterEnding = await texts(
    `select medication_log_scheduled_at::text as t from public.medication_log
      where medication_schedule_id = $1 and medication_log_status = 'pending' and medication_log_scheduled_at > now()
      order by 1`,
    [schedule],
  )

  // Dates a person enters.
  const dates = {
    recoveryToday: await attempt(() =>
      database.asService(
        `insert into public.recovery_log (pat_id, recovery_log_date) values ($1, public.app_today() - 1)`,
        [fx.bobPatId],
      ),
    ),
    recoveryTomorrow: await attempt(() =>
      database.asService(
        `insert into public.recovery_log (pat_id, recovery_log_date) values ($1, public.app_today() + 1)`,
        [fx.bobPatId],
      ),
    ),
    bornToday: await attempt(() =>
      database.asService('update public.patient set pat_birth_date = public.app_today() where pat_id = $1', [fx.bobPatId]),
    ),
    bornTomorrow: await attempt(() =>
      database.asService('update public.patient set pat_birth_date = public.app_today() + 1 where pat_id = $1', [
        fx.bobPatId,
      ]),
    ),
    bornLongAgo: await attempt(() =>
      database.asService(
        `update public.patient set pat_birth_date = public.app_today() - interval '131 years' where pat_id = $1`,
        [fx.bobPatId],
      ),
    ),
  }

  return {
    today,
    generated,
    extended,
    regenerated,
    marked,
    doseReminders,
    doseMessages,
    appointmentReminders,
    reminderMessages,
    cancellationMessages,
    afterEnding,
    dates,
  }
}

describe('for the existing clinic, migration 31 changes no date or time', () => {
  let before: TestDatabase
  let after: TestDatabase
  let beforeFx: Fixture
  let afterFx: Fixture

  beforeAll(async () => {
    ;[before, after] = await Promise.all([
      createTestDatabase({ stopAfter: '20260902100030' }),
      createTestDatabase(),
    ])
    for (const database of [before, after]) {
      // As in production: the zone the clinic was created in, as a setting.
      await database.asService(
        `insert into public.system_setting (system_setting_key, system_setting_value) values ('app.timezone', '${ZONE}')`,
      )
    }
    beforeFx = await seedFixture(before)
    afterFx = await seedFixture(after)
  })

  afterAll(async () => {
    await Promise.all([before?.close(), after?.close()])
  })

  it('gives the same today, doses, missed marks, reminders, notices and date checks', async () => {
    expect(
      await after.asService(`select clinic_timezone from public.clinic`),
    ).toEqual([{ clinic_timezone: ZONE }])

    const [was, is] = await Promise.all([story(before, beforeFx), story(after, afterFx)])

    // The story has something in it: the comparison is not of nothing.
    expect(was.generated.length).toBeGreaterThan(40)
    expect(was.doseMessages).toHaveLength(1)
    expect(was.reminderMessages).toHaveLength(2)
    expect(was.cancellationMessages).toHaveLength(2)
    expect(was.marked).toEqual({ twoHoursLate: 'pending', fourHoursLate: 'missed' })
    expect(was.dates.recoveryTomorrow).toMatch(/future/)

    expect(is).toEqual(was)
  })
})
