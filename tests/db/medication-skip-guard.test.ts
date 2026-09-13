import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * QA 9/13, item 3: "Don't give them the option to skip".
 *
 * Removing the Skip button was not the control. The patient's update policy
 * admits them to the whole of their own dose rows, so a direct Data API call
 * could still record any dose as skipped. Migration 25 refuses that write
 * from an end-user session, and leaves doses already recorded as skipped
 * exactly as they are.
 */
describe('recording a dose as skipped', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const REFUSED = /cannot be recorded as skipped/i

  /**
   * One of Alice's doses, recorded directly by the system at `at` past the
   * start of the database's today. Odd minutes keep clear of generated slots.
   */
  async function dose(at: string, status = 'pending'): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.medication_log
         (medication_schedule_id, medication_log_scheduled_at,
          medication_log_status, medication_log_taken_at)
       values ($1, date_trunc('day', now()) + $2::interval,
               $3::public.medication_log_status,
               case when $3::text = 'taken' then now() end)
       returning medication_log_id as id`,
      [fx.aliceScheduleId, at, status],
    )
    return row!.id
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const [row] = await database.asService<{ status: string }>(
      `select medication_log_status as status from public.medication_log
        where medication_log_id = $1`,
      [id],
    )
    return row?.status
  }

  const setStatus = (userId: string, id: string, status: string) =>
    database.asUser(
      userId,
      `update public.medication_log set medication_log_status = $2::public.medication_log_status
        where medication_log_id = $1 returning medication_log_id`,
      [id, status],
    )

  describe('the original bypass: a patient writing it directly', () => {
    it.each([
      ['a past dose', '-3 days 09:13:00'],
      ['a dose due today', '12:07:00'],
      ['a future dose', '3 days 09:13:00'],
    ])('is refused on %s, which stays pending', async (_label, at) => {
      const id = await dose(at)

      await expect(setStatus(fx.aliceUserId, id, 'skipped')).rejects.toThrow(REFUSED)
      expect(await statusOf(id)).toBe('pending')
    })

    it.each([
      ['taken', '-2 days 09:23:00'],
      ['missed', '-2 days 09:27:00'],
    ])('is refused on a dose already %s', async (status, at) => {
      const id = await dose(at, status)

      await expect(setStatus(fx.aliceUserId, id, 'skipped')).rejects.toThrow(REFUSED)
      expect(await statusOf(id)).toBe(status)
    })

    it('is refused as a new dose row', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `insert into public.medication_log
             (medication_schedule_id, medication_log_scheduled_at, medication_log_status)
           values ($1, date_trunc('day', now()) + interval '5 days 09:29:00', 'skipped')
           returning medication_log_id`,
          [fx.aliceScheduleId],
        ),
      )
    })
  })

  describe('what a patient can still do', () => {
    it('records a dose as taken, and undoes it', async () => {
      const id = await dose('-1 days 09:31:00')

      await setStatus(fx.aliceUserId, id, 'taken')
      expect(await statusOf(id)).toBe('taken')

      await setStatus(fx.aliceUserId, id, 'pending')
      expect(await statusOf(id)).toBe('pending')
    })

    it('reads a dose already recorded as skipped, and Undo returns it to pending for good', async () => {
      const id = await dose('-4 days 09:37:00', 'skipped')

      const read = await database.asUser<{ status: string }>(
        fx.aliceUserId,
        `select medication_log_status as status from public.medication_log
          where medication_log_id = $1`,
        [id],
      )
      expect(read).toEqual([{ status: 'skipped' }])

      // Writing the value it already holds is not a change.
      await setStatus(fx.aliceUserId, id, 'skipped')
      expect(await statusOf(id)).toBe('skipped')

      await setStatus(fx.aliceUserId, id, 'pending')
      expect(await statusOf(id)).toBe('pending')

      // Once returned, it cannot be skipped again.
      await expect(setStatus(fx.aliceUserId, id, 'skipped')).rejects.toThrow(REFUSED)
    })
  })

  describe('everyone else', () => {
    it('lets the treating doctor read a skipped dose, and still write none', async () => {
      const skipped = await dose('-6 days 09:41:00', 'skipped')
      const pending = await dose('-6 days 09:43:00')

      const read = await database.asUser<{ status: string }>(
        fx.doctorAUserId,
        `select medication_log_status as status from public.medication_log
          where medication_log_id = $1`,
        [skipped],
      )
      expect(read).toEqual([{ status: 'skipped' }])

      await expectDenied(() => setStatus(fx.doctorAUserId, pending, 'skipped'))
      expect(await statusOf(pending)).toBe('pending')
    })

    it('refuses another patient and a visitor with no session', async () => {
      const id = await dose('-7 days 09:47:00')

      await expectDenied(() => setStatus(fx.bobUserId, id, 'skipped'))
      await expectDenied(() =>
        database.asAnon(
          `update public.medication_log set medication_log_status = 'skipped'
            where medication_log_id = $1 returning medication_log_id`,
          [id],
        ),
      )
      expect(await statusOf(id)).toBe('pending')
    })

    it('leaves the system able to record skipped', async () => {
      const id = await dose('-8 days 09:53:00')

      await database.asService(
        `update public.medication_log set medication_log_status = 'skipped'
          where medication_log_id = $1`,
        [id],
      )
      expect(await statusOf(id)).toBe('skipped')
    })
  })
})
