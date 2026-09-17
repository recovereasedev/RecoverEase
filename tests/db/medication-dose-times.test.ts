import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { calculateDoseTimes } from '@/features/medications/dose-times'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * A schedule set by frequency and interval (group QA 9/12/26, item 4), through
 * the real schema: the times the form works out are stored exactly as typed
 * times always were, and the existing trigger turns them into doses. No
 * migration was needed, so this also pins that nothing else moved.
 */
describe('a medication schedule worked out from frequency and interval', () => {
  let database: TestDatabase
  let fx: Fixture
  const CLINIC_ZONE = 'Asia/Manila'
  const createdScheduleIds: string[] = []
  let existingBefore: { schedules: string; doses: string }

  const worked = (frequency: string, intervalHours: string, startTime: string): string[] => {
    const result = calculateDoseTimes({ frequency, intervalHours, startTime })
    if (!result.ok) throw new Error(result.message)
    return result.times
  }

  /** The insert `createMedicationSchedule` sends, as the given account. */
  async function insertSchedule(userId: string, times: string[], name = 'Amoxicillin') {
    const rows = await database.asUser<{ id: string }>(
      userId,
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times,
          medication_schedule_start_date, medication_schedule_end_date)
       values ($1, $2, '500 mg', $3, $4::time[], public.app_today(), public.app_today() + 1)
       returning medication_schedule_id as id`,
      [fx.alicePrescriptionId, name, times.length, `{${times.join(',')}}`],
    )
    if (rows[0]) createdScheduleIds.push(rows[0].id)
    return rows
  }

  /** Each generated dose as a clinic date and time of day. */
  async function dosesOf(scheduleId: string) {
    return database.asService<{ day: string; at: string }>(
      `select ((medication_log_scheduled_at at time zone $2)::date)::text as day,
              to_char(medication_log_scheduled_at at time zone $2, 'HH24:MI') as at
         from public.medication_log
        where medication_schedule_id = $1
        order by medication_log_scheduled_at`,
      [scheduleId, CLINIC_ZONE],
    )
  }

  async function fingerprintExisting() {
    const [row] = await database.asService<{ schedules: string; doses: string }>(
      `select
         (select md5(coalesce(string_agg(s::text, '|' order by s::text), ''))
            from public.medication_schedule s
           where not (s.medication_schedule_id = any ($1::uuid[]))) as schedules,
         (select md5(coalesce(string_agg(l::text, '|' order by l::text), ''))
            from public.medication_log l
           where not (l.medication_schedule_id = any ($1::uuid[]))) as doses`,
      [`{${createdScheduleIds.join(',')}}`],
    )
    return row!
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    await database.asService(
      `insert into public.system_setting (system_setting_key, system_setting_value)
       values ('app.timezone', $1)
       on conflict (system_setting_key) do update
         set system_setting_value = excluded.system_setting_value`,
      [CLINIC_ZONE],
    )

    existingBefore = await fingerprintExisting()
  })

  afterAll(async () => {
    await database?.close()
  })

  it('stores the worked-out times, with the frequency counted from them', async () => {
    const [created] = await insertSchedule(fx.doctorAUserId, worked('3', '4', '08:00'))

    const [row] = await database.asService<{ frequency: number; times: string[] }>(
      `select medication_schedule_frequency as frequency,
              medication_schedule_times::text[] as times
         from public.medication_schedule where medication_schedule_id = $1`,
      [created!.id],
    )
    expect(row).toEqual({ frequency: 3, times: ['08:00:00', '12:00:00', '16:00:00'] })
  })

  it('generates exactly those doses each day, in the clinic time zone', async () => {
    const doses = await dosesOf(createdScheduleIds[0]!)

    // Today and tomorrow, three doses each, and nothing at 20:00.
    expect(doses).toHaveLength(6)
    const days = [...new Set(doses.map((dose) => dose.day))]
    expect(days).toHaveLength(2)
    for (const day of days) {
      expect(doses.filter((dose) => dose.day === day).map((dose) => dose.at)).toEqual([
        '08:00',
        '12:00',
        '16:00',
      ])
    }
    expect(doses.map((dose) => dose.at)).not.toContain('20:00')
  })

  it('handles 4 a day, every 6 hours, from midnight', async () => {
    const [created] = await insertSchedule(
      fx.doctorAUserId,
      worked('4', '6', '00:00'),
      'Ibuprofen',
    )
    const doses = await dosesOf(created!.id)

    expect(doses).toHaveLength(8)
    expect([...new Set(doses.map((dose) => dose.at))]).toEqual(['00:00', '06:00', '12:00', '18:00'])
  })

  it('still accepts, and generates, a schedule of typed times', async () => {
    const [created] = await insertSchedule(fx.doctorAUserId, ['08:00', '20:00'], 'Cetirizine')
    const doses = await dosesOf(created!.id)

    expect(doses).toHaveLength(4)
    expect([...new Set(doses.map((dose) => dose.at))]).toEqual(['08:00', '20:00'])
  })

  it('refuses times that do not match the frequency, behind the form', async () => {
    await expect(
      database.asService(
        `insert into public.medication_schedule
           (prescription_id, medication_schedule_name, medication_schedule_dosage,
            medication_schedule_frequency, medication_schedule_times)
         values ($1, 'Mismatch', '1 tab', 2, '{08:00,12:00,16:00}'::time[])`,
        [fx.alicePrescriptionId],
      ),
    ).rejects.toThrow(/medication_schedule_times_match_frequency/)

    await expect(
      database.asService(
        `insert into public.medication_schedule
           (prescription_id, medication_schedule_name, medication_schedule_dosage,
            medication_schedule_frequency, medication_schedule_times)
         values ($1, 'Too many', '1 tab', 13,
                 (select array_agg(make_time(h, 0, 0)) from generate_series(0, 12) h))`,
        [fx.alicePrescriptionId],
      ),
    ).rejects.toThrow(/medication_schedule_frequency_sane/)
  })

  describe('who may set a schedule', () => {
    it('refuses the patient, another doctor and the administrator', async () => {
      const times = worked('3', '4', '08:00')

      await expectDenied(() => insertSchedule(fx.aliceUserId, times, 'By the patient'))
      await expectDenied(() => insertSchedule(fx.doctorBUserId, times, 'By another doctor'))
      await expectDenied(() => insertSchedule(fx.adminUserId, times, 'By the administrator'))
    })

    it('does not let the patient change the times of their schedule', async () => {
      const scheduleId = createdScheduleIds[0]!

      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.medication_schedule
              set medication_schedule_frequency = 1,
                  medication_schedule_times = '{09:00}'::time[]
            where medication_schedule_id = $1
            returning medication_schedule_id`,
          [scheduleId],
        ),
      )

      const [row] = await database.asService<{ times: string[] }>(
        `select medication_schedule_times::text[] as times
           from public.medication_schedule where medication_schedule_id = $1`,
        [scheduleId],
      )
      expect(row?.times).toEqual(['08:00:00', '12:00:00', '16:00:00'])
    })
  })

  it('leaves every existing schedule and dose exactly as it was', async () => {
    expect(await fingerprintExisting()).toEqual(existingBefore)
  })
})
