import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 11.2 "Update Doctor Account": what the database lets a Clinic Admin
 * change on a doctor's row, and whom it lets change it.
 *
 * The Doctor accounts page sends an update of up to five columns - names,
 * licence number, specialisation, contact number - for one `doc_id`
 * (`tests/unit/admin-edit-doctor.test.tsx`). The rules proven here are
 * migration 30's update policy and the guards of migrations 7, 29 and 42,
 * exercised with the statement the screen sends; migration 54's guard on the
 * record ID and registration date has its own suite
 * (tests/db/doctor-identity-fixed.test.ts). A screen that hides a button is not what keeps another
 * clinic's doctor from being renamed; these are.
 *
 *   Clinic A (Harborview): the shared fixture - its admin, doctors A and B,
 *     deactivated doctor C, patient Alice (doctor A's).
 *   Clinic B (synthetic, in this suite's own database): admin B and doctor D.
 */

/** The columns the edit dialog may send. */
const DETAILS = [
  'doc_first_name',
  'doc_last_name',
  'doc_license_no',
  'doc_specialization',
  'doc_contact_no',
] as const

type Details = Partial<Record<(typeof DETAILS)[number], string | null>>
type DoctorRow = Record<string, unknown>

describe('a Clinic Admin updates a doctor account (module 11.2)', () => {
  let database: TestDatabase
  let fx: Fixture
  let adminBUserId: string
  let doctorDId: string

  /** The whole row, as it is stored. */
  async function stored(doctorId: string): Promise<DoctorRow> {
    const [row] = await database.asService<DoctorRow>(
      'select * from public.doctor where doc_id = $1',
      [doctorId],
    )
    return row!
  }

  /** As the dialog saves: only the columns given, on the one doctor. */
  function edit(userId: string | null, doctorId: string, changes: Details) {
    const columns = DETAILS.filter((column) => column in changes)
    const sql = `update public.doctor
        set ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')}
      where doc_id = $1 returning doc_id`
    const params = [doctorId, ...columns.map((column) => changes[column])]
    return userId === null
      ? database.asAnon<{ doc_id: string }>(sql, params)
      : database.asUser<{ doc_id: string }>(userId, sql, params)
  }

  async function account(email: string, role: 'doctor' | 'admin'): Promise<string> {
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

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    await liftSingleClinicGate(database)
    const clinicB = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
    adminBUserId = await account('admin.b@second.test', 'admin')
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Bianca', 'Ortiz', $2)`,
      [adminBUserId, clinicB],
    )
    const [doctorD] = await database.asService<{ doc_id: string }>(
      `insert into public.doctor
         (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Dara', 'Ong', 'LIC-B-D', $2) returning doc_id`,
      [await account('doctor.d@second.test', 'doctor'), clinicB],
    )
    doctorDId = doctorD!.doc_id
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('in their own clinic', () => {
    it('changes the five details, and nothing else on the row', async () => {
      const before = await stored(fx.doctorAId)
      const changes = {
        doc_first_name: 'Alonzo',
        doc_last_name: 'Cruz-Santos',
        doc_license_no: 'LIC-A-900',
        doc_specialization: 'Sports rehabilitation',
        doc_contact_no: '+63 917 555 0142',
      }

      await expect(edit(fx.adminUserId, fx.doctorAId, changes)).resolves.toEqual([
        { doc_id: fx.doctorAId },
      ])

      // Status, clinic, linked account, reminder setting, id and the date the
      // account was registered are exactly as they were.
      expect(await stored(fx.doctorAId)).toEqual({ ...before, ...changes })
    })

    it('changes one detail on its own, leaving the other four alone', async () => {
      const before = await stored(fx.doctorBId)

      await edit(fx.adminUserId, fx.doctorBId, { doc_contact_no: '0917 222 3333' })

      expect(await stored(fx.doctorBId)).toEqual({ ...before, doc_contact_no: '0917 222 3333' })
    })

    it('clears an optional detail', async () => {
      await edit(fx.adminUserId, fx.doctorBId, {
        doc_specialization: 'Hand therapy',
        doc_contact_no: '0917 222 3333',
      })
      await edit(fx.adminUserId, fx.doctorBId, { doc_specialization: null, doc_contact_no: null })

      expect(await stored(fx.doctorBId)).toMatchObject({
        doc_specialization: null,
        doc_contact_no: null,
      })
    })

    it('corrects a deactivated doctor’s details without reactivating them', async () => {
      await expect(
        edit(fx.adminUserId, fx.doctorCId, { doc_last_name: 'Tan-Reyes' }),
      ).resolves.toHaveLength(1)

      expect(await stored(fx.doctorCId)).toMatchObject({
        doc_last_name: 'Tan-Reyes',
        doc_is_active: false,
      })
    })

    it('refuses a licence number another doctor holds - in this clinic or any other', async () => {
      const before = await stored(fx.doctorBId)

      for (const taken of ['LIC-C-003', 'LIC-B-D']) {
        await expect(
          edit(fx.adminUserId, fx.doctorBId, { doc_license_no: taken }),
        ).rejects.toMatchObject({
          // unique_violation: what the dialog reads to say so beside the field.
          code: '23505',
          message: expect.stringContaining('doctor_license_no_key'),
        })
      }
      expect(await stored(fx.doctorBId)).toEqual(before)
    })

    it.each([
      ['a blank first name', { doc_first_name: '   ' }],
      ['a blank last name', { doc_last_name: '' }],
      ['a blank licence number', { doc_license_no: '  ' }],
    ])('refuses %s', async (_label, changes) => {
      const before = await stored(fx.doctorBId)

      await expect(edit(fx.adminUserId, fx.doctorBId, changes)).rejects.toMatchObject({
        code: '23514', // check_violation
      })
      expect(await stored(fx.doctorBId)).toEqual(before)
    })
  })

  describe('and nowhere else', () => {
    it('changes nothing on a doctor of another clinic, whichever detail is sent', async () => {
      const before = await stored(doctorDId)

      for (const changes of [
        { doc_first_name: 'Renamed' },
        { doc_license_no: 'LIC-STOLEN' },
        { doc_specialization: 'Changed', doc_contact_no: '0900 000 0000' },
      ]) {
        await expectDenied(() => edit(fx.adminUserId, doctorDId, changes))
      }
      expect(await stored(doctorDId)).toEqual(before)
    })

    it('is closed to the other clinic’s administrator the same way', async () => {
      const before = await stored(fx.doctorBId)

      await expectDenied(() => edit(adminBUserId, fx.doctorBId, { doc_last_name: 'Renamed' }))
      await expectDenied(() => edit(adminBUserId, fx.doctorBId, { doc_license_no: 'LIC-STOLEN' }))
      expect(await stored(fx.doctorBId)).toEqual(before)

      // Their own clinic's doctor is theirs to correct.
      await expect(
        edit(adminBUserId, doctorDId, { doc_contact_no: '03-5555-0100' }),
      ).resolves.toHaveLength(1)
    })
  })

  describe('by nobody but the clinic’s administrator', () => {
    it('lets no other doctor, patient or visitor change a doctor’s details', async () => {
      const before = await stored(fx.doctorBId)
      const changes = { doc_first_name: 'Renamed', doc_contact_no: '0900 000 0000' }

      // Another doctor of the same clinic, a patient, and nobody at all.
      for (const caller of [fx.doctorAUserId, fx.aliceUserId, null]) {
        await expectDenied(() => edit(caller, fx.doctorBId, changes))
      }
      // Alice can read her own doctor's row, and still cannot write it.
      const aliceDoctor = await stored(fx.doctorAId)
      await expectDenied(() => edit(fx.aliceUserId, fx.doctorAId, changes))

      expect(await stored(fx.doctorBId)).toEqual(before)
      expect(await stored(fx.doctorAId)).toEqual(aliceDoctor)
    })

    it('keeps the licence number out of the doctor’s own hands', async () => {
      const before = await stored(fx.doctorBId)

      await expect(
        edit(fx.doctorBUserId, fx.doctorBId, { doc_license_no: 'LIC-SELF' }),
      ).rejects.toThrow(/Only an administrator can change a licence number/)
      expect(await stored(fx.doctorBId)).toEqual(before)
    })
  })

  describe('what the dialog never sends', () => {
    it('is refused to the administrator where the database guards it', async () => {
      const before = await stored(fx.doctorBId)
      const asAdmin = (assignment: string, value: unknown) =>
        database.asUser(
          fx.adminUserId,
          `update public.doctor set ${assignment} = $2 where doc_id = $1 returning doc_id`,
          [fx.doctorBId, value],
        )

      // The linked sign-in (migration 7).
      await expect(asAdmin('user_id', fx.doctorAUserId)).rejects.toThrow(
        /The linked account of a doctor record cannot be changed/,
      )
      // The clinic (migration 29).
      const [other] = await database.asService<{ clinic_id: string }>(
        'select clinic_id from public.doctor where doc_id = $1',
        [doctorDId],
      )
      await expect(asAdmin('clinic_id', other!.clinic_id)).rejects.toThrow(
        /A doctor cannot be moved to another clinic/,
      )
      // The doctor's own reminder setting (migration 42).
      await expect(asAdmin('doc_appointment_reminder_is_enabled', false)).rejects.toThrow(
        /Only the doctor can change their own reminder settings/,
      )

      expect(await stored(fx.doctorBId)).toEqual(before)
    })
  })
})
