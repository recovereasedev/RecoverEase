import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 58 — a medicine's own instructions.
 *
 * `medication_schedule_instructions` is the doctor's wording for one
 * medicine, apart from the prescription's general notes. It is optional, at
 * most 500 characters, and never blank. Who may write it is unchanged: the
 * policies of migration 6 already let only the patient's own doctor insert
 * or update a schedule, and give a patient no way to write one.
 */

const MIGRATION_57 = '20260902100065'
const MIGRATION_58 = '20260902100066'
const ROLLBACK_58 =
  'supabase/rollbacks/20260902100066_medication_schedule_instructions.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const instructionsOf = async (database: TestDatabase, scheduleId: string) => {
  const [row] = await database.asService<{ instructions: string | null }>(
    `select medication_schedule_instructions as instructions
       from public.medication_schedule where medication_schedule_id = $1`,
    [scheduleId],
  )
  return row!.instructions
}

/** The instructions alone, as the app writes them. Resolves to the rows changed. */
const setAs = (database: TestDatabase, userId: string, scheduleId: string, text: string | null) =>
  database.asUser(
    userId,
    `update public.medication_schedule
        set medication_schedule_instructions = $2
      where medication_schedule_id = $1
      returning medication_schedule_id`,
    [scheduleId, text],
  )

describe('a medicine’s own instructions (migration 58)', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('leaves a schedule written without instructions valid, with none', async () => {
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBeNull()
  })

  it('lets the patient’s doctor add a medicine with instructions', async () => {
    const [row] = await database.asUser<{ instructions: string }>(
      fx.doctorAUserId,
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage,
          medication_schedule_frequency, medication_schedule_times,
          medication_schedule_instructions)
       values ($1, 'Ibuprofen', '200mg', 1, '{09:00}', 'Take after meals.')
       returning medication_schedule_instructions as instructions`,
      [fx.alicePrescriptionId],
    )
    expect(row!.instructions).toBe('Take after meals.')
  })

  it('lets the patient’s doctor change the instructions, and clear them', async () => {
    await expect(
      setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take before meals.'),
    ).resolves.toHaveLength(1)
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBe('Take before meals.')

    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBe('Take with water.')

    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, null)
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBeNull()
  })

  it('changes no dose when the instructions change', async () => {
    const doses = () =>
      database.asService(
        `select medication_log_id, medication_log_scheduled_at, medication_log_status
           from public.medication_log where medication_schedule_id = $1
          order by medication_log_id`,
        [fx.aliceScheduleId],
      )
    const before = await doses()
    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    expect(await doses()).toEqual(before)
  })

  it('lets the patient read their instructions, and not another patient’s', async () => {
    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    const read = (userId: string) =>
      database.asUser<{ instructions: string }>(
        userId,
        `select medication_schedule_instructions as instructions
           from public.medication_schedule where medication_schedule_id = $1`,
        [fx.aliceScheduleId],
      )
    expect(await read(fx.aliceUserId)).toEqual([{ instructions: 'Take with water.' }])
    expect(await read(fx.bobUserId)).toEqual([])
  })

  it('refuses a patient who tries to change their instructions', async () => {
    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    await expectDenied(() => setAs(database, fx.aliceUserId, fx.aliceScheduleId, 'Skip it.'))
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBe('Take with water.')
  })

  it('refuses a doctor the patient is not assigned to', async () => {
    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    await expectDenied(() => setAs(database, fx.doctorBUserId, fx.aliceScheduleId, 'Changed.'))
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBe('Take with water.')
  })

  it('refuses the clinic’s administrator', async () => {
    await expectDenied(() => setAs(database, fx.adminUserId, fx.aliceScheduleId, 'Changed.'))
  })

  it('refuses, and hides the instructions from, a doctor in another clinic', async () => {
    await setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.')
    await liftSingleClinicGate(database)
    const otherClinic = await addClinic(database, 'Second Street Clinic', 'Asia/Tokyo')
    const [user] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email)
       values (gen_random_uuid(), 'doctor.z@second.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role)
       values ($1, 'doctor.z@second.test', 'doctor')`,
      [user!.id],
    )
    await database.asService(
      `insert into public.doctor
         (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Zed', 'Other', 'LIC-Z-001', true, $2)`,
      [user!.id, otherClinic],
    )

    await expectDenied(() => setAs(database, user!.id, fx.aliceScheduleId, 'Changed.'))
    await expectDenied(() =>
      database.asUser(
        user!.id,
        `select medication_schedule_instructions from public.medication_schedule
          where medication_schedule_id = $1`,
        [fx.aliceScheduleId],
      ),
    )
    expect(await instructionsOf(database, fx.aliceScheduleId)).toBe('Take with water.')
  })

  it('accepts 500 characters and refuses 501', async () => {
    await expect(
      setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'a'.repeat(500)),
    ).resolves.toHaveLength(1)
    await expect(
      setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'a'.repeat(501)),
    ).rejects.toThrow(/medication_schedule_instructions_valid/)
  })

  it('refuses blank instructions: none is NULL', async () => {
    await expect(
      setAs(database, fx.doctorAUserId, fx.aliceScheduleId, '   '),
    ).rejects.toThrow(/medication_schedule_instructions_valid/)
  })
})

describe('migration 58 on existing data, and its rollback', () => {
  it('adds the column to the schedules already there, empty, and touches nothing else', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_57 })
    try {
      const fx = await seedFixture(database)
      const schedules = () =>
        database.asService(
          `select to_jsonb(s) - 'medication_schedule_instructions' as row
             from public.medication_schedule s order by medication_schedule_id`,
        )
      const doses = () =>
        database.asService('select * from public.medication_log order by medication_log_id')
      const notes = () =>
        database.asService('select prescription_id, prescription_notes from public.prescription')
      const before = { schedules: await schedules(), doses: await doses(), notes: await notes() }
      expect(before.schedules.length).toBeGreaterThan(0)

      await database.applyMigration(MIGRATION_58)

      expect({ schedules: await schedules(), doses: await doses(), notes: await notes() }).toEqual(
        before,
      )
      // The prescription's general notes are not copied onto its medicines.
      expect(await instructionsOf(database, fx.aliceScheduleId)).toBeNull()
    } finally {
      await database.close()
    }
  })

  it('rolls back to the schema before 58, refuses a second run, and can be applied again', async () => {
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      const column = () =>
        database.asService(
          `select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'medication_schedule'
              and column_name = 'medication_schedule_instructions'`,
        )
      const schedules = () =>
        database.asService(
          `select to_jsonb(s) - 'medication_schedule_instructions' as row
             from public.medication_schedule s order by medication_schedule_id`,
        )
      const before = await schedules()

      await database.db.exec(await script(ROLLBACK_58))
      expect(await column()).toEqual([])
      expect(await schedules()).toEqual(before)

      await expect(database.db.exec(await script(ROLLBACK_58))).rejects.toThrow(
        /Migration 66 is not applied/,
      )

      await database.applyMigration(MIGRATION_58)
      expect(await column()).toHaveLength(1)
      await expect(
        setAs(database, fx.doctorAUserId, fx.aliceScheduleId, 'Take with water.'),
      ).resolves.toHaveLength(1)
    } finally {
      await database.close()
    }
  })
})
