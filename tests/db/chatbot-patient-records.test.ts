import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The guidance assistant's patient records (supabase/functions/_shared/
 * patient-record-store.ts) are read with the patient's own token, so the
 * policies below are the second lock behind the patient id the function
 * derives from the conversation. These are the store's queries, written as
 * the SQL PostgREST runs for them, issued as different principals.
 *
 * The question each test asks: even if the function were handed the wrong
 * patient id - another patient's, as a client might try to supply - would
 * the database still return nothing?
 */
describe('the guidance assistant’s patient records', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await database.asService(
      `insert into public.reschedule_request (appointment_id, user_id, reschedule_request_date)
       values ($1, $2, now() + interval '9 days')`,
      [fx.aliceAppointmentId, fx.aliceUserId],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  /** Each store query, for the patient id it is given. */
  const QUERIES: Record<string, string> = {
    medications: `
      select ms.medication_schedule_name, ms.medication_schedule_dosage, p.pat_id
        from public.medication_schedule ms
        join public.prescription p on p.prescription_id = ms.prescription_id
       where p.pat_id = $1`,
    appointments: `
      select appointment_id, appointment_date, appointment_status, pat_id
        from public.appointment where pat_id = $1`,
    rescheduleRequests: `
      select rr.reschedule_request_date, rr.reschedule_request_status, a.pat_id
        from public.reschedule_request rr
        join public.appointment a on a.appointment_id = rr.appointment_id
       where a.pat_id = $1`,
    treatmentPlans: `
      select treatment_plan_id, treatment_plan_title, pat_id
        from public.treatment_plan where pat_id = $1`,
    goals: `
      select g.treatment_goal_description, g.treatment_goal_status
        from public.treatment_goal g
        join public.treatment_plan tp on tp.treatment_plan_id = g.treatment_plan_id
       where tp.pat_id = $1`,
    roadmapPhases: `
      select rp.recovery_phase_title
        from public.recovery_phase rp
        join public.treatment_plan tp on tp.treatment_plan_id = rp.treatment_plan_id
       where tp.pat_id = $1`,
  }

  const read = (userId: string, query: string, patId: string) =>
    database.asUser(userId, QUERIES[query]!, [patId])

  it.each(['medications', 'appointments', 'rescheduleRequests', 'treatmentPlans', 'goals'])(
    'lets the patient read their own %s',
    async (query) => {
      expect((await read(fx.aliceUserId, query, fx.alicePatId)).length).toBeGreaterThan(0)
    },
  )

  it('returns only the patient’s own rows, with the fields the store maps', async () => {
    expect(await read(fx.aliceUserId, 'medications', fx.alicePatId)).toEqual([
      { medication_schedule_name: 'Paracetamol', medication_schedule_dosage: '500mg', pat_id: fx.alicePatId },
    ])
    const requests = await read(fx.aliceUserId, 'rescheduleRequests', fx.alicePatId)
    expect(requests).toEqual([
      expect.objectContaining({ reschedule_request_status: 'pending', pat_id: fx.alicePatId }),
    ])
  })

  it.each(Object.keys(QUERIES))(
    'gives a patient nothing of another patient’s %s, even when asked by that patient’s id',
    async (query) => {
      // Bob shares Alice's doctor; Carol has a different one.
      expect(await read(fx.bobUserId, query, fx.alicePatId)).toEqual([])
      expect(await read(fx.aliceUserId, query, fx.carolPatId)).toEqual([])
    },
  )

  it.each(Object.keys(QUERIES))(
    'gives an unauthenticated caller nothing of %s',
    async (query) => {
      await expectDenied(() => database.asAnon(QUERIES[query]!, [fx.alicePatId]))
    },
  )

  it('lets a patient see exactly one clinic, for its time zone', async () => {
    const clinics = await database.asUser<{ clinic_timezone: string }>(
      fx.aliceUserId,
      'select clinic_timezone from public.clinic limit 2',
    )
    expect(clinics).toHaveLength(1)
  })

  /** The store's careTeam query: the doctor named by the patient row, and its clinic. */
  const CARE_TEAM = `
    select d.doc_first_name, d.doc_last_name, d.doc_specialization, d.doc_is_active,
           c.clinic_name, c.clinic_status
      from public.doctor d
      left join public.clinic c on c.clinic_id = d.clinic_id
     where d.doc_id = $1`

  it('lets a patient read their own assigned doctor and clinic', async () => {
    const [team] = await database.asUser<Record<string, unknown>>(fx.aliceUserId, CARE_TEAM, [fx.doctorAId])
    expect(team).toMatchObject({ doc_is_active: true, clinic_status: 'active' })
    expect(typeof team!.doc_first_name).toBe('string')
    expect(typeof team!.clinic_name).toBe('string')
  })

  it('gives a patient nothing of another patient’s doctor, even when asked by that doctor’s id', async () => {
    // As if a request had supplied doctor B's id for Alice, or doctor A's for Carol.
    expect(await database.asUser(fx.aliceUserId, CARE_TEAM, [fx.doctorBId])).toEqual([])
    expect(await database.asUser(fx.carolUserId, CARE_TEAM, [fx.doctorAId])).toEqual([])
  })

  it('shows a deactivated assigned doctor as inactive rather than hiding them', async () => {
    const [team] = await database.asUser<Record<string, unknown>>(fx.daveUserId, CARE_TEAM, [fx.doctorCId])
    expect(team).toMatchObject({ doc_is_active: false })
  })

  it('gives an unauthenticated caller no doctor', async () => {
    await expectDenied(() => database.asAnon(CARE_TEAM, [fx.doctorAId]))
  })

  it('cannot be reached through another patient’s conversation', async () => {
    // The function proves ownership with the service key; this is the same
    // read the patient's own client would get, and it is empty.
    expect(
      await database.asUser(
        fx.bobUserId,
        'select chat_session_id from public.chat_session where chat_session_id = $1',
        [fx.aliceChatSessionId],
      ),
    ).toEqual([])
  })
})
