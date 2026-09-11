import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * QA-03 — the missed-dose grace period comes from System Settings.
 *
 * Admin → System settings stores "Missed dose grace period (hours)" as
 * `medication.reminder_grace_hours`, and the overdue job ignored it: the job
 * is scheduled as mark_overdue_medication_logs(6), so a dose was written off
 * six hours after it was due whatever the setting said. The function now
 * reads the setting itself. A usable value — whole hours, 1 to 24 — decides;
 * anything else falls back to the argument, which is the job's 6.
 *
 * Each timing case runs in one transaction, so `now()` is the same instant for
 * the doses and the job, and "exactly at the grace period" is exact.
 */
describe('missed-dose grace period', () => {
  const ZONE = 'Asia/Manila'
  const KEY = 'medication.reminder_grace_hours'
  const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations', import.meta.url))

  let database: TestDatabase
  let fx: Fixture
  let scheduleId: string
  /** The jobs' commands, as the migrations last schedule them. */
  const jobs = { overdue: '', reminders: '' }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await database.asService(
      `insert into public.system_setting (system_setting_key, system_setting_value)
       values ('app.timezone', $1)`,
      [ZONE],
    )

    for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort()) {
      const sql = await readFile(`${MIGRATIONS}/${name}`, 'utf8')
      for (const [, job, command] of sql.matchAll(
        /cron\.schedule\(\s*'([^']+)',\s*'[^']+',\s*\$job\$(.*?)\$job\$/gs,
      )) {
        if (job === 'recoverease-mark-overdue-doses') jobs.overdue = command!.trim()
        if (job === 'recoverease-medication-reminders') jobs.reminders = command!.trim()
      }
    }
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.system_setting where system_setting_key = $1', [KEY])
    await database.asService(
      `delete from public.notification where notification_type = 'medication'`,
    )
    await database.asService('delete from public.medication_schedule')
    await database.asService(
      `update public.patient
          set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null`,
    )
    scheduleId = await schedule()
  })

  // --- Helpers --------------------------------------------------------------

  /** An ongoing course on Alice's prescription, started three days ago. */
  async function schedule(): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times,
          medication_schedule_start_date)
       values ($1, 'Amoxicillin', '500mg', 1, '{08:00}'::time[], public.app_today() - 3)
       returning medication_schedule_id as id`,
      [fx.alicePrescriptionId],
    )
    return row!.id
  }

  /** Saves the setting as the settings page does: an upsert, as the administrator. */
  async function setGrace(value: string): Promise<void> {
    const rows = await database.asUser(
      fx.adminUserId,
      `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
       values ($1, $2, $3)
       on conflict (system_setting_key) do update
         set admin_id = excluded.admin_id,
             system_setting_value = excluded.system_setting_value
       returning system_setting_value`,
      [fx.adminId, KEY, value],
    )
    expect(rows).toEqual([{ system_setting_value: value }])
  }

  type Dose = { late: number; status: string; chased: boolean }

  /**
   * Pending doses `late` minutes overdue, then `sql`, in one transaction that
   * is rolled back. Resolves to each dose afterwards, keyed by minutes late.
   */
  async function run(sql: string, late: number[]): Promise<Map<number, Dose>> {
    await database.db.exec('begin')
    try {
      await database.db.query('delete from public.medication_log where medication_schedule_id = $1', [
        scheduleId,
      ])
      await database.db.query(
        `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
         select $1, now() - make_interval(mins => m) from unnest($2::int[]) m`,
        [scheduleId, [...new Set(late)]],
      )
      await database.db.query(sql)
      const { rows } = await database.db.query<Dose>(
        `select round(extract(epoch from now() - medication_log_scheduled_at) / 60)::int as late,
                medication_log_status::text as status,
                medication_log_follow_up_sent_at is not null as chased
           from public.medication_log
          where medication_schedule_id = $1`,
        [scheduleId],
      )
      return new Map(rows.map((row) => [row.late, row]))
    } finally {
      await database.db.exec('rollback')
    }
  }

  /** The overdue job, as scheduled. Each dose's status afterwards, by minutes late. */
  async function overdue(late: number[], sql = jobs.overdue): Promise<Record<number, string>> {
    const doses = await run(sql, late)
    return Object.fromEntries([...doses].map(([minutes, dose]) => [minutes, dose.status]))
  }

  /** Just before, exactly at, and just after `hours`. */
  const around = (hours: number) => [hours * 60 - 1, hours * 60, hours * 60 + 1]
  const openThenMissed = (hours: number) => ({
    [hours * 60 - 1]: 'pending',
    [hours * 60]: 'pending',
    [hours * 60 + 1]: 'missed',
  })

  /** A dose recorded outside a rolled-back run, for cases spanning several runs. */
  async function dose(minutesLate: number, status = 'pending'): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_log
         (medication_schedule_id, medication_log_scheduled_at, medication_log_status,
          medication_log_taken_at)
       values ($1, now() - make_interval(mins => $2), $3::public.medication_log_status,
               case when $3 = 'taken' then now() - make_interval(mins => $2 - 5) end)
       returning medication_log_id as id`,
      [scheduleId, minutesLate, status],
    )
    return row!.id
  }

  async function row(doseId: string): Promise<Record<string, unknown>> {
    const [found] = await database.asService<{ row: Record<string, unknown> }>(
      'select to_jsonb(l) as row from public.medication_log l where medication_log_id = $1',
      [doseId],
    )
    return found!.row
  }

  const statusOf = async (doseId: string) => (await row(doseId))['medication_log_status']

  async function runJob(): Promise<number> {
    const [result] = await database.asService<Record<string, number>>(jobs.overdue)
    return Number(Object.values(result!)[0])
  }

  // --- The scheduled job ----------------------------------------------------

  describe('the scheduled job', () => {
    it('is still scheduled as mark_overdue_medication_logs(6)', () => {
      // The setting is resolved inside the function; the job is unchanged.
      expect(jobs.overdue).toBe('select public.mark_overdue_medication_logs(6)')
    })

    it('with no setting stored, writes a dose off after six hours', async () => {
      expect(await overdue(around(6))).toEqual(openThenMissed(6))
    })

    it.each([6, 2, 12, 1, 24])(
      'at a setting of %i hours: open just before and exactly at it, missed just after',
      async (hours) => {
        await setGrace(String(hours))
        expect(await overdue(around(hours))).toEqual(openThenMissed(hours))
      },
    )

    it('follows the setting rather than the 6 the job passes', async () => {
      await setGrace('12')
      expect(await overdue([6 * 60 + 1, 11 * 60 + 59])).toEqual({
        [6 * 60 + 1]: 'pending',
        [11 * 60 + 59]: 'pending',
      })

      await setGrace('2')
      expect(await overdue([2 * 60 + 1, 5 * 60 + 59])).toEqual({
        [2 * 60 + 1]: 'missed',
        [5 * 60 + 59]: 'missed',
      })
    })

    it.each([
      [' 2 ', 2],
      ['02', 2],
      ['\t12\n', 12],
    ])('reads %j as %i hours', async (stored, hours) => {
      await setGrace(stored)
      expect(await overdue(around(hours))).toEqual(openThenMissed(hours))
    })
  })

  // --- Changing the setting -------------------------------------------------

  describe('changing the setting', () => {
    it('6 → 2: a dose already more than two hours late is missed at the next run', async () => {
      const doseId = await dose(3 * 60)

      await setGrace('6')
      expect(await runJob()).toBe(0)
      expect(await statusOf(doseId)).toBe('pending')

      await setGrace('2')
      expect(await runJob()).toBe(1)
      expect(await statusOf(doseId)).toBe('missed')
    })

    it('6 → 12: a dose already missed stays missed', async () => {
      const doseId = await dose(8 * 60)
      await setGrace('6')
      await runJob()
      expect(await statusOf(doseId)).toBe('missed')

      await setGrace('12')
      const later = await dose(8 * 60 + 1)
      await runJob()

      expect(await statusOf(doseId)).toBe('missed')
      // The new value does apply: eight hours is within twelve.
      expect(await statusOf(later)).toBe('pending')
    })
  })

  // --- Recorded doses -------------------------------------------------------

  describe('recorded doses', () => {
    it('leaves taken, skipped and missed doses exactly as they are', async () => {
      await setGrace('2')
      const recorded = [
        await dose(10 * 60, 'taken'),
        await dose(11 * 60, 'skipped'),
        await dose(12 * 60, 'missed'),
      ]
      const before = await Promise.all(recorded.map(row))
      const open = await dose(10 * 60 + 30)

      expect(await runJob()).toBe(1)

      expect(await Promise.all(recorded.map(row))).toEqual(before)
      expect(await statusOf(open)).toBe('missed')
    })
  })

  // --- End of a course ------------------------------------------------------

  describe('a course that has ended', () => {
    it('writes off nothing dated after its end date, whatever the setting', async () => {
      // Ended two days ago by the doctor, as "End medication" does it.
      const ended = await database.asUser(
        fx.doctorAUserId,
        `update public.medication_schedule
            set medication_schedule_end_date = public.app_today() - 2
          where medication_schedule_id = $1
          returning 1`,
        [scheduleId],
      )
      expect(ended).toHaveLength(1)

      const at = async (day: number, time: string) => {
        const [created] = await database.asService<{ id: string }>(
          `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
           values ($1, ((public.app_today() + $2::int) + $3::time) at time zone $4)
           on conflict (medication_schedule_id, medication_log_scheduled_at)
             do update set medication_log_status = 'pending'
           returning medication_log_id as id`,
          [scheduleId, day, time, ZONE],
        )
        return created!.id
      }
      // Inside the course, and after it: both at least a day overdue.
      const inside = await at(-3, '08:00')
      const after = await at(-1, '00:00')

      for (const hours of ['2', '24']) {
        await setGrace(hours)
        await runJob()
        expect(await statusOf(after)).toBe('pending')
      }
      expect(await statusOf(inside)).toBe('missed')
    })
  })

  // --- Reminders ------------------------------------------------------------

  describe('reminders', () => {
    it('are chased on the same 30-minute rule at settings of 2, 6 and 12', async () => {
      const late = [29, 30, 31, 119, 121, 361, 721]
      const expected = { 29: false, 30: true, 31: true, 119: true, 121: true, 361: true, 721: true }

      for (const hours of ['2', '6', '12']) {
        await setGrace(hours)
        const doses = await run(jobs.reminders, late)
        const chased = Object.fromEntries([...doses].map(([minutes, d]) => [minutes, d.chased]))
        expect(chased, `setting ${hours}`).toEqual(expected)
        // Chasing records nothing as missed.
        expect([...doses.values()].every((d) => d.status === 'pending')).toBe(true)
      }
      expect(jobs.reminders).toBe('select public.dispatch_medication_reminders(30)')
    })
  })

  // --- Unusable settings ----------------------------------------------------

  describe('a setting that cannot be used', () => {
    it.each([
      '0',
      '-1',
      '1.5',
      'abc',
      '',
      '   ',
      '25',
      '100000',
      '2147483647',
      '2147483648',
      '٦', // Arabic-Indic six
      '６', // full-width six
      '+6',
      '6 hours',
    ])('%j falls back to six hours, without an error', async (stored) => {
      await setGrace(stored)
      expect(await overdue([1, ...around(6)])).toEqual({ 1: 'pending', ...openThenMissed(6) })
    })
  })

  // --- An explicit argument -------------------------------------------------

  describe('an explicit argument', () => {
    const call = (hours: number | null) =>
      `select public.mark_overdue_medication_logs(${hours === null ? '' : hours})`

    it('decides when no setting is stored, and is not clamped to 1–24', async () => {
      expect(await overdue([1], call(0))).toEqual({ 1: 'missed' })
      expect(await overdue(around(2), call(2))).toEqual(openThenMissed(2))
      expect(await overdue(around(12), call(12))).toEqual(openThenMissed(12))
      expect(await overdue(around(30), call(30))).toEqual(openThenMissed(30))
    })

    it('decides when the stored setting cannot be used', async () => {
      await setGrace('abc')
      expect(await overdue([1], call(0))).toEqual({ 1: 'missed' })
      expect(await overdue(around(12), call(12))).toEqual(openThenMissed(12))
    })

    it('gives way to a usable setting', async () => {
      await setGrace('2')
      expect(await overdue([1, 121], call(0))).toEqual({ 1: 'pending', 121: 'missed' })
    })

    it('still defaults to six hours', async () => {
      expect(await overdue(around(6), call(null))).toEqual(openThenMissed(6))
    })
  })

  // --- Security -------------------------------------------------------------

  describe('security', () => {
    it('keeps the function’s signature and elevated, fixed-path definition', async () => {
      const [fn] = await database.asService<{
        args: string
        definer: boolean
        config: string[]
        owner: string
        runner: string
        overloads: number
      }>(
        `select pg_get_function_arguments(p.oid) as args,
                p.prosecdef as definer,
                p.proconfig as config,
                pg_get_userbyid(p.proowner) as owner,
                current_user as runner,
                (select count(*)::int from pg_proc q
                  where q.pronamespace = p.pronamespace and q.proname = p.proname) as overloads
           from pg_proc p
          where p.oid = 'public.mark_overdue_medication_logs(integer)'::regprocedure`,
      )
      expect(fn).toMatchObject({
        args: 'grace_hours integer DEFAULT 6',
        definer: true,
        config: ['search_path=""'],
        overloads: 1,
      })
      // Owned by the role that runs the migrations, as before.
      expect(fn!.owner).toBe(fn!.runner)
    })

    it('can be run by the service role only', async () => {
      const [grants] = await database.asService<Record<string, boolean>>(
        `select has_function_privilege('service_role', f, 'execute') as service_role,
                has_function_privilege('authenticated', f, 'execute') as authenticated,
                has_function_privilege('anon', f, 'execute') as anon,
                exists (select 1 from aclexplode((select proacl from pg_proc where oid = f::regprocedure))
                         where grantee = 0) as public
           from (values ('public.mark_overdue_medication_logs(integer)')) v(f)`,
      )
      expect(grants).toEqual({ service_role: true, authenticated: false, anon: false, public: false })
    })

    it.each([
      ['a patient', () => fx.aliceUserId],
      ['a doctor', () => fx.doctorAUserId],
      ['the administrator', () => fx.adminUserId],
    ])('refuses the overdue job to %s', async (_who, userId) => {
      await expectDenied(() =>
        database.asUser(userId(), 'select public.mark_overdue_medication_logs(2)'),
      )
    })

    it('refuses the overdue job to an anonymous caller', async () => {
      await expectDenied(() => database.asAnon('select public.mark_overdue_medication_logs(2)'))
    })

    it('lets the administrator read and change the setting', async () => {
      await setGrace('6')
      const read = await database.asUser(
        fx.adminUserId,
        'select system_setting_value from public.system_setting where system_setting_key = $1',
        [KEY],
      )
      expect(read).toEqual([{ system_setting_value: '6' }])
      await setGrace('2')
    })

    it.each([
      ['a patient', () => fx.aliceUserId],
      ['a doctor', () => fx.doctorAUserId],
    ])('keeps the setting from %s', async (_who, userId) => {
      await setGrace('6')
      const as = (sql: string) => database.asUser(userId(), sql, [KEY])

      expect(
        await as('select system_setting_value from public.system_setting where system_setting_key = $1'),
      ).toEqual([])
      await expectDenied(() =>
        as(`update public.system_setting set system_setting_value = '2'
             where system_setting_key = $1 returning 1`),
      )
      await expectDenied(() =>
        as(`insert into public.system_setting (system_setting_key, system_setting_value)
            values ($1, '2')
            on conflict (system_setting_key) do update
              set system_setting_value = excluded.system_setting_value
            returning 1`),
      )
      await expectDenied(() =>
        as('delete from public.system_setting where system_setting_key = $1 returning 1'),
      )
      expect(await overdue(around(6))).toEqual(openThenMissed(6))
    })

    it('keeps the setting from an anonymous caller', async () => {
      await setGrace('6')
      await expectDenied(() =>
        database.asAnon(
          `update public.system_setting set system_setting_value = '2'
            where system_setting_key = $1 returning 1`,
          [KEY],
        ),
      )
      await expectDenied(() =>
        database.asAnon(
          `insert into public.system_setting (system_setting_key, system_setting_value)
           values ($1, '2') returning 1`,
          [KEY],
        ),
      )
      const [stored] = await database.asService<{ v: string }>(
        'select system_setting_value as v from public.system_setting where system_setting_key = $1',
        [KEY],
      )
      expect(stored!.v).toBe('6')
    })
  })
})
