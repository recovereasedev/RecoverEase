import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, createSignIn } from './helpers/super-admin'

/**
 * Migration 48: a dose's identity (schedule, clinic-local date, wall-clock
 * time), and the occurrences held for the treating doctor as conflicts.
 *
 * The clock-change dates are in 2030, so the tests do not depend on the day
 * they run: New York springs forward on 10 March 2030 (02:00 -> 03:00) and
 * falls back on 3 November 2030 (02:00 -> 01:00); Lord Howe Island springs
 * forward half an hour on 6 October 2030 (02:00 -> 02:30) and falls back half
 * an hour on 7 April 2030 (02:00 -> 01:30).
 *
 * Holding a dose time for review is the provisional default while the
 * clinical adviser's decisions are PENDING
 * (docs/medication-clock-change-decisions.md); these tests pin that default.
 */

const MIGRATION_48 = 'supabase/migrations/20260902100048_medication_dose_identity.sql'
const ROLLBACK_48 = 'supabase/rollbacks/20260902100048_medication_dose_identity.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

type Dose = { date: string; time: string; at: string; status: string }
type Conflict = { date: string; time: string; reason: string; at: string; resolution: string | null }

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

const setZone = (database: TestDatabase, zone: string) =>
  database.asService('update public.clinic set clinic_timezone = $1', [zone])

/** A schedule of Alice's, from Doctor A, created as the website creates one. */
async function schedule(
  database: TestDatabase,
  fx: Fixture,
  times: string[],
  start: string,
  end: string | null = null,
): Promise<string> {
  const prescription = await one<string>(
    database,
    `insert into public.prescription (pat_id, doc_id, prescription_notes)
     values ($1, $2, 'Test') returning prescription_id`,
    [fx.alicePatId, fx.doctorAId],
  )
  return one<string>(
    database,
    `insert into public.medication_schedule
       (prescription_id, medication_schedule_name, medication_schedule_dosage,
        medication_schedule_frequency, medication_schedule_times,
        medication_schedule_start_date, medication_schedule_end_date)
     values ($1, 'Medicine X', '1 tablet', $2, $3::time[], $4::date, $5::date)
     returning medication_schedule_id`,
    [prescription, times.length, `{${times.join(',')}}`, start, end],
  )
}

/** Runs the generator exactly as far ahead as `through`, in the clinic's own "today". */
const generateThrough = (database: TestDatabase, scheduleId: string, through: string) =>
  one<number>(
    database,
    `select public.generate_medication_log_slots($1, $2::date - (now() at time zone
       app_private.clinic_timezone(app_private.clinic_of_patient(
         app_private.patient_of_medication_schedule($1))))::date)`,
    [scheduleId, through],
  )

const doses = (database: TestDatabase, scheduleId: string) =>
  database.asService<Dose>(
    `select medication_log_dose_date::text as date, to_char(medication_log_dose_time, 'HH24:MI') as time,
            to_char(medication_log_scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at,
            medication_log_status::text as status
       from public.medication_log where medication_schedule_id = $1
      order by medication_log_scheduled_at, medication_log_dose_time`,
    [scheduleId],
  )

const conflicts = (database: TestDatabase, scheduleId: string) =>
  database.asService<Conflict>(
    `select conflict_dose_date::text as date, to_char(conflict_dose_time, 'HH24:MI') as time,
            conflict_reason::text as reason,
            to_char(conflict_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at,
            conflict_resolution::text as resolution
       from public.medication_dose_conflict where medication_schedule_id = $1
      order by conflict_dose_date, conflict_dose_time`,
    [scheduleId],
  )

/** Every existing dose column a migration or a time zone change must never touch. */
const doseFingerprint = (database: TestDatabase, where = 'true') =>
  one<string>(
    database,
    `select coalesce(md5(string_agg(
       concat_ws('|', medication_log_id, medication_schedule_id, medication_log_scheduled_at,
                 medication_log_status, medication_log_taken_at,
                 medication_log_follow_up_sent_at, medication_log_pre_dose_sent_at),
       ',' order by medication_log_id)), '')
       from public.medication_log where ${where}`,
  )

/** Each occurrence of a schedule appears once, as a dose or a conflict, and no two doses share a moment. */
async function expectOccurrencesOnce(database: TestDatabase, scheduleId: string) {
  const [counts] = await database.asService<{ repeated: number; shared: number; both: number }>(
    `select
       (select count(*)::int from (
          select medication_log_dose_date, medication_log_dose_time from public.medication_log
           where medication_schedule_id = $1 group by 1, 2 having count(*) > 1) x) as repeated,
       (select count(*)::int from (
          select medication_log_scheduled_at from public.medication_log
           where medication_schedule_id = $1 group by 1 having count(*) > 1) x) as shared,
       (select count(*)::int from public.medication_dose_conflict mc
          join public.medication_log ml
            on ml.medication_schedule_id = mc.medication_schedule_id
           and ml.medication_log_dose_date = mc.conflict_dose_date
           and ml.medication_log_dose_time = mc.conflict_dose_time
         where mc.medication_schedule_id = $1 and mc.conflict_resolution is distinct from 'rescheduled') as both`,
    [scheduleId],
  )
  expect(counts).toEqual({ repeated: 0, shared: 0, both: 0 })
}

// ---------------------------------------------------------------------------

describe('a dose’s identity', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    // Doses made before migration 48, then 48 applied over them.
    database = await createTestDatabase({ stopAfter: '20260902100047' })
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('is given to every existing dose from its moment in its clinic’s time zone, changing nothing else', async () => {
    const before = await doseFingerprint(database)
    const count = await one<number>(database, 'select count(*)::int from public.medication_log')
    expect(count).toBeGreaterThan(0)

    await database.applyMigration('20260902100048')

    expect(await doseFingerprint(database)).toBe(before)
    expect(
      await one<number>(
        database,
        `select count(*)::int from public.medication_log
          where medication_log_dose_date = (medication_log_scheduled_at at time zone 'Asia/Manila')::date
            and medication_log_dose_time = (medication_log_scheduled_at at time zone 'Asia/Manila')::time`,
      ),
    ).toBe(count)
    expect(
      await database.asService(
        `select column_name, is_nullable from information_schema.columns
          where table_name = 'medication_log' and column_name like 'medication_log_dose_%' order by 1`,
      ),
    ).toEqual([
      { column_name: 'medication_log_dose_date', is_nullable: 'NO' },
      { column_name: 'medication_log_dose_time', is_nullable: 'NO' },
    ])
  })

  it('never changes, for anyone', async () => {
    const id = await one<string>(
      database,
      'select medication_log_id from public.medication_log where medication_schedule_id = $1 limit 1',
      [fx.aliceScheduleId],
    )
    await expect(
      database.asService(
        `update public.medication_log set medication_log_dose_time = '09:00' where medication_log_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      database.asService(
        `update public.medication_log set medication_log_dose_date = medication_log_dose_date + 1 where medication_log_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      database.asUser(
        fx.aliceUserId,
        `update public.medication_log set medication_log_dose_time = '09:00' where medication_log_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('is unique within a schedule, and filled in when a direct insert leaves it out', async () => {
    const [first] = await database.asService<{ d: string; t: string }>(
      `select medication_log_dose_date::text as d, medication_log_dose_time::text as t
         from public.medication_log where medication_schedule_id = $1 limit 1`,
      [fx.aliceScheduleId],
    )
    await expect(
      database.asService(
        `insert into public.medication_log
           (medication_schedule_id, medication_log_scheduled_at, medication_log_dose_date, medication_log_dose_time)
         values ($1, now() + interval '400 days', $2::date, $3::time)`,
        [fx.aliceScheduleId, first!.d, first!.t],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    const [filled] = await database.asService<{ d: string; t: string }>(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, '2031-01-02 01:15:00+00')
       returning medication_log_dose_date::text as d, to_char(medication_log_dose_time, 'HH24:MI') as t`,
      [fx.aliceScheduleId],
    )
    expect(filled).toEqual({ d: '2031-01-02', t: '09:15' })
  })
})

// ---------------------------------------------------------------------------

describe('a clinic’s time zone changing', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('Manila to UTC: existing doses keep every value, nothing is added twice, and later days follow UTC', async () => {
    await setZone(database, 'Asia/Manila')
    const id = await schedule(database, fx, ['08:00', '20:00'], '2030-01-01')
    await generateThrough(database, id, '2030-01-10')
    const before = await doseFingerprint(database, `medication_schedule_id = '${id}'`)
    const existing = (await doses(database, id)).length
    expect(existing).toBe(20)

    await setZone(database, 'UTC')
    for (let run = 0; run < 3; run += 1) {
      await generateThrough(database, id, '2030-01-10')
      await database.asService('select public.extend_all_medication_log_slots(30)')
    }
    expect(await doseFingerprint(database, `medication_schedule_id = '${id}'`)).toBe(before)
    expect(await doses(database, id)).toHaveLength(existing)
    expect(await conflicts(database, id)).toEqual([])

    await generateThrough(database, id, '2030-01-12')
    const later = (await doses(database, id)).filter((dose) => dose.date >= '2030-01-11')
    expect(later.map((dose) => dose.at)).toEqual([
      '2030-01-11 08:00',
      '2030-01-11 20:00',
      '2030-01-12 08:00',
      '2030-01-12 20:00',
    ])
    expect(await doseFingerprint(database, `medication_schedule_id = '${id}' and medication_log_dose_date <= '2030-01-10'`)).toBe(before)
    await expectOccurrencesOnce(database, id)
  })

  it('Manila to Los Angeles: no doses are added twice, and later days follow Los Angeles', async () => {
    await setZone(database, 'Asia/Manila')
    const id = await schedule(database, fx, ['08:00', '20:00'], '2030-01-01')
    await generateThrough(database, id, '2030-01-10')
    const before = await doseFingerprint(database, `medication_schedule_id = '${id}'`)

    await setZone(database, 'America/Los_Angeles')
    for (let run = 0; run < 3; run += 1) await generateThrough(database, id, '2030-01-11')

    expect(await doseFingerprint(database, `medication_schedule_id = '${id}' and medication_log_dose_date <= '2030-01-10'`)).toBe(before)
    // 08:00 and 20:00 in Los Angeles (UTC-8 in January).
    expect((await doses(database, id)).filter((dose) => dose.date === '2030-01-11').map((dose) => dose.at)).toEqual([
      '2030-01-11 16:00',
      '2030-01-12 04:00',
    ])
    expect(await conflicts(database, id)).toEqual([])
    await expectOccurrencesOnce(database, id)
  })

  it('Los Angeles to Manila: a new day’s dose at an existing dose’s moment is held, and the existing dose kept', async () => {
    await setZone(database, 'America/Los_Angeles')
    const id = await schedule(database, fx, ['12:00', '20:00'], '2030-01-01')
    await generateThrough(database, id, '2030-01-10')
    const before = await doseFingerprint(database, `medication_schedule_id = '${id}'`)
    // 10 January 20:00 in Los Angeles is 11 January 04:00 UTC...
    const lastLa = await one<string>(
      database,
      `select medication_log_id from public.medication_log
        where medication_schedule_id = $1 and medication_log_dose_date = '2030-01-10' and medication_log_dose_time = '20:00'`,
      [id],
    )

    await setZone(database, 'Asia/Manila')
    for (let run = 0; run < 3; run += 1) await generateThrough(database, id, '2030-01-11')

    // ...which is 11 January 12:00 in Manila: held, not added beside it.
    expect(await conflicts(database, id)).toEqual([
      { date: '2030-01-11', time: '12:00', reason: 'same_moment_collision', at: '2030-01-11 04:00', resolution: null },
    ])
    expect(
      await one<string>(
        database,
        `select conflicting_log_id::text from public.medication_dose_conflict where medication_schedule_id = $1`,
        [id],
      ),
    ).toBe(lastLa)
    expect((await doses(database, id)).filter((dose) => dose.date === '2030-01-11').map((dose) => dose.at)).toEqual([
      '2030-01-11 12:00',
    ])
    expect(await doseFingerprint(database, `medication_schedule_id = '${id}' and medication_log_dose_date <= '2030-01-10'`)).toBe(before)
    await expectOccurrencesOnce(database, id)
  })

  it('several changes in a row: every occurrence still appears once, and no existing dose changes', async () => {
    await setZone(database, 'Asia/Manila')
    const id = await schedule(database, fx, ['06:00', '14:00', '22:00'], '2030-02-01')
    await generateThrough(database, id, '2030-02-05')
    const zones = ['UTC', 'America/Los_Angeles', 'Asia/Manila', 'America/New_York', 'Asia/Tokyo']
    let through = 5
    for (const zone of zones) {
      const settled = await doseFingerprint(database, `medication_schedule_id = '${id}'`)
      const settledCount = (await doses(database, id)).length
      await setZone(database, zone)
      through += 1
      for (let run = 0; run < 2; run += 1) {
        await generateThrough(database, id, `2030-02-${String(through).padStart(2, '0')}`)
      }
      // Every dose that existed before this change is exactly as it was.
      const kept = await database.asService<{ n: number }>(
        `select count(*)::int as n from public.medication_log where medication_schedule_id = $1`,
        [id],
      )
      expect(kept[0]!.n).toBeGreaterThanOrEqual(settledCount)
      expect(
        await doseFingerprint(
          database,
          `medication_schedule_id = '${id}' and medication_log_dose_date < '2030-02-${String(through).padStart(2, '0')}'`,
        ),
      ).toBe(settled)
      await expectOccurrencesOnce(database, id)
    }
    // Each day's three occurrences: a dose or a conflict, once each.
    const total = (await doses(database, id)).length + (await conflicts(database, id)).length
    expect(total).toBe(through * 3)
  })
})

// ---------------------------------------------------------------------------

describe('clock-change days', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('New York, springing forward on 10 March 2030 (02:00 -> 03:00)', () => {
    beforeAll(() => setZone(database, 'America/New_York'))

    it('holds a dose time that does not exist for review, and creates no dose for it', async () => {
      const id = await schedule(database, fx, ['02:30'], '2030-03-10', '2030-03-10')
      await generateThrough(database, id, '2030-03-10')
      expect(await doses(database, id)).toEqual([])
      expect(await conflicts(database, id)).toEqual([
        { date: '2030-03-10', time: '02:30', reason: 'nonexistent_local_time', at: '2030-03-10 07:30', resolution: null },
      ])
    })

    it('keeps 03:30 as the dose and holds 02:30, whichever order the times are listed in', async () => {
      for (const times of [['02:30', '03:30'], ['03:30', '02:30']]) {
        const id = await schedule(database, fx, times, '2030-03-10', '2030-03-10')
        await generateThrough(database, id, '2030-03-10')
        expect(await doses(database, id)).toEqual([
          { date: '2030-03-10', time: '03:30', at: '2030-03-10 07:30', status: 'pending' },
        ])
        expect(await conflicts(database, id)).toEqual([
          { date: '2030-03-10', time: '02:30', reason: 'nonexistent_local_time', at: '2030-03-10 07:30', resolution: null },
        ])
        await expectOccurrencesOnce(database, id)
      }
    })

    it('schedules the times either side of the jump normally', async () => {
      const id = await schedule(database, fx, ['01:30', '02:30', '04:00'], '2030-03-10', '2030-03-10')
      await generateThrough(database, id, '2030-03-10')
      expect((await doses(database, id)).map((dose) => [dose.time, dose.at])).toEqual([
        ['01:30', '2030-03-10 06:30'],
        ['04:00', '2030-03-10 08:00'],
      ])
      expect((await conflicts(database, id)).map((c) => c.time)).toEqual(['02:30'])
    })

    it('changes nothing when the scheduler runs again', async () => {
      const id = await schedule(database, fx, ['02:30', '03:30'], '2030-03-09', '2030-03-11')
      await generateThrough(database, id, '2030-03-11')
      const first = { doses: await doses(database, id), conflicts: await conflicts(database, id) }
      for (let run = 0; run < 3; run += 1) {
        await generateThrough(database, id, '2030-03-11')
        await database.asService('select public.extend_all_medication_log_slots(30)')
      }
      expect({ doses: await doses(database, id), conflicts: await conflicts(database, id) }).toEqual(first)
      expect(first.doses).toHaveLength(5)
      expect(first.conflicts).toHaveLength(1)
    })
  })

  describe('New York, falling back on 3 November 2030 (02:00 -> 01:00)', () => {
    beforeAll(() => setZone(database, 'America/New_York'))

    it('holds a dose time that happens twice for review, and schedules the times around it', async () => {
      const id = await schedule(database, fx, ['00:30', '01:30', '02:30'], '2030-11-03', '2030-11-03')
      for (let run = 0; run < 3; run += 1) await generateThrough(database, id, '2030-11-03')
      expect((await doses(database, id)).map((dose) => [dose.time, dose.at])).toEqual([
        ['00:30', '2030-11-03 04:30'],
        ['02:30', '2030-11-03 07:30'],
      ])
      // PostgreSQL alone would put it at the second 01:30 (06:30 UTC).
      expect(await conflicts(database, id)).toEqual([
        { date: '2030-11-03', time: '01:30', reason: 'ambiguous_local_time', at: '2030-11-03 06:30', resolution: null },
      ])
    })
  })

  describe('Lord Howe Island, half-hour changes', () => {
    beforeAll(() => setZone(database, 'Australia/Lord_Howe'))

    it('holds 02:00 and 02:15 when clocks jump from 02:00 to 02:30, and keeps 02:30', async () => {
      const id = await schedule(database, fx, ['02:00', '02:15', '02:30'], '2030-10-06', '2030-10-06')
      await generateThrough(database, id, '2030-10-06')
      expect((await doses(database, id)).map((dose) => dose.time)).toEqual(['02:30'])
      expect((await conflicts(database, id)).map((c) => [c.time, c.reason])).toEqual([
        ['02:00', 'nonexistent_local_time'],
        ['02:15', 'nonexistent_local_time'],
      ])
    })

    it('holds 01:45 when clocks go back from 02:00 to 01:30', async () => {
      const id = await schedule(database, fx, ['01:15', '01:45', '02:15'], '2030-04-07', '2030-04-07')
      await generateThrough(database, id, '2030-04-07')
      expect((await doses(database, id)).map((dose) => dose.time)).toEqual(['01:15', '02:15'])
      expect((await conflicts(database, id)).map((c) => [c.time, c.reason])).toEqual([['01:45', 'ambiguous_local_time']])
    })
  })

  it('treats an ordinary day in a zone without daylight saving as ordinary', async () => {
    await setZone(database, 'Asia/Manila')
    const id = await schedule(database, fx, ['00:00', '02:30', '23:59'], '2030-03-10', '2030-03-10')
    await generateThrough(database, id, '2030-03-10')
    expect(await doses(database, id)).toHaveLength(3)
    expect(await conflicts(database, id)).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('the treating doctor resolving a conflict', () => {
  let database: TestDatabase
  let fx: Fixture
  let springId: string
  let fallId: string

  const conflictId = (scheduleId: string, time: string) =>
    one<string>(
      database,
      `select medication_dose_conflict_id::text from public.medication_dose_conflict
        where medication_schedule_id = $1 and conflict_dose_time = $2::time`,
      [scheduleId, time],
    )

  const resolve = (userId: string, id: string, resolution: string, at: string | null, note: string | null) =>
    database.asUser(
      userId,
      'select * from public.doctor_resolve_medication_conflict($1, $2, $3::timestamptz, $4)',
      [id, resolution, at, note],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await setZone(database, 'America/New_York')
    springId = await schedule(database, fx, ['02:30', '03:30'], '2030-03-10', '2030-03-10')
    await generateThrough(database, springId, '2030-03-10')
    fallId = await schedule(database, fx, ['01:30'], '2030-11-03', '2030-11-03')
    await generateThrough(database, fallId, '2030-11-03')
  })

  afterAll(async () => {
    await database?.close()
  })

  it('refuses everyone but the patient’s own active treating doctor, revealing nothing', async () => {
    const id = await conflictId(springId, '02:30')
    const call = [id, 'not_given_separately', null, 'Reason']
    const sql = 'select * from public.doctor_resolve_medication_conflict($1, $2, $3::timestamptz, $4)'
    await expect(database.asAnon(sql, call)).rejects.toMatchObject({ code: '42501' })
    await expect(database.asUser(fx.aliceUserId, sql, call)).rejects.toMatchObject({ code: '42501' })
    await expect(database.asUser(fx.adminUserId, sql, call)).rejects.toMatchObject({ code: '42501' })
    // Another doctor: told it does not exist, as for an id that does not.
    await expect(database.asUser(fx.doctorBUserId, sql, call)).rejects.toMatchObject({ code: 'P0002' })
    await expect(
      database.asUser(fx.doctorAUserId, sql, ['00000000-0000-4000-8000-0000000000c9', 'not_given_separately', null, 'Reason']),
    ).rejects.toMatchObject({ code: 'P0002' })

    await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = false where doc_id = $1', [fx.doctorAId])
    try {
      await expect(database.asUser(fx.doctorAUserId, sql, call)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = true where doc_id = $1', [fx.doctorAId])
    }
    expect((await conflicts(database, springId))[0]!.resolution).toBeNull()
  })

  it('requires a reason, and an answer it understands', async () => {
    const id = await conflictId(springId, '02:30')
    await expect(resolve(fx.doctorAUserId, id, 'not_given_separately', null, null)).rejects.toMatchObject({ code: '23514' })
    await expect(resolve(fx.doctorAUserId, id, 'not_given_separately', null, '   ')).rejects.toMatchObject({ code: '23514' })
    await expect(resolve(fx.doctorAUserId, id, 'not_given_separately', null, 'x'.repeat(1001))).rejects.toMatchObject({
      code: '23514',
    })
    await expect(resolve(fx.doctorAUserId, id, 'take_both', null, 'Reason')).rejects.toMatchObject({ code: '22023' })
    await expect(
      resolve(fx.doctorAUserId, id, 'not_given_separately', '2030-03-10 08:00+00', 'Reason'),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('accepts only a future moment on the same clinic-local date, at no other dose’s moment', async () => {
    const id = await conflictId(springId, '02:30')
    const refused = async (at: string | null, code: string) =>
      expect(resolve(fx.doctorAUserId, id, 'rescheduled', at, 'Reason')).rejects.toMatchObject({ code })
    await refused(null, '23514')
    // 11 March in New York.
    await refused('2030-03-11 06:00+00', '23514')
    // 9 March in New York (10 March in UTC).
    await refused('2030-03-10 04:00+00', '23514')
    // The 03:30 dose's own moment.
    await refused('2030-03-10 07:30+00', '23505')
    expect((await conflicts(database, springId))[0]!.resolution).toBeNull()

    // A conflict whose date has passed cannot be given a time.
    const past = await one<string>(
      database,
      `insert into public.medication_dose_conflict
         (medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at)
       values ($1, (now() at time zone 'America/New_York')::date - 1, '02:30', 'nonexistent_local_time', now() - interval '1 day')
       returning medication_dose_conflict_id::text`,
      [springId],
    )
    await expect(
      resolve(fx.doctorAUserId, past, 'rescheduled', new Date(Date.now() - 3600_000).toISOString(), 'Reason'),
    ).rejects.toMatchObject({ code: '23514' })
    await database.asService('delete from public.medication_dose_conflict where medication_dose_conflict_id = $1', [past])
  })

  it('turns a chosen time into one ordinary dose, records who decided and why, and is final', async () => {
    const id = await conflictId(springId, '02:30')
    const [resolved] = await resolve(fx.doctorAUserId, id, 'rescheduled', '2030-03-10 08:15+00', '  Given after the morning dose  ')
    expect(resolved).toMatchObject({
      conflict_resolution: 'rescheduled',
      resolved_by_doc_id: fx.doctorAId,
      conflict_resolution_note: 'Given after the morning dose',
    })
    expect(resolved!['conflict_resolved_at']).not.toBeNull()
    expect(await doses(database, springId)).toEqual([
      { date: '2030-03-10', time: '03:30', at: '2030-03-10 07:30', status: 'pending' },
      { date: '2030-03-10', time: '02:30', at: '2030-03-10 08:15', status: 'pending' },
    ])
    expect(
      await one<string>(database, 'select resolved_log_id::text from public.medication_dose_conflict where medication_dose_conflict_id = $1', [id]),
    ).toBe(
      await one<string>(
        database,
        `select medication_log_id::text from public.medication_log where medication_schedule_id = $1 and medication_log_dose_time = '02:30'`,
        [springId],
      ),
    )

    await expect(resolve(fx.doctorAUserId, id, 'not_given_separately', null, 'Again')).rejects.toMatchObject({ code: '55000' })
    // The scheduler leaves a resolved occurrence alone.
    for (let run = 0; run < 2; run += 1) await generateThrough(database, springId, '2030-03-10')
    expect(await doses(database, springId)).toHaveLength(2)
  })

  it('accepts either 01:30 of a fall-back day, or records no separate dose with no dose created', async () => {
    const id = await conflictId(fallId, '01:30')
    // The first 01:30 (05:30 UTC, before the clocks go back) is on 3 November too.
    await resolve(fx.doctorAUserId, id, 'rescheduled', '2030-11-03 05:30+00', 'First 01:30')
    expect((await conflicts(database, fallId))[0]!.resolution).toBe('rescheduled')
    expect((await doses(database, fallId)).map((dose) => dose.at)).toEqual(['2030-11-03 05:30'])

    const other = await schedule(database, fx, ['01:30'], '2030-11-03', '2030-11-03')
    await generateThrough(database, other, '2030-11-03')
    const second = await conflictId(other, '01:30')
    await resolve(fx.doctorAUserId, second, 'rescheduled', '2030-11-03 06:30+00', 'Second 01:30')
    expect((await doses(database, other)).map((dose) => dose.at)).toEqual(['2030-11-03 06:30'])

    const third = await schedule(database, fx, ['01:30'], '2030-11-03', '2030-11-03')
    await generateThrough(database, third, '2030-11-03')
    const none = await conflictId(third, '01:30')
    const [decided] = await resolve(fx.doctorAUserId, none, 'not_given_separately', null, 'One dose that night')
    expect(decided).toMatchObject({ conflict_resolution: 'not_given_separately', resolved_log_id: null })
    expect(await doses(database, third)).toEqual([])
  })

  it('is audited as a clinical entry of the patient’s clinic, without the doctor’s words', async () => {
    const entries = await database.asService<{ action: string; scope: string; clinic: string | null; details: string }>(
      `select audit_log_action as action, audit_scope::text as scope, clinic_id::text as clinic,
              audit_log_details::text as details
         from public.audit_log where audit_log_entity = 'medication_dose_conflict'`,
    )
    const clinic = await one<string>(database, 'select clinic_id::text from public.clinic limit 1')
    expect(entries.length).toBeGreaterThan(0)
    expect(new Set(entries.map((entry) => entry.scope))).toEqual(new Set(['clinical']))
    expect(new Set(entries.map((entry) => entry.clinic))).toEqual(new Set([clinic]))
    expect(entries.some((entry) => entry.action === 'update' && entry.details.includes('conflict_resolution_note'))).toBe(true)
    for (const entry of entries) {
      expect(entry.details).not.toContain('Given after the morning dose')
      expect(entry.details).not.toContain('One dose that night')
    }
  })
})

// ---------------------------------------------------------------------------

describe('who sees conflicts', () => {
  let database: TestDatabase
  let fx: Fixture
  let otherClinicAdmin: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await setZone(database, 'America/New_York')
    const id = await schedule(database, fx, ['02:30'], '2030-03-10', '2030-03-10')
    await generateThrough(database, id, '2030-03-10')

    const superAdmin = await assuredSuperAdmin(database)
    const [alder] = await database.asClaims<{ clinic_id: string }>(
      superAdmin.claims,
      `select clinic_id from public.super_admin_create_clinic('Alder Clinic', 'Asia/Manila')`,
    )
    otherClinicAdmin = await createSignIn(database, 'zoe.admin@alder.test', {
      provisioned_as: 'clinic_admin',
      provisioned_clinic: alder!.clinic_id,
    })
    await database.asClaims(superAdmin.claims, `select public.super_admin_attach_clinic_admin($1, $2, 'Zoe', 'Abad')`, [
      otherClinicAdmin,
      alder!.clinic_id,
    ])
  })

  afterAll(async () => {
    await database?.close()
  })

  const visible = (userId: string) =>
    database.asUser<{ n: number }>(userId, 'select count(*)::int as n from public.medication_dose_conflict')

  it('shows a conflict to the patient and their treating doctor, exactly as their doses are shown, and nobody else', async () => {
    expect(await visible(fx.aliceUserId)).toEqual([{ n: 1 }])
    expect(await visible(fx.doctorAUserId)).toEqual([{ n: 1 }])
    // The Clinic Admin reads no patient's doses, and no conflicts either.
    expect(await visible(fx.adminUserId)).toEqual([{ n: 0 }])
    expect(
      await database.asUser<{ n: number }>(fx.adminUserId, 'select count(*)::int as n from public.medication_log'),
    ).toEqual([{ n: 0 }])
    expect(await visible(fx.bobUserId)).toEqual([{ n: 0 }])
    expect(await visible(fx.doctorBUserId)).toEqual([{ n: 0 }])
    expect(await visible(otherClinicAdmin)).toEqual([{ n: 0 }])
    await expect(database.asAnon('select count(*) from public.medication_dose_conflict')).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('lets no one write one directly', async () => {
    const id = await one<string>(database, 'select medication_dose_conflict_id::text from public.medication_dose_conflict limit 1')
    for (const userId of [fx.doctorAUserId, fx.aliceUserId, fx.adminUserId]) {
      await expect(
        database.asUser(userId, `update public.medication_dose_conflict set conflict_resolution = 'not_given_separately' where medication_dose_conflict_id = $1`, [id]),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        database.asUser(userId, 'delete from public.medication_dose_conflict where medication_dose_conflict_id = $1', [id]),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        database.asUser(
          userId,
          `insert into public.medication_dose_conflict (medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at)
           select medication_schedule_id, conflict_dose_date + 1, conflict_dose_time, conflict_reason, conflict_at
             from public.medication_dose_conflict limit 1`,
        ),
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('cannot be created twice for the same occurrence', async () => {
    await expect(
      database.asService(
        `insert into public.medication_dose_conflict (medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at)
         select medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at
           from public.medication_dose_conflict limit 1`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

// ---------------------------------------------------------------------------

describe('reminders, missed doses and the doctor’s alerts', () => {
  let database: TestDatabase
  let fx: Fixture
  let scheduleId: string

  const notifications = (userId: string, pattern: string) =>
    one<number>(
      database,
      `select count(*)::int from public.notification where user_id = $1 and notification_message like $2`,
      [userId, pattern],
    )

  /** A conflict held directly, at a moment relative to now, as the generator would hold one. */
  const hold = (time: string, offset: string) =>
    one<string>(
      database,
      `insert into public.medication_dose_conflict
         (medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at)
       values ($1, ((now() + $3::interval) at time zone 'Asia/Manila')::date, $2::time,
               'same_moment_collision', now() + $3::interval)
       returning medication_dose_conflict_id::text`,
      [scheduleId, time, offset],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await database.asService(
      'update public.patient set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null where pat_id = $1',
      [fx.alicePatId],
    )
    // A schedule with no doses of its own, so only the conflicts below count.
    scheduleId = await schedule(database, fx, ['03:17'], '2030-01-01', '2030-01-01')
  })

  afterAll(async () => {
    await database?.close()
  })

  it('never reminds about, or marks missed, an unresolved conflict', async () => {
    const soon = await hold('03:18', '5 minutes')
    const gone = await hold('03:19', '-8 hours')
    for (let run = 0; run < 3; run += 1) {
      await database.asService('select public.dispatch_medication_pre_dose_reminders()')
      await database.asService('select public.dispatch_medication_reminders(30)')
      await database.asService('select public.mark_overdue_medication_logs(6)')
    }
    expect(await notifications(fx.aliceUserId, '%Medicine X%')).toBe(0)
    expect(
      await one<number>(database, 'select count(*)::int from public.medication_log where medication_schedule_id = $1', [scheduleId]),
    ).toBe(0)
    expect(
      await database.asService(
        `select conflict_resolution from public.medication_dose_conflict where medication_dose_conflict_id in ($1, $2)`,
        [soon, gone],
      ),
    ).toEqual([{ conflict_resolution: null }, { conflict_resolution: null }])
    await database.asService('delete from public.medication_dose_conflict where medication_schedule_id = $1', [scheduleId])
  })

  it('gives a rescheduled dose exactly one ordinary reminder before it is due', async () => {
    const id = await hold('03:20', '2 hours')
    const at = await one<string>(database, `select (now() + interval '5 minutes')::text`)
    await database.asUser(
      fx.doctorAUserId,
      `select 1 from public.doctor_resolve_medication_conflict($1, 'rescheduled', $2::timestamptz, 'Reason')`,
      [id, at],
    )
    for (let run = 0; run < 3; run += 1) await database.asService('select public.dispatch_medication_pre_dose_reminders()')
    expect(await notifications(fx.aliceUserId, 'Your Medicine X (1 tablet) is due at%')).toBe(1)
  })

  it('alerts only the treating doctor, once when found and once 24 hours before, however often it runs', async () => {
    const id = await hold('03:21', '20 hours')
    const run = () => database.asService('select public.dispatch_medication_conflict_alerts()')
    for (let i = 0; i < 3; i += 1) await run()
    expect(await notifications(fx.doctorAUserId, '%needs your review because of a clock change.')).toBe(1)
    // Found inside the last 24 hours: no second alert straight after the first.
    expect(await notifications(fx.doctorAUserId, 'Still awaiting your review:%')).toBe(0)

    // As if it had been found three days ago.
    await database.asService(
      `update public.medication_dose_conflict set conflict_doctor_alerted_at = now() - interval '3 days'
        where medication_dose_conflict_id = $1`,
      [id],
    )
    for (let i = 0; i < 3; i += 1) await run()
    expect(await notifications(fx.doctorAUserId, 'Still awaiting your review:%')).toBe(1)
    for (const other of [fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId, fx.aliceUserId]) {
      expect(await notifications(other, '%clock change%')).toBe(0)
    }
  })

  it('sends nothing for a resolved conflict, or while the treating doctor is deactivated', async () => {
    const before = await notifications(fx.doctorAUserId, '%clock change%')
    const resolvedId = await hold('03:22', '30 hours')
    await database.asUser(
      fx.doctorAUserId,
      `select 1 from public.doctor_resolve_medication_conflict($1, 'not_given_separately', null, 'Reason')`,
      [resolvedId],
    )
    await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = false where doc_id = $1', [fx.doctorAId])
    try {
      await hold('03:23', '30 hours')
      await database.asService('select public.dispatch_medication_conflict_alerts()')
      expect(await notifications(fx.doctorAUserId, '%clock change%')).toBe(before)
    } finally {
      await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = true where doc_id = $1', [fx.doctorAId])
    }
  })

  it('judges a course’s end by each dose’s own date', async () => {
    // A dose created in Los Angeles on the course's last day, 23:00 - in
    // Manila, the next day. Still the course's, so it is marked missed.
    const ended = await schedule(database, fx, ['23:00'], '2026-01-01', '2026-01-02')
    await database.asService(
      `insert into public.medication_log
         (medication_schedule_id, medication_log_scheduled_at, medication_log_dose_date, medication_log_dose_time)
       values ($1, '2026-01-02 23:00 America/Los_Angeles', '2026-01-02', '23:00')`,
      [ended],
    )
    await database.asService('select public.mark_overdue_medication_logs(6)')
    expect((await doses(database, ended)).map((dose) => dose.status)).toEqual(['missed'])
  })
})

// ---------------------------------------------------------------------------

describe('a schedule’s shape, and its end', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('refuses a change to its times, frequency, start date or prescription, changing nothing', async () => {
    const id = fx.aliceScheduleId
    const before = await doseFingerprint(database, `medication_schedule_id = '${id}'`)
    const changes = [
      `medication_schedule_times = '{09:00,21:00}'`,
      `medication_schedule_frequency = 1, medication_schedule_times = '{09:00}'`,
      'medication_schedule_start_date = medication_schedule_start_date + 1',
      `prescription_id = (select prescription_id from public.prescription where prescription_id <> ${'medication_schedule.prescription_id'} limit 1)`,
    ]
    await database.asService(
      `insert into public.prescription (pat_id, doc_id, prescription_notes) values ($1, $2, 'Other')`,
      [fx.alicePatId, fx.doctorAId],
    )
    for (const change of changes) {
      await expect(
        database.asUser(fx.doctorAUserId, `update public.medication_schedule set ${change} where medication_schedule_id = $1`, [id]),
        change,
      ).rejects.toMatchObject({ code: '23514' })
    }
    expect(await doseFingerprint(database, `medication_schedule_id = '${id}'`)).toBe(before)
  })

  it('refuses a schedule that lists the same time twice', async () => {
    await expect(schedule(database, fx, ['08:00', '08:00'], '2030-01-01')).rejects.toMatchObject({ code: '23514' })
  })

  it('closes, never deletes, the unresolved conflicts after its end, and keeps the rest', async () => {
    await setZone(database, 'America/New_York')
    const id = await schedule(database, fx, ['02:30'], '2030-03-10')
    await generateThrough(database, id, '2030-03-10')
    // A second held occurrence a day later, and a decided one.
    await database.asService(
      `insert into public.medication_dose_conflict
         (medication_schedule_id, conflict_dose_date, conflict_dose_time, conflict_reason, conflict_at)
       values ($1, '2030-03-12', '02:30', 'nonexistent_local_time', '2030-03-12 06:30+00')`,
      [id],
    )
    await database.asUser(fx.doctorAUserId, 'update public.medication_schedule set medication_schedule_end_date = $2 where medication_schedule_id = $1', [
      id,
      '2030-03-11',
    ])
    expect((await conflicts(database, id)).map((c) => [c.date, c.resolution])).toEqual([
      ['2030-03-10', null],
      ['2030-03-12', 'course_ended'],
    ])
  })
})

// ---------------------------------------------------------------------------

describe('the per-schedule lock', () => {
  let database: TestDatabase
  let fx: Fixture
  let id: string

  beforeAll(async () => {
    database = await createTestDatabase({ preparedTransactions: true })
    fx = await seedFixture(database)
    await setZone(database, 'America/New_York')
    id = await schedule(database, fx, ['02:30', '03:30'], '2030-03-10', '2030-03-10')
  })

  afterAll(async () => {
    await database?.close()
  })

  /** Whether another transaction holds the schedule's lock. */
  const heldElsewhere = async () =>
    !(await one<boolean>(
      database,
      `select pg_try_advisory_xact_lock(hashtextextended('recoverease.medication_schedule:' || $1::text, 0))`,
      [id],
    ))

  /** Runs `sql` in a transaction left open as a prepared one, as an overlapping session would. */
  async function leftOpen(name: string, sql: string, params: unknown[], userId?: string) {
    const db = database.db
    await db.exec('begin')
    try {
      if (userId) {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })])
        await db.exec('set local role authenticated')
      }
      await db.query(sql, params)
    } catch (error) {
      await db.exec('rollback')
      throw error
    }
    await db.exec(`prepare transaction '${name}'`)
  }

  it('is held by the nightly generator and the schedule trigger until they commit, so they cannot interleave', async () => {
    expect(await heldElsewhere()).toBe(false)
    await leftOpen('generate', `select public.generate_medication_log_slots($1, ('2030-03-10'::date - current_date) + 2)`, [id])
    expect(await heldElsewhere()).toBe(true)
    await database.db.exec(`commit prepared 'generate'`)
    expect(await heldElsewhere()).toBe(false)
    expect(await conflicts(database, id)).toHaveLength(1)
  })

  it('is held by a doctor’s resolution until it commits', async () => {
    const conflict = await one<string>(
      database,
      'select medication_dose_conflict_id::text from public.medication_dose_conflict where medication_schedule_id = $1',
      [id],
    )
    await leftOpen(
      'resolve',
      `select 1 from public.doctor_resolve_medication_conflict($1, 'not_given_separately', null, 'Reason')`,
      [conflict],
      fx.doctorAUserId,
    )
    expect(await heldElsewhere()).toBe(true)
    await database.db.exec(`commit prepared 'resolve'`)
    // A second decision, after the first committed, is refused.
    await expect(
      database.asUser(
        fx.doctorAUserId,
        `select 1 from public.doctor_resolve_medication_conflict($1, 'not_given_separately', null, 'Again')`,
        [conflict],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('is held by the end-of-course trigger until it commits', async () => {
    await leftOpen(
      'end',
      `update public.medication_schedule set medication_schedule_end_date = '2030-03-10' where medication_schedule_id = $1`,
      [id],
    )
    expect(await heldElsewhere()).toBe(true)
    await database.db.exec(`commit prepared 'end'`)
  })

  it('is taken on the conflict table by the rollback before it checks the table is empty', async () => {
    // PGlite runs one connection and cannot time out a lock wait, so the race
    // itself (a conflict written between the check and the drop) cannot be
    // staged here. What closes it is the order: an exclusive lock on the
    // table, which the scheduler's and a decision's writes wait for, before
    // the emptiness check, both inside the rollback's one transaction.
    const sql = (await script(ROLLBACK_48)).replace(/--.*$/gm, '')
    const lock = sql.indexOf('lock table public.medication_dose_conflict in exclusive mode')
    const check = sql.indexOf('exists (select 1 from public.medication_dose_conflict)')
    const drop = sql.indexOf('drop table public.medication_dose_conflict')
    expect(lock).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(lock)
    expect(drop).toBeGreaterThan(check)
  })
})

// ---------------------------------------------------------------------------

describe('rolling back migration 48', () => {
  let database: TestDatabase
  let without48: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[database, without48] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: '20260902100047' }),
    ])
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await Promise.all([database?.close(), without48?.close()])
  })

  it('refuses while any conflict exists, changing nothing: a clinical record is never deleted', async () => {
    await setZone(database, 'America/New_York')
    const id = await schedule(database, fx, ['02:30'], '2030-03-10', '2030-03-10')
    await generateThrough(database, id, '2030-03-10')
    const before = await catalog(database)
    await expect(database.db.exec(await script(ROLLBACK_48))).rejects.toThrow(/conflicts exist/)
    expect(await catalog(database)).toEqual(before)
    expect(await conflicts(database, id)).toHaveLength(1)
    // Only to let the next test roll back: the test's own database.
    await database.asService('delete from public.medication_schedule where medication_schedule_id = $1', [id])
    await setZone(database, 'Asia/Manila')
  })

  it('returns the schema to exactly what 47 left, keeping every dose, then refuses a second time', async () => {
    const doseRows = await doseFingerprint(database)
    await database.db.exec(await script(ROLLBACK_48))
    expect(await catalog(database)).toEqual(await catalog(without48))
    expect(await doseFingerprint(database)).toBe(doseRows)

    const before = await catalog(database)
    await expect(database.db.exec(await script(ROLLBACK_48))).rejects.toThrow(/Migration 48 is not applied/)
    expect(await catalog(database)).toEqual(before)
  })

  it('can be applied again after it, identifying every dose again', async () => {
    const doseRows = await doseFingerprint(database)
    await database.db.exec(await script(MIGRATION_48))
    expect(await doseFingerprint(database)).toBe(doseRows)
    expect(
      await one<number>(database, 'select count(*)::int from public.medication_log where medication_log_dose_date is null'),
    ).toBe(0)
    await expect(database.db.exec(await script(MIGRATION_48))).rejects.toThrow(/already been applied/)
  })
})
