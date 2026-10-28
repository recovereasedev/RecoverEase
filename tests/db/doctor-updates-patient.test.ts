import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 2.5 "Update Patient Information", as the doctor's Edit details sends
 * it: the six columns a record describes a patient by, under
 * `patient_update`. Only the assigned doctor may; nobody else's update
 * reaches the row.
 */

const SAVE = `
  update public.patient
     set pat_first_name = $2, pat_last_name = $3, pat_birth_date = $4,
         pat_gender = $5, pat_contact_no = $6, pat_address = $7
   where pat_id = $1
  returning pat_id`

const VALUES = ['Alicia', 'Santos-Reyes', '1991-04-02', 'Female', '0917 555 0101', '12 Mabini St']

describe('a doctor updating their patient’s details (module 2.5)', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('saves them for the patient’s own doctor', async () => {
    const saved = await database.asUser(fx.doctorAUserId, SAVE, [fx.alicePatId, ...VALUES])
    expect(saved).toHaveLength(1)

    const [row] = await database.asService<Record<string, string>>(
      `select pat_first_name, pat_last_name, pat_birth_date::text as pat_birth_date,
              pat_gender, pat_contact_no, pat_address, doc_id::text as doc_id, pat_status::text as pat_status
         from public.patient where pat_id = $1`,
      [fx.alicePatId],
    )
    expect(row).toMatchObject({
      pat_first_name: 'Alicia',
      pat_last_name: 'Santos-Reyes',
      pat_birth_date: '1991-04-02',
      pat_gender: 'Female',
      pat_contact_no: '0917 555 0101',
      pat_address: '12 Mabini St',
      // Who treats them and their status are not part of it.
      doc_id: fx.doctorAId,
      pat_status: 'active',
    })
  })

  it('reaches no row for another doctor, an administrator or another patient', async () => {
    for (const userId of [fx.doctorBUserId, fx.adminUserId, fx.bobUserId]) {
      expect(await database.asUser(userId, SAVE, [fx.alicePatId, ...VALUES]), userId).toEqual([])
    }
  })
})
