import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 4.9, "Configure Medication Reminder Preferences": who may write a
 * patient's two reminder choices.
 *
 * They live on the patient's own row (`pat_reminder_is_enabled`,
 * `pat_reminder_preferred_time`), which the `patient_update` policy lets the
 * patient write. A patient must be able to change their own, and only their
 * own: another patient's row is not theirs to read, so it is not theirs to
 * write either, and RLS filters it out of the update rather than raising.
 * That is why each refusal below is checked by reading the row back as the
 * service role, not by expecting an error.
 *
 * Migration 37's clinic-wide lead time is a different setting, written only
 * by the Clinic Admin (`tests/db/medication-pre-dose-reminders.test.ts`).
 */
describe('a patient’s reminder preferences', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const preferencesOf = async (patId: string) => {
    const [row] = await database.asService<{ enabled: boolean; time: string | null }>(
      `select pat_reminder_is_enabled as enabled, pat_reminder_preferred_time::text as time
         from public.patient where pat_id = $1`,
      [patId],
    )
    return row
  }

  it('lets a patient turn their own reminders off and set the earliest time', async () => {
    const updated = await database.asUser<{ pat_id: string }>(
      fx.aliceUserId,
      `update public.patient
          set pat_reminder_is_enabled = false, pat_reminder_preferred_time = '07:30'
        where pat_id = $1
       returning pat_id`,
      [fx.alicePatId],
    )

    expect(updated).toEqual([{ pat_id: fx.alicePatId }])
    expect(await preferencesOf(fx.alicePatId)).toEqual({ enabled: false, time: '07:30:00' })
  })

  it('lets them turn reminders back on and clear the time', async () => {
    await database.asUser(
      fx.aliceUserId,
      `update public.patient
          set pat_reminder_is_enabled = true, pat_reminder_preferred_time = null
        where pat_id = $1`,
      [fx.alicePatId],
    )

    expect(await preferencesOf(fx.alicePatId)).toEqual({ enabled: true, time: null })
  })

  it('does not let a patient change another patient’s preferences', async () => {
    const before = await preferencesOf(fx.bobPatId)

    const updated = await database.asUser(
      fx.aliceUserId,
      `update public.patient
          set pat_reminder_is_enabled = false, pat_reminder_preferred_time = '23:00'
        where pat_id = $1
       returning pat_id`,
      [fx.bobPatId],
    )

    expect(updated).toEqual([])
    expect(await preferencesOf(fx.bobPatId)).toEqual(before)
  })

  it('does not let an anonymous caller change anyone’s preferences', async () => {
    const before = await preferencesOf(fx.alicePatId)

    // anon has no UPDATE on the table at all, or a policy that matches no
    // row; either way nothing may change.
    try {
      await database.asAnon(
        `update public.patient set pat_reminder_is_enabled = false where pat_id = $1`,
        [fx.alicePatId],
      )
    } catch {
      // Refused outright: also fine.
    }

    expect(await preferencesOf(fx.alicePatId)).toEqual(before)
  })

  it('refuses a time that is not a time of day', async () => {
    await expect(
      database.asUser(
        fx.aliceUserId,
        `update public.patient set pat_reminder_preferred_time = '25:00' where pat_id = $1`,
        [fx.alicePatId],
      ),
    ).rejects.toThrow()
  })
})
