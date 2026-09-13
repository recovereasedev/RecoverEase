import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * NA-01 and NA-03 — the database rules the appointment screens now rely on.
 *
 * NA-01: a clinician records the outcome of a visit that has happened. The
 * database always allowed it; only the screen was missing. NA-03: a pending
 * reschedule request whose appointment has since closed cannot be approved,
 * stays pending, and can still be cleared by declining it. No migration
 * changes here — these pin the existing behaviour the UI fix depends on.
 *
 * Every write is made the way the app makes it, as the patient or the
 * clinician under RLS.
 */
describe('closing out a visit, and requests on a closed appointment', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    // Reschedule requests go with their appointments.
    await database.asService('delete from public.notification')
    await database.asService('delete from public.appointment')
  })

  /** An appointment for Alice under doctorA, `hours` from now, already in `status`. */
  async function appointmentIn(hours: number, status = 'scheduled'): Promise<string> {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_status)
       values ($1, $2, now() + make_interval(hours => $3), $4)
       returning appointment_id as id`,
      [fx.alicePatId, fx.doctorAId, hours, status],
    )
    return row!.id
  }

  /** The app's status update, as `userId`. Resolves to the rows changed, or the refusal. */
  async function setStatus(userId: string, id: string, status: string) {
    try {
      const rows = await database.asUser(
        userId,
        `update public.appointment set appointment_status = $2
          where appointment_id = $1 returning appointment_id`,
        [id, status],
      )
      return { rows: rows.length }
    } catch (error) {
      return { refused: (error as Error).message }
    }
  }

  async function row(id: string) {
    const [found] = await database.asService<{ row: Record<string, unknown> }>(
      'select to_jsonb(a) as row from public.appointment a where appointment_id = $1',
      [id],
    )
    return found!.row
  }

  // --- NA-01 ----------------------------------------------------------------

  it.each([
    ['scheduled', 'completed'],
    ['scheduled', 'no_show'],
    ['confirmed', 'completed'],
    ['confirmed', 'no_show'],
  ])('lets the clinician record a past %s visit as %s', async (from, to) => {
    const id = await appointmentIn(-3, from)

    expect(await setStatus(fx.doctorAUserId, id, to)).toEqual({ rows: 1 })
    expect((await row(id))['appointment_status']).toBe(to)
  })

  it.each(['completed', 'no_show'])('does not let the patient record %s', async (to) => {
    const id = await appointmentIn(-3)

    expect(await setStatus(fx.aliceUserId, id, to)).toEqual({
      refused: 'You may only confirm or cancel an appointment',
    })
    expect((await row(id))['appointment_status']).toBe('scheduled')
  })

  it.each([
    ['cancelled', 'completed'],
    ['cancelled', 'no_show'],
    ['completed', 'no_show'],
    ['completed', 'scheduled'],
    ['no_show', 'scheduled'],
    ['no_show', 'cancelled'],
  ])('keeps a %s visit closed: the clinician cannot make it %s', async (from, to) => {
    const id = await appointmentIn(-3, from)
    const before = await row(id)

    const result = await setStatus(fx.doctorAUserId, id, to)
    expect(result).toHaveProperty('refused')
    expect(await row(id)).toEqual(before)
  })

  // --- NA-03 ----------------------------------------------------------------

  it.each(['cancelled', 'completed', 'no_show'])(
    'a pending request on a %s appointment cannot be approved, stays pending, and can be declined',
    async (closed) => {
      const id = await appointmentIn(48)
      const [request] = await database.asUser<{ id: string }>(
        fx.aliceUserId,
        `insert into public.reschedule_request (appointment_id, user_id, reschedule_request_date)
         values ($1, $2, now() + interval '72 hours') returning reschedule_request_id as id`,
        [id, fx.aliceUserId],
      )
      await database.asService(
        'update public.appointment set appointment_status = $2 where appointment_id = $1',
        [id, closed],
      )
      const before = await row(id)

      const decide = async (decision: string) => {
        try {
          const rows = await database.asUser(
            fx.doctorAUserId,
            `update public.reschedule_request set reschedule_request_status = $2
              where reschedule_request_id = $1 returning reschedule_request_id`,
            [request!.id, decision],
          )
          return { rows: rows.length }
        } catch (error) {
          return { refused: (error as Error).message }
        }
      }
      const statusOfRequest = async () =>
        (await database.asService<{ s: string }>(
          'select reschedule_request_status::text as s from public.reschedule_request where reschedule_request_id = $1',
          [request!.id],
        ))[0]!.s

      expect(await decide('approved')).toEqual({
        refused: 'This appointment is no longer active, so it cannot be moved to a new time',
      })
      expect(await statusOfRequest()).toBe('pending')
      expect(await row(id)).toEqual(before)

      expect(await decide('declined')).toEqual({ rows: 1 })
      expect(await statusOfRequest()).toBe('declined')
      expect(await row(id)).toEqual(before)
    },
  )
})
