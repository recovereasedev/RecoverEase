import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * QA-01 / QA-02 — ending a medication.
 *
 * A course written with no end date ran forever, and setting an end date did
 * not stop it: the doses generated ahead of time stayed, and the reminder and
 * overdue jobs look at each dose, not its schedule. Ending a course now sets
 * its end date to the clinic's today; the doses still waiting after that are
 * removed, recorded doses stay exactly as they were, and neither job acts on
 * anything dated after the end date.
 *
 * Days are counted from the clinic's today (`app_today()`), and times are
 * clinic wall-clock times, so the assertions hold whenever the suite runs.
 */
describe('ending a medication', () => {
  const ZONE = 'Asia/Manila'

  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await database.asService(
      `insert into public.system_setting (system_setting_key, system_setting_value)
       values ('app.timezone', $1)`,
      [ZONE],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    // Doses go with their schedules. Alice's prescription stays.
    await database.asService(
      `delete from public.notification where notification_type = 'medication'`,
    )
    await database.asService('delete from public.medication_schedule')
    await database.asService(
      `update public.patient
          set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null`,
    )
  })

  // --- Helpers --------------------------------------------------------------

  /** A schedule on Alice's prescription; start and end are days from today. */
  async function schedule(
    options: { times?: string; startIn?: number; endIn?: number | null } = {},
  ): Promise<string> {
    const { times = '{08:00,20:00}', startIn = 0, endIn = null } = options
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times,
          medication_schedule_start_date, medication_schedule_end_date)
       values ($1, 'Amoxicillin', '500mg', cardinality($2::time[]), $2::time[],
               public.app_today() + $3::int,
               case when $4::int is null then null else public.app_today() + $4::int end)
       returning medication_schedule_id as id`,
      [fx.alicePrescriptionId, times, startIn, endIn],
    )
    return row!.id
  }

  /** "End medication", as the app writes it: the end date only. Resolves to rows changed. */
  async function endAs(userId: string, scheduleId: string, inDays = 0): Promise<number> {
    const rows = await database.asUser(
      userId,
      `update public.medication_schedule
          set medication_schedule_end_date = public.app_today() + $2::int
        where medication_schedule_id = $1
        returning medication_schedule_id`,
      [scheduleId, inDays],
    )
    return rows.length
  }

  /** A dose recorded directly, `dayIn` days from today at `time` clinic time. */
  async function dose(
    scheduleId: string,
    dayIn: number,
    time: string,
    status = 'pending',
    chased = false,
  ): Promise<void> {
    await database.asService(
      `insert into public.medication_log
         (medication_schedule_id, medication_log_scheduled_at, medication_log_status,
          medication_log_taken_at, medication_log_follow_up_sent_at)
       values (
         $1,
         ((public.app_today() + $2::int) + $3::time) at time zone $4,
         $5::public.medication_log_status,
         case when $5::text = 'taken'
              then (((public.app_today() + $2::int) + $3::time) at time zone $4) + interval '5 minutes' end,
         case when $6::boolean
              then (((public.app_today() + $2::int) + $3::time) at time zone $4) + interval '30 minutes' end
       )
       on conflict (medication_schedule_id, medication_log_scheduled_at)
       do update set medication_log_status = excluded.medication_log_status,
                     medication_log_taken_at = excluded.medication_log_taken_at,
                     medication_log_follow_up_sent_at = excluded.medication_log_follow_up_sent_at`,
      [scheduleId, dayIn, time, ZONE, status, chased],
    )
  }

  type Dose = {
    day: number
    time: string
    status: string
    future: boolean
    chased: boolean
    row: unknown
  }

  /** Every dose of a schedule, oldest first, with its day relative to today. */
  async function doses(scheduleId: string): Promise<Dose[]> {
    const rows = await database.asService<Dose>(
      `select (medication_log_scheduled_at at time zone $2)::date - public.app_today() as day,
              to_char(medication_log_scheduled_at at time zone $2, 'HH24:MI') as time,
              medication_log_status::text as status,
              medication_log_scheduled_at > now() as future,
              medication_log_follow_up_sent_at is not null as chased,
              to_jsonb(l) as row
         from public.medication_log l
        where medication_schedule_id = $1
        order by medication_log_scheduled_at`,
      [scheduleId, ZONE],
    )
    return rows.map((row) => ({ ...row, day: Number(row.day) }))
  }

  const lastDay = (list: Dose[]) => Math.max(...list.map((item) => item.day))
  const waitingAfter = (list: Dose[], day: number) =>
    list.filter((item) => item.day > day && item.status === 'pending' && item.future)

  async function endDateIn(scheduleId: string): Promise<number | null> {
    const [row] = await database.asService<{ end_in: number | null }>(
      `select medication_schedule_end_date - public.app_today() as end_in
         from public.medication_schedule where medication_schedule_id = $1`,
      [scheduleId],
    )
    return row!.end_in === null ? null : Number(row!.end_in)
  }

  async function call(fn: string, arg: number): Promise<number> {
    const [row] = await database.asService<{ n: number }>(
      `select public.${fn}($1) as n`,
      [arg],
    )
    return Number(row!.n)
  }
  const dispatch = (graceMinutes = 30) => call('dispatch_medication_reminders', graceMinutes)
  const markOverdue = (graceHours = 6) => call('mark_overdue_medication_logs', graceHours)
  const extend = (horizonDays = 30) => call('extend_all_medication_log_slots', horizonDays)

  async function generate(scheduleId: string, horizonDays = 60): Promise<number> {
    const [row] = await database.asService<{ n: number }>(
      'select public.generate_medication_log_slots($1, $2) as n',
      [scheduleId, horizonDays],
    )
    return Number(row!.n)
  }

  async function reminders(): Promise<string[]> {
    const rows = await database.asService<{ notification_message: string }>(
      `select notification_message from public.notification
        where notification_type = 'medication' order by notification_created_at`,
    )
    return rows.map((row) => row.notification_message)
  }

  // --- Ending ---------------------------------------------------------------

  it('keeps today and removes every waiting dose after it', async () => {
    const id = await schedule()
    // Thirty days ahead of today, twice a day.
    expect(await doses(id)).toHaveLength(62)

    expect(await endAs(fx.doctorAUserId, id)).toBe(1)

    const after = await doses(id)
    expect(await endDateIn(id)).toBe(0)
    expect(lastDay(after)).toBe(0)
    // Today's two doses stay — the course includes today.
    expect(after.filter((item) => item.day === 0)).toHaveLength(2)
    expect(after.filter((item) => item.day > 0)).toHaveLength(0)
  })

  it('leaves an ongoing medication exactly as it was', async () => {
    const id = await schedule()
    const before = await doses(id)

    expect(before).toHaveLength(62)
    expect(lastDay(before)).toBe(30)
    expect(await extend()).toBe(0)
    expect(await generate(id, 30)).toBe(0)
    // A change that is not the end date sets nothing in motion.
    await database.asUser(
      fx.doctorAUserId,
      `update public.medication_schedule set medication_schedule_name = 'Amoxicillin'
        where medication_schedule_id = $1`,
      [id],
    )
    expect(await doses(id)).toEqual(before)
  })

  it('moving an end date earlier removes only the days given up, and nothing grows back', async () => {
    const id = await schedule({ endIn: 10 })
    expect(lastDay(await doses(id))).toBe(10)
    expect(await doses(id)).toHaveLength(22)

    expect(await endAs(fx.doctorAUserId, id, 3)).toBe(1)

    let after = await doses(id)
    expect(lastDay(after)).toBe(3)
    expect(after).toHaveLength(8)

    expect(await extend()).toBe(0)
    expect(await generate(id)).toBe(0)
    after = await doses(id)
    expect(lastDay(after)).toBe(3)
  })

  it('an end date in the past leaves no waiting dose after it', async () => {
    const id = await schedule({ startIn: -5 })
    // Due at midnight today: already come due, and after the new end date.
    await dose(id, 0, '00:00')

    expect(await endAs(fx.doctorAUserId, id, -1)).toBe(1)

    const after = await doses(id)
    expect(waitingAfter(after, -1)).toHaveLength(0)
    // A dose that has already come due is not a placeholder: it stays, but
    // nothing acts on it (see the reminder and overdue tests).
    expect(after.find((item) => item.day === 0 && item.time === '00:00')?.status).toBe(
      'pending',
    )
  })

  // --- Generation -----------------------------------------------------------

  it('never generates a dose past the end date', async () => {
    const id = await schedule({ endIn: 3 })

    expect(lastDay(await doses(id))).toBe(3)
    expect(await doses(id)).toHaveLength(8)
    expect(await generate(id, 60)).toBe(0)
    expect(lastDay(await doses(id))).toBe(3)
  })

  it('the daily extension job never runs a course past its end', async () => {
    const finite = await schedule({ endIn: 3 })
    const ended = await schedule({ startIn: -5, endIn: -1 })

    expect(await extend(30)).toBe(0)

    expect(lastDay(await doses(finite))).toBe(3)
    expect(await doses(ended)).toHaveLength(0)
  })

  // --- The jobs -------------------------------------------------------------

  it('the reminder job chases nothing dated after the end date, and still chases what came before', async () => {
    const id = await schedule({ startIn: -5 })
    await dose(id, -1, '08:00') // yesterday, inside the course, never recorded
    await dose(id, 0, '00:00') // today, after the course
    await endAs(fx.doctorAUserId, id, -1)

    expect(await dispatch(0)).toBe(1)
    expect(await reminders()).toEqual([
      'Have you taken your Amoxicillin (500mg)? It was due at 08:00.',
    ])
    const midnight = (await doses(id)).find((item) => item.day === 0 && item.time === '00:00')
    expect(midnight?.chased).toBe(false)
    expect(await dispatch(0)).toBe(0)
  })

  it('the overdue job writes off nothing dated after the end date, and still what came before', async () => {
    const id = await schedule({ startIn: -5 })
    await dose(id, -1, '08:00')
    await dose(id, 0, '00:00')
    await endAs(fx.doctorAUserId, id, -1)

    expect(await markOverdue(0)).toBe(1)

    const after = await doses(id)
    expect(after.find((item) => item.day === -1 && item.time === '08:00')?.status).toBe(
      'missed',
    )
    expect(after.find((item) => item.day === 0 && item.time === '00:00')?.status).toBe(
      'pending',
    )
  })

  // --- History --------------------------------------------------------------

  it('leaves every recorded dose exactly as it was', async () => {
    const id = await schedule({ startIn: -5 })
    await dose(id, -4, '08:00', 'taken')
    await dose(id, -4, '20:00', 'missed', true)
    await dose(id, -3, '08:00', 'skipped')
    await dose(id, -1, '20:00', 'pending', true) // came due and was chased
    await dose(id, 2, '08:00', 'skipped') // marked ahead of time, after the end

    const recorded = (list: Dose[]) =>
      list.filter((item) => item.day < 0 || item.status !== 'pending').map((item) => item.row)
    const before = recorded(await doses(id))
    expect(before).toHaveLength(5)

    await endAs(fx.doctorAUserId, id)

    const after = await doses(id)
    expect(recorded(after)).toEqual(before)
    expect(waitingAfter(after, 0)).toHaveLength(0)
  })

  // --- Who may end it -------------------------------------------------------

  it('lets the assigned doctor end it, and nobody else', async () => {
    const id = await schedule()
    const before = await doses(id)

    // The patient, another doctor, a deactivated doctor and the administrator
    // match no row under the existing access rules.
    for (const outsider of [fx.aliceUserId, fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId]) {
      expect(await endAs(outsider, id)).toBe(0)
    }
    await expect(
      database.asAnon(
        `update public.medication_schedule set medication_schedule_end_date = current_date
          where medication_schedule_id = $1`,
        [id],
      ),
    ).rejects.toThrow()

    expect(await endDateIn(id)).toBeNull()
    expect(await doses(id)).toEqual(before)

    expect(await endAs(fx.doctorAUserId, id)).toBe(1)
    expect(await endDateIn(id)).toBe(0)
  })

  // --- Repeating it ---------------------------------------------------------

  it('ending an ended medication again changes nothing', async () => {
    const id = await schedule({ startIn: -2 })
    await dose(id, -1, '08:00', 'taken')
    await dose(id, -1, '20:00', 'missed')
    await endAs(fx.doctorAUserId, id)
    const once = await doses(id)

    expect(await endAs(fx.doctorAUserId, id)).toBe(1)
    expect(await endAs(fx.doctorAUserId, id)).toBe(1)

    expect(await doses(id)).toEqual(once)
    expect(await endDateIn(id)).toBe(0)
  })

  // --- Everything around it -------------------------------------------------

  it('leaves the prescription, the patient’s checklist and other medicines alone', async () => {
    const ending = await schedule()
    const other = await schedule({ times: '{09:00}' })
    const otherBefore = await doses(other)

    await endAs(fx.doctorAUserId, ending)

    // Another medicine on the same prescription is untouched.
    expect(await doses(other)).toEqual(otherBefore)
    // Still on the same prescription.
    const [row] = await database.asService<{ prescription_id: string }>(
      'select prescription_id from public.medication_schedule where medication_schedule_id = $1',
      [ending],
    )
    expect(row!.prescription_id).toBe(fx.alicePrescriptionId)
    // The patient still sees today's doses of the ended medicine, through the
    // same access rules the checklist uses.
    const today = await database.asUser<{ count: number }>(
      fx.aliceUserId,
      `select count(*)::int as count from public.medication_log
        where medication_schedule_id = $1
          and (medication_log_scheduled_at at time zone $2)::date = public.app_today()`,
      [ending, ZONE],
    )
    expect(Number(today[0]!.count)).toBe(2)
  })

  // --- Security -------------------------------------------------------------

  it('removes doses through a definer function nobody can call directly', async () => {
    const [fn] = await database.asService<{
      definer: boolean
      config: string[] | null
      authenticated: boolean
      anon: boolean
    }>(
      `select p.prosecdef as definer,
              p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p
        where p.oid = 'public.medication_schedule_close_ended_doses'::regproc`,
    )
    expect(fn!.definer).toBe(true)
    expect(fn!.config).toEqual(['search_path=""'])
    expect(fn!.authenticated).toBe(false)
    expect(fn!.anon).toBe(false)

    const [trigger] = await database.asService<{ definition: string }>(
      `select pg_get_triggerdef(oid) as definition
         from pg_trigger where tgname = 'medication_schedule_close_ended_doses'`,
    )
    expect(trigger!.definition).toMatch(
      /AFTER UPDATE OF medication_schedule_end_date ON public\.medication_schedule FOR EACH ROW WHEN/,
    )
  })
})
