import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 54: a doctor's `doc_id` and `doc_created_at` are fixed once the
 * row exists, for every writer.
 *
 * Before it, migration 30's update policy let a Clinic Admin rewrite both on
 * their clinic's doctors (`doc_id` wherever nothing referenced it yet), and a
 * doctor rewrite their own registration date, through the Data API. The
 * Doctor accounts edit dialog never sends either (module 11.2); this is what
 * stops a caller who does not use it.
 *
 * Doctor E is added here with nothing pointing at them, so a refused `doc_id`
 * is refused by the guard, not by a foreign key.
 */

const MIGRATION_53 = '20260902100053'
const MIGRATION_54 = '20260902100054'
const MIGRATION_54_FILE = 'supabase/migrations/20260902100054_doctor_identity_columns_fixed.sql'
const ROLLBACK_54 = 'supabase/rollbacks/20260902100054_doctor_identity_columns_fixed.down.sql'

const ID_GUARD = /A doctor's record ID cannot be changed/
const DATE_GUARD = /A doctor's registration date cannot be changed/
const NEW_ID = '00000000-0000-4000-8000-0000000000e9'
const EARLIER = '2020-01-01T00:00:00Z'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

type DoctorRow = Record<string, unknown>

async function account(database: TestDatabase, email: string, role: 'doctor' | 'admin') {
  const [user] = await database.asService<{ id: string }>(
    'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
    [email],
  )
  await database.asService(
    'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
    [user!.id, email, role],
  )
  return user!.id
}

describe('a doctor’s record ID and registration date (migration 54)', () => {
  let database: TestDatabase
  let fx: Fixture
  let doctorEId: string
  let doctorEUserId: string
  let adminBUserId: string
  let doctorDId: string

  async function stored(doctorId: string): Promise<DoctorRow> {
    const [row] = await database.asService<DoctorRow>(
      'select * from public.doctor where doc_id = $1',
      [doctorId],
    )
    return row!
  }

  const set = (userId: string, doctorId: string, assignment: string, value: unknown) =>
    database.asUser(
      userId,
      `update public.doctor set ${assignment} = $2 where doc_id = $1 returning doc_id`,
      [doctorId, value],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    doctorEUserId = await account(database, 'doctor.e@harborview.test', 'doctor')
    const [clinicA] = await database.asService<{ clinic_id: string }>(
      'select clinic_id from public.doctor where doc_id = $1',
      [fx.doctorAId],
    )
    const [doctorE] = await database.asService<{ doc_id: string }>(
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Elena', 'Santos', 'LIC-A-E', $2) returning doc_id`,
      [doctorEUserId, clinicA!.clinic_id],
    )
    doctorEId = doctorE!.doc_id

    await liftSingleClinicGate(database)
    const clinicB = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
    adminBUserId = await account(database, 'admin.b@second.test', 'admin')
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Bianca', 'Ortiz', $2)`,
      [adminBUserId, clinicB],
    )
    const [doctorD] = await database.asService<{ doc_id: string }>(
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Dara', 'Ong', 'LIC-B-D', $2) returning doc_id`,
      [await account(database, 'doctor.d@second.test', 'doctor'), clinicB],
    )
    doctorDId = doctorD!.doc_id
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('are refused', () => {
    it('to the clinic’s administrator: the record ID', async () => {
      const before = await stored(doctorEId)
      await expect(set(fx.adminUserId, doctorEId, 'doc_id', NEW_ID)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(ID_GUARD),
      })
      expect(await stored(doctorEId)).toEqual(before)
    })

    it('to the clinic’s administrator: the registration date', async () => {
      const before = await stored(doctorEId)
      await expect(set(fx.adminUserId, doctorEId, 'doc_created_at', EARLIER)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(DATE_GUARD),
      })
      expect(await stored(doctorEId)).toEqual(before)
    })

    it('to the doctor themself: their registration date', async () => {
      const before = await stored(doctorEId)
      await expect(set(doctorEUserId, doctorEId, 'doc_created_at', EARLIER)).rejects.toThrow(DATE_GUARD)
      expect(await stored(doctorEId)).toEqual(before)
    })

    it('to the doctor themself: their record ID', async () => {
      const before = await stored(doctorEId)
      await expect(set(doctorEUserId, doctorEId, 'doc_id', NEW_ID)).rejects.toThrow(ID_GUARD)
      expect(await stored(doctorEId)).toEqual(before)
    })

    it('alongside permitted changes, so none of the update is kept', async () => {
      const before = await stored(doctorEId)
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.doctor
              set doc_last_name = 'Renamed', doc_contact_no = '0900 000 0000', doc_created_at = $2
            where doc_id = $1 returning doc_id`,
          [doctorEId, EARLIER],
        ),
      ).rejects.toThrow(DATE_GUARD)
      expect(await stored(doctorEId)).toEqual(before)
    })

    it('to the service role and the database’s own jobs as well', async () => {
      const before = await stored(doctorEId)
      await expect(
        database.asService('update public.doctor set doc_id = $2 where doc_id = $1', [doctorEId, NEW_ID]),
      ).rejects.toThrow(ID_GUARD)
      await expect(
        database.asService('update public.doctor set doc_created_at = $2 where doc_id = $1', [doctorEId, EARLIER]),
      ).rejects.toThrow(DATE_GUARD)
      expect(await stored(doctorEId)).toEqual(before)
    })
  })

  describe('leave everything else as it was', () => {
    it('lets the administrator change all five details', async () => {
      const before = await stored(doctorEId)
      const changes = {
        doc_first_name: 'Elena Mae',
        doc_last_name: 'Santos-Reyes',
        doc_license_no: 'LIC-A-E-2',
        doc_specialization: 'Neurological rehabilitation',
        doc_contact_no: '+63 917 555 0199',
      }
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.doctor
              set doc_first_name = $2, doc_last_name = $3, doc_license_no = $4,
                  doc_specialization = $5, doc_contact_no = $6
            where doc_id = $1 returning doc_id`,
          [doctorEId, ...Object.values(changes)],
        ),
      ).resolves.toEqual([{ doc_id: doctorEId }])
      expect(await stored(doctorEId)).toEqual({ ...before, ...changes })
    })

    it('accepts both columns sent back unchanged, as a whole-row save would', async () => {
      const before = await stored(doctorEId)
      await expect(
        database.asUser(
          doctorEUserId,
          `update public.doctor
              set doc_id = doc_id, doc_created_at = doc_created_at, doc_contact_no = '0917 000 1111'
            where doc_id = $1 returning doc_id`,
          [doctorEId],
        ),
      ).resolves.toHaveLength(1)
      expect(await stored(doctorEId)).toEqual({ ...before, doc_contact_no: '0917 000 1111' })
    })

    it('keeps another clinic’s doctors out of reach', async () => {
      const before = await stored(doctorDId)
      await expectDenied(() => set(fx.adminUserId, doctorDId, 'doc_last_name', 'Renamed'))
      await expectDenied(() => set(adminBUserId, doctorEId, 'doc_last_name', 'Renamed'))
      expect(await stored(doctorDId)).toEqual(before)
    })

    it('keeps activation with the administrator and the reminder setting with the doctor', async () => {
      await expect(set(fx.adminUserId, doctorEId, 'doc_is_active', false)).resolves.toHaveLength(1)
      await expect(set(doctorEUserId, doctorEId, 'doc_is_active', true)).rejects.toThrow(
        /Only an administrator can activate or deactivate a doctor account/,
      )
      await expect(set(fx.adminUserId, doctorEId, 'doc_is_active', true)).resolves.toHaveLength(1)

      await expect(set(fx.adminUserId, doctorEId, 'doc_appointment_reminder_is_enabled', false)).rejects.toThrow(
        /Only the doctor can change their own reminder settings/,
      )
      await expect(set(doctorEUserId, doctorEId, 'doc_appointment_reminder_is_enabled', false)).resolves.toHaveLength(1)
      expect(await stored(doctorEId)).toMatchObject({
        doc_is_active: true,
        doc_appointment_reminder_is_enabled: false,
      })
    })
  })
})

describe('migration 54, before and after', () => {
  it('waits at most 3 seconds for its lock, puts the setting back, and can be run again', async () => {
    const lines = (await script(MIGRATION_54_FILE))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'))
    expect(lines[0]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase({ stopAfter: MIGRATION_53 })
    try {
      const fx = await seedFixture(database)
      await database.applyMigration(MIGRATION_54)
      await database.applyMigration(MIGRATION_54)

      const [row] = await database.asService<{ n: number; lock_timeout: string }>(
        `select (select count(*)::int from pg_trigger where tgname = 'doctor_identity_is_fixed') as n,
                current_setting('lock_timeout') as lock_timeout`,
      )
      expect(row).toEqual({ n: 1, lock_timeout: '0' })
      await expect(set54(database, fx.adminUserId, fx.doctorBId)).rejects.toThrow(DATE_GUARD)
    } finally {
      await database.close()
    }
  })

  it('rolls back to the earlier rules, refuses to run twice, and can be applied again', async () => {
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.db.exec(await script(ROLLBACK_54))

      const leftovers = await database.asService(
        `select 1 from pg_trigger where tgname = 'doctor_identity_is_fixed'
         union all
         select 1 from pg_proc where proname = 'doctor_identity_is_fixed'`,
      )
      expect(leftovers).toEqual([])
      await expect(set54(database, fx.adminUserId, fx.doctorBId)).resolves.toHaveLength(1)

      await expect(database.db.exec(await script(ROLLBACK_54))).rejects.toThrow(
        /Migration 54 is not applied/,
      )

      await database.applyMigration(MIGRATION_54)
      await expect(set54(database, fx.adminUserId, fx.doctorBId)).rejects.toThrow(DATE_GUARD)
    } finally {
      await database.close()
    }
  })
})

/** The administrator moves a doctor's registration date: refused from 54. */
function set54(database: TestDatabase, adminUserId: string, doctorId: string) {
  return database.asUser(
    adminUserId,
    `update public.doctor set doc_created_at = doc_created_at - interval '1 day'
      where doc_id = $1 returning doc_id`,
    [doctorId],
  )
}
