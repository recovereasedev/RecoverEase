import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * A closed appointment stays closed.
 *
 * 'cancelled', 'completed' and 'no_show' settle an appointment. Neither
 * screen offers any action on one and migration 17 stops a reschedule from
 * reopening one, but the status was an ordinary column update: a patient
 * could set a cancelled appointment back to 'confirmed', and a clinician or
 * the service role could move any closed status to anything.
 *
 * Every write here is made the way the app makes it — a status-only update
 * of `appointment` — as the patient and the clinician under RLS, and as the
 * service role, which RLS does not restrain.
 */
describe('closed appointment statuses', () => {
  const REFUSED = {
    cancelled:
      'This appointment has already been cancelled, so it can no longer be changed',
    completed:
      'This appointment has already been completed, so it can no longer be changed',
    no_show:
      'This appointment has already been marked as a no-show, so it can only be corrected to completed by the clinician',
  } as const

  const STATUSES = ['scheduled', 'confirmed', 'cancelled', 'completed', 'no_show'] as const
  const CLOSED = ['cancelled', 'completed', 'no_show'] as const
  type Status = (typeof STATUSES)[number]
  type Closed = (typeof CLOSED)[number]
  type Caller = 'patient' | 'doctor' | 'service'

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

  // --- Helpers --------------------------------------------------------------

  function as(caller: Caller, sql: string, params: unknown[] = []) {
    if (caller === 'patient') return database.asUser(fx.aliceUserId, sql, params)
    if (caller === 'doctor') return database.asUser(fx.doctorAUserId, sql, params)
    return database.asService(sql, params)
  }

  /** An appointment for Alice under doctorA, `hoursAway` from now, inserted already in `status`. */
  async function appointmentIn(hoursAway: number, status: Status): Promise<string> {
    const [row] = await database.asService<{ appointment_id: string }>(
      `insert into public.appointment
         (pat_id, doc_id, appointment_date, appointment_status)
       values ($1, $2, now() + make_interval(hours => $3), $4)
       returning appointment_id`,
      [fx.alicePatId, fx.doctorAId, hoursAway, status],
    )
    return row!.appointment_id
  }

  /** The app's status update (`setAppointmentStatus`). Resolves to the rows it changed. */
  async function setStatus(caller: Caller, appointmentId: string, status: Status) {
    const rows = await as(
      caller,
      `update public.appointment set appointment_status = $2
        where appointment_id = $1
        returning appointment_id`,
      [appointmentId, status],
    )
    return rows.length
  }

  async function statusOf(appointmentId: string): Promise<string> {
    const [row] = await database.asService<{ status: string }>(
      'select appointment_status::text as status from public.appointment where appointment_id = $1',
      [appointmentId],
    )
    return row!.status
  }

  /** The message and SQLSTATE of a write that must be refused. */
  async function refusal(attempt: Promise<unknown>): Promise<{ message: string; code: unknown }> {
    try {
      await attempt
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown }).code,
      }
    }
    throw new Error('Expected the write to be refused, but it went through')
  }

  /** Everything a refused write must leave exactly as it was. */
  async function snapshot(appointmentId: string) {
    const [appointment] = await database.asService<{ row: unknown }>(
      'select to_jsonb(a) as row from public.appointment a where appointment_id = $1',
      [appointmentId],
    )
    const requests = await database.asService(
      `select to_jsonb(r) as row from public.reschedule_request r
        where appointment_id = $1 order by reschedule_request_id`,
      [appointmentId],
    )
    const notifications = await database.asService(
      'select to_jsonb(n) as row from public.notification n order by notification_id',
    )
    return { appointment: appointment!.row, requests, notifications }
  }

  async function dispatch(leadHours = 24): Promise<number> {
    const [row] = await database.asService<{ n: number }>(
      'select public.dispatch_appointment_reminders($1) as n',
      [leadHours],
    )
    return Number(row!.n)
  }

  async function requestReschedule(appointmentId: string, hoursAway: number): Promise<string> {
    const [row] = await database.asUser<{ reschedule_request_id: string }>(
      fx.aliceUserId,
      `insert into public.reschedule_request
         (appointment_id, user_id, reschedule_request_date, reschedule_request_reason)
       values ($1, $2, now() + make_interval(hours => $3), 'Work commitment')
       returning reschedule_request_id`,
      [appointmentId, fx.aliceUserId, hoursAway],
    )
    return row!.reschedule_request_id
  }

  function decide(requestId: string, decision: 'approved' | 'declined') {
    return database.asUser(
      fx.doctorAUserId,
      `update public.reschedule_request
          set reschedule_request_status = $2
        where reschedule_request_id = $1`,
      [requestId, decision],
    )
  }

  async function cancellationNotices(): Promise<{ user_id: string }[]> {
    return database.asService(
      `select user_id from public.notification
        where notification_message like '%has been cancelled.'`,
    )
  }

  // --- What stays allowed -----------------------------------------------------

  describe('allows', () => {
    it.each<[Status, Status, Caller]>([
      ['scheduled', 'confirmed', 'patient'],
      ['scheduled', 'confirmed', 'doctor'],
      ['scheduled', 'cancelled', 'patient'],
      ['scheduled', 'cancelled', 'doctor'],
      ['confirmed', 'cancelled', 'patient'],
      ['confirmed', 'cancelled', 'doctor'],
      ['scheduled', 'completed', 'doctor'],
      ['scheduled', 'no_show', 'doctor'],
      ['confirmed', 'completed', 'doctor'],
      ['confirmed', 'no_show', 'doctor'],
      ['confirmed', 'scheduled', 'doctor'],
      ['no_show', 'completed', 'doctor'],
      ['no_show', 'completed', 'service'],
    ])('%s → %s by the %s', async (from, to, caller) => {
      const id = await appointmentIn(12, from)

      expect(await setStatus(caller, id, to)).toBe(1)
      expect(await statusOf(id)).toBe(to)
    })

    it.each(
      CLOSED.flatMap((status) =>
        (['patient', 'doctor', 'service'] as const).map(
          (caller) => [status, status, caller] as [Closed, Closed, Caller],
        ),
      ),
    )('%s → %s by the %s, which changes nothing', async (from, to, caller) => {
      // Not a change of status, so not refused: a repeated "cancel" from a
      // client that retried stays a harmless no-op.
      const id = await appointmentIn(12, from)
      const before = await snapshot(id)

      expect(await setStatus(caller, id, to)).toBe(1)

      expect(await snapshot(id)).toEqual(before)
    })
  })

  // --- What is refused --------------------------------------------------------

  describe('refuses', () => {
    const refused: [Closed, Status, Caller][] = []
    for (const from of CLOSED) {
      for (const to of STATUSES) {
        if (to === from || (from === 'no_show' && to === 'completed')) continue
        for (const caller of ['patient', 'doctor', 'service'] as const) {
          refused.push([from, to, caller])
        }
      }
    }
    // The clinician's correction is the clinician's: not the patient's.
    refused.push(['no_show', 'completed', 'patient'])

    it.each(refused)('%s → %s by the %s', async (from, to, caller) => {
      // Future and inside the reminder window, with a reschedule request
      // raised while it was still open — so a reopening would show up in the
      // reminder job and in the request as well as in the row.
      const id = await appointmentIn(12, from)
      await database.asService(
        `insert into public.reschedule_request
           (appointment_id, user_id, reschedule_request_date)
         values ($1, $2, now() + interval '30 hours')`,
        [id, fx.aliceUserId],
      )
      const before = await snapshot(id)

      const error = await refusal(setStatus(caller, id, to))

      expect(error.message).toBe(REFUSED[from])
      expect(error.code).toBe('42501')
      // Row, reminder guard, reschedule request and notifications untouched.
      expect(await snapshot(id)).toEqual(before)
      // And still nothing the reminder job will pick up.
      expect(await dispatch()).toBe(0)
      expect(await snapshot(id)).toEqual(before)
    })

    it('cannot be got round by sending other columns with the status', async () => {
      const id = await appointmentIn(12, 'cancelled')
      const before = await snapshot(id)

      const doctor = await refusal(
        database.asUser(
          fx.doctorAUserId,
          `update public.appointment
              set appointment_status = 'scheduled',
                  appointment_date = appointment_date + interval '1 day',
                  appointment_reminder_sent_at = null
            where appointment_id = $1`,
          [id],
        ),
      )
      const patient = await refusal(
        database.asUser(
          fx.aliceUserId,
          `update public.appointment
              set appointment_status = 'confirmed',
                  appointment_reminder_sent_at = null
            where appointment_id = $1`,
          [id],
        ),
      )

      expect(doctor.message).toBe(REFUSED.cancelled)
      expect(patient.message).toBe(REFUSED.cancelled)
      expect(await snapshot(id)).toEqual(before)
    })

    it('leaves everyone else where RLS already left them', async () => {
      const id = await appointmentIn(12, 'cancelled')
      const before = await snapshot(id)

      // Another patient of the same doctor, another doctor, a deactivated
      // doctor and the administrator match no row; anonymous is refused.
      for (const outsider of [fx.bobUserId, fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId]) {
        expect(
          await database.asUser(
            outsider,
            `update public.appointment set appointment_status = 'scheduled'
              where appointment_id = $1 returning appointment_id`,
            [id],
          ),
        ).toEqual([])
      }
      await expect(
        database.asAnon(
          `update public.appointment set appointment_status = 'scheduled'
            where appointment_id = $1`,
          [id],
        ),
      ).rejects.toThrow()

      expect(await snapshot(id)).toEqual(before)
    })
  })

  // --- Flows that must keep working -------------------------------------------

  describe('keeps the existing flows', () => {
    it.each<[Status]>([['scheduled'], ['confirmed']])(
      'F-01: approving a reschedule of a %s appointment moves it and clears the reminder guard',
      async (status) => {
        const id = await appointmentIn(12, status)
        expect(await dispatch()).toBe(2)

        const [before] = await database.asService<{ at: string }>(
          'select appointment_date::text as at from public.appointment where appointment_id = $1',
          [id],
        )
        await decide(await requestReschedule(id, 20), 'approved')

        const [after] = await database.asService<{ at: string; status: string; stamped: boolean }>(
          `select appointment_date::text as at, appointment_status::text as status,
                  appointment_reminder_sent_at is not null as stamped
             from public.appointment where appointment_id = $1`,
          [id],
        )
        expect(after!.at).not.toBe(before!.at)
        expect(after!.status).toBe('scheduled')
        expect(after!.stamped).toBe(false)
        // Reminded once at the new time, and only once.
        expect(await dispatch()).toBe(2)
        expect(await dispatch()).toBe(0)
      },
    )

    it.each<[Status, Caller]>([
      ['scheduled', 'patient'],
      ['confirmed', 'doctor'],
    ])('F-02: %s → cancelled by the %s still sends exactly one pair', async (status, caller) => {
      const id = await appointmentIn(12, status)

      expect(await setStatus(caller, id, 'cancelled')).toBe(1)
      const pair = (await cancellationNotices()).map((row) => row.user_id).sort()
      expect(pair).toEqual([fx.aliceUserId, fx.doctorAUserId].sort())

      // It cannot be reopened, so it cannot be cancelled a second time.
      for (const [by, to] of [
        ['patient', 'confirmed'],
        ['doctor', 'scheduled'],
        ['service', 'confirmed'],
      ] as [Caller, Status][]) {
        expect((await refusal(setStatus(by, id, to))).message).toBe(REFUSED.cancelled)
      }
      expect(await setStatus(caller, id, 'cancelled')).toBe(1)

      expect(await cancellationNotices()).toHaveLength(2)
      expect(await dispatch()).toBe(0)
    })

    it('a reschedule of a cancelled appointment is still refused, and reopening it is no way round', async () => {
      const id = await appointmentIn(12, 'scheduled')
      const requestId = await requestReschedule(id, 20)
      await setStatus('patient', id, 'cancelled')

      // Migration 17, unchanged.
      await expect(decide(requestId, 'approved')).rejects.toThrow(/no longer active/)
      // The detour that used to work: reopen it directly, then approve.
      expect((await refusal(setStatus('patient', id, 'confirmed'))).message).toBe(
        REFUSED.cancelled,
      )
      await expect(decide(requestId, 'approved')).rejects.toThrow(/no longer active/)

      // Declining is still the way out, and still works.
      await decide(requestId, 'declined')
      const [request] = await database.asService<{ status: string }>(
        'select reschedule_request_status::text as status from public.reschedule_request where reschedule_request_id = $1',
        [requestId],
      )
      expect(request!.status).toBe('declined')
      expect(await statusOf(id)).toBe('cancelled')
    })

    it('keeps the slot rule: a re-booked slot is not reopened, and stays single', async () => {
      const [slot] = await database.asService<{ at: string }>(
        `select (date_trunc('minute', now()) + interval '40 hours')::text as at`,
      )
      const book = () =>
        database.asUser<{ appointment_id: string }>(
          fx.doctorAUserId,
          `insert into public.appointment (pat_id, doc_id, appointment_date)
           values ($1, $2, $3::timestamptz) returning appointment_id`,
          [fx.alicePatId, fx.doctorAId, slot!.at],
        )

      const [first] = await book()
      await setStatus('doctor', first!.appointment_id, 'cancelled')
      // Cancelling frees the slot, as before.
      const [second] = await book()
      expect(second!.appointment_id).toBeTruthy()

      // The cancelled one is refused as closed — before the slot rule is
      // even reached.
      expect((await refusal(setStatus('patient', first!.appointment_id, 'confirmed'))).message).toBe(
        REFUSED.cancelled,
      )
      // And the slot still holds only one live appointment.
      await expect(book()).rejects.toThrow(/appointment_one_active_per_slot/)
    })

    it('keeps the dashboard count honest: a cancelled appointment does not come back as upcoming', async () => {
      const upcoming = async () => {
        const [row] = await database.asUser<{ stats: { appointments: { upcoming: number } } }>(
          fx.adminUserId,
          'select public.admin_dashboard_stats() as stats',
        )
        return Number(row!.stats.appointments.upcoming)
      }
      const id = await appointmentIn(12, 'cancelled')
      const before = await upcoming()

      await refusal(setStatus('patient', id, 'confirmed'))
      await refusal(setStatus('doctor', id, 'scheduled'))

      expect(await upcoming()).toBe(before)
    })
  })

  // --- Security ---------------------------------------------------------------

  it('runs with the caller’s privileges and an empty search path, and is not callable directly', async () => {
    const [fn] = await database.asService<{
      definer: boolean
      config: string[] | null
      authenticated: boolean
      anon: boolean
    }>(
      `select p.prosecdef as definer,
              p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p
        where p.oid = 'public.appointment_guard_closed_status'::regproc`,
    )
    expect(fn!.definer).toBe(false)
    expect(fn!.config).toEqual(['search_path=""'])
    expect(fn!.authenticated).toBe(false)
    expect(fn!.anon).toBe(false)

    for (const caller of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asUser(caller, 'select public.appointment_guard_closed_status()'),
      ).rejects.toThrow()
    }
    await expect(
      database.asAnon('select public.appointment_guard_closed_status()'),
    ).rejects.toThrow()
  })

  it('fires before the status is written, only when a closed status would change', async () => {
    const [trigger] = await database.asService<{ definition: string }>(
      `select pg_get_triggerdef(oid) as definition
         from pg_trigger where tgname = 'appointment_guard_closed_status'`,
    )
    expect(trigger!.definition).toMatch(
      /BEFORE UPDATE OF appointment_status ON public\.appointment FOR EACH ROW WHEN/,
    )
  })
})
