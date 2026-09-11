import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The reminder mark is kept by the system.
 *
 * `appointment_reminder_sent_at` is the reminder job's duplicate guard. The
 * patient and their clinician could write it directly: clear it after each
 * hourly run to have the same reminder sent to both of them again, set it
 * early — or book with it already set — so that neither is reminded, or
 * rewrite it to any time at all.
 *
 * Only two things are meant to write it: the reminder job, and the
 * reschedule approval when it moves an appointment to a new time. Both are
 * database functions running as their owner, which is what the guard keys
 * on — not the caller's session, which inside the approval is the clinician.
 */
describe('appointment reminder mark', () => {
  const MESSAGE =
    'appointment_reminder_sent_at is managed by the system and cannot be changed directly'
  const A = '2026-09-01 00:00:00+00'
  const B = '2030-01-01 00:00:00+00'
  type Caller = 'patient' | 'doctor'
  const CALLERS: Caller[] = ['patient', 'doctor']

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
    return database.asUser(
      caller === 'patient' ? fx.aliceUserId : fx.doctorAUserId,
      sql,
      params,
    )
  }

  /** The Data API with the service key: the service_role role, which RLS does not restrain. */
  async function asServiceRole(sql: string, params: unknown[] = []) {
    await database.db.exec('begin')
    try {
      await database.db.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ role: 'service_role' }),
      ])
      await database.db.exec('set local role service_role')
      const result = await database.db.query(sql, params)
      await database.db.exec('commit')
      return result.rows
    } catch (error) {
      await database.db.exec('rollback')
      throw error
    }
  }

  /** An appointment for Alice under doctorA, `hoursAway` from now. */
  async function appointmentIn(
    hoursAway: number,
    mark: string | null = null,
    status = 'scheduled',
  ): Promise<string> {
    const [row] = await database.asService<{ appointment_id: string }>(
      `insert into public.appointment
         (pat_id, doc_id, appointment_date, appointment_status, appointment_reminder_sent_at)
       values ($1, $2, now() + make_interval(hours => $3), $4, $5::timestamptz)
       returning appointment_id`,
      [fx.alicePatId, fx.doctorAId, hoursAway, status, mark],
    )
    return row!.appointment_id
  }

  function setMark(caller: Caller, appointmentId: string, value: string | null) {
    return as(
      caller,
      `update public.appointment set appointment_reminder_sent_at = $2::timestamptz
        where appointment_id = $1 returning appointment_id`,
      [appointmentId, value],
    )
  }

  async function markOf(appointmentId: string): Promise<string | null> {
    const [row] = await database.asService<{ mark: string | null }>(
      `select appointment_reminder_sent_at::text as mark
         from public.appointment where appointment_id = $1`,
      [appointmentId],
    )
    return row!.mark
  }

  async function statusOf(appointmentId: string): Promise<string> {
    const [row] = await database.asService<{ status: string }>(
      'select appointment_status::text as status from public.appointment where appointment_id = $1',
      [appointmentId],
    )
    return row!.status
  }

  async function appointmentCount(): Promise<number> {
    const [row] = await database.asService<{ count: number }>(
      'select count(*)::int as count from public.appointment',
    )
    return Number(row!.count)
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
    const notifications = await database.asService(
      'select to_jsonb(n) as row from public.notification n order by notification_id',
    )
    return { appointment: appointment!.row, appointments: await appointmentCount(), notifications }
  }

  async function dispatch(leadHours = 24): Promise<number> {
    const [row] = await database.asService<{ n: number }>(
      'select public.dispatch_appointment_reminders($1) as n',
      [leadHours],
    )
    return Number(row!.n)
  }

  async function reminderCount(): Promise<number> {
    const [row] = await database.asService<{ count: number }>(
      `select count(*)::int as count from public.notification
        where notification_message not like '%has been cancelled.'`,
    )
    return Number(row!.count)
  }

  /** The patient asks for a new time and the clinician approves it, as the app does. */
  async function rescheduleTo(appointmentId: string, at: string) {
    const [request] = await database.asUser<{ reschedule_request_id: string }>(
      fx.aliceUserId,
      `insert into public.reschedule_request
         (appointment_id, user_id, reschedule_request_date)
       values ($1, $2, $3::timestamptz) returning reschedule_request_id`,
      [appointmentId, fx.aliceUserId, at],
    )
    await database.asUser(
      fx.doctorAUserId,
      `update public.reschedule_request set reschedule_request_status = 'approved'
        where reschedule_request_id = $1`,
      [request!.reschedule_request_id],
    )
  }

  async function timeFromNow(interval: string): Promise<string> {
    const [row] = await database.asService<{ at: string }>(
      'select (now() + $1::interval)::text as at',
      [interval],
    )
    return row!.at
  }

  const upsert = (caller: Caller, appointmentId: string, mark: string | null) =>
    as(
      caller,
      `insert into public.appointment
         (appointment_id, pat_id, doc_id, appointment_date, appointment_reminder_sent_at)
       values ($1, $2, $3, now() + interval '20 hours', $4::timestamptz)
       on conflict (appointment_id)
       do update set appointment_reminder_sent_at = excluded.appointment_reminder_sent_at`,
      [appointmentId, fx.alicePatId, fx.doctorAId, mark],
    )

  // --- Direct changes ---------------------------------------------------------

  describe('refuses a direct change', () => {
    it.each(
      CALLERS.flatMap((caller) => [
        [caller, 'NULL → a timestamp', null, B],
        [caller, 'a timestamp → NULL', A, null],
        [caller, 'one timestamp → another', A, B],
      ] as [Caller, string, string | null, string | null][]),
    )('by the %s: %s', async (caller, _change, from, to) => {
      const id = await appointmentIn(12, from)
      const before = await snapshot(id)

      expect(await refusal(setMark(caller, id, to))).toEqual({
        message: MESSAGE,
        code: '42501',
      })
      expect(await snapshot(id)).toEqual(before)
    })

    it.each(CALLERS)(
      'but lets the %s write the value it already holds, which changes nothing',
      async (caller) => {
        const id = await appointmentIn(12, A)
        const before = await snapshot(id)

        const rows = await as(
          caller,
          `update public.appointment
              set appointment_reminder_sent_at = appointment_reminder_sent_at
            where appointment_id = $1 returning appointment_id`,
          [id],
        )

        expect(rows).toHaveLength(1)
        expect(await snapshot(id)).toEqual(before)
      },
    )
  })

  // --- Bypass shapes ------------------------------------------------------------

  describe('cannot be got round by', () => {
    it.each<[Caller, string, string]>([
      ['patient', 'the status', `appointment_status = 'confirmed'`],
      ['patient', 'the unchanged status', 'appointment_status = appointment_status'],
      ['patient', 'the created time', 'appointment_created_at = appointment_created_at'],
      ['patient', 'the date', `appointment_date = appointment_date + interval '1 hour'`],
      ['doctor', 'the status', `appointment_status = 'confirmed'`],
      ['doctor', 'the unchanged status', 'appointment_status = appointment_status'],
      ['doctor', 'the created time', 'appointment_created_at = appointment_created_at'],
      ['doctor', 'the date', `appointment_date = appointment_date + interval '1 hour'`],
    ])('the %s changing %s in the same update', async (caller, _what, set) => {
      const id = await appointmentIn(12, A)
      const before = await snapshot(id)

      const error = await refusal(
        as(
          caller,
          `update public.appointment
              set ${set}, appointment_reminder_sent_at = null
            where appointment_id = $1`,
          [id],
        ),
      )

      expect(error).toEqual({ message: MESSAGE, code: '42501' })
      // The whole update is refused, not just the mark.
      expect(await snapshot(id)).toEqual(before)
    })

    it.each(CALLERS)('the %s booking an appointment with the mark already set', async (caller) => {
      const before = await appointmentCount()

      const error = await refusal(
        as(
          caller,
          `insert into public.appointment
             (pat_id, doc_id, appointment_date, appointment_reminder_sent_at)
           values ($1, $2, now() + interval '12 hours', now())`,
          [fx.alicePatId, fx.doctorAId],
        ),
      )

      expect(error).toEqual({ message: MESSAGE, code: '42501' })
      expect(await appointmentCount()).toBe(before)
    })

    it.each(CALLERS)('the %s upserting a row to set the mark', async (caller) => {
      const id = await appointmentIn(12)
      const before = await snapshot(id)

      expect(await refusal(upsert(caller, id, B))).toEqual({ message: MESSAGE, code: '42501' })
      expect(await snapshot(id)).toEqual(before)
    })

    it.each(CALLERS)('the %s upserting a row to clear the mark', async (caller) => {
      const id = await appointmentIn(12, A)
      const before = await snapshot(id)

      expect(await refusal(upsert(caller, id, null))).toEqual({ message: MESSAGE, code: '42501' })
      expect(await snapshot(id)).toEqual(before)
    })

    it('anyone the access rules already stop', async () => {
      const id = await appointmentIn(12, A)
      const before = await snapshot(id)

      // Another patient of the same doctor, another doctor, a deactivated
      // doctor and the administrator match no row; anonymous is refused.
      for (const outsider of [fx.bobUserId, fx.doctorBUserId, fx.doctorCUserId, fx.adminUserId]) {
        expect(
          await database.asUser(
            outsider,
            `update public.appointment set appointment_reminder_sent_at = null
              where appointment_id = $1 returning appointment_id`,
            [id],
          ),
        ).toEqual([])
      }
      await expect(
        database.asAnon(
          `update public.appointment set appointment_reminder_sent_at = null
            where appointment_id = $1`,
          [id],
        ),
      ).rejects.toThrow()

      expect(await snapshot(id)).toEqual(before)
    })
  })

  it.each(CALLERS)('still lets the %s book the way the app does — no mark, or a NULL one', async (caller) => {
    const omitted = await as(
      caller,
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, now() + interval '30 hours') returning appointment_id`,
      [fx.alicePatId, fx.doctorAId],
    )
    const explicitNull = await as(
      caller,
      `insert into public.appointment
         (pat_id, doc_id, appointment_date, appointment_reminder_sent_at)
       values ($1, $2, now() + interval '31 hours', null) returning appointment_id`,
      [fx.alicePatId, fx.doctorAId],
    )

    expect(omitted).toHaveLength(1)
    expect(explicitNull).toHaveLength(1)
  })

  // --- Legitimate writers -----------------------------------------------------------

  describe('still lets the system keep it', () => {
    it('the reminder job sets it, once', async () => {
      const id = await appointmentIn(12)

      expect(await dispatch()).toBe(2)
      expect(await markOf(id)).not.toBeNull()
      expect(await dispatch()).toBe(0)
    })

    it('F-01: approving a move to a new time clears it, and the new time is reminded once', async () => {
      const id = await appointmentIn(12)
      expect(await dispatch()).toBe(2)

      await rescheduleTo(id, await timeFromNow('20 hours'))

      expect(await markOf(id)).toBeNull()
      expect(await dispatch()).toBe(2)
      expect(await dispatch()).toBe(0)
    })

    it('F-01: approving the same time keeps it', async () => {
      const id = await appointmentIn(12)
      await dispatch()
      const mark = await markOf(id)
      const [row] = await database.asService<{ at: string }>(
        'select appointment_date::text as at from public.appointment where appointment_id = $1',
        [id],
      )

      await rescheduleTo(id, row!.at)

      expect(await markOf(id)).toBe(mark)
      expect(await dispatch()).toBe(0)
    })

    it('the service key can still write it', async () => {
      const id = await appointmentIn(12, A)

      await asServiceRole(
        'update public.appointment set appointment_reminder_sent_at = null where appointment_id = $1',
        [id],
      )
      expect(await markOf(id)).toBeNull()
      await asServiceRole(
        'update public.appointment set appointment_reminder_sent_at = $2::timestamptz where appointment_id = $1',
        [id, B],
      )
      expect(await markOf(id)).not.toBeNull()
    })

    it('the owner (postgres) can still write it', async () => {
      const id = await appointmentIn(12, A)

      await database.asService(
        'update public.appointment set appointment_reminder_sent_at = null where appointment_id = $1',
        [id],
      )
      expect(await markOf(id)).toBeNull()
      await database.asService(
        'update public.appointment set appointment_reminder_sent_at = $2::timestamptz where appointment_id = $1',
        [id, B],
      )
      expect(await markOf(id)).not.toBeNull()
    })
  })

  // --- The attacks it was open to ---------------------------------------------------

  describe('closes the attacks it was open to', () => {
    it.each(CALLERS)('the %s clearing it after the reminder cannot cause a second one', async (caller) => {
      const id = await appointmentIn(12)
      expect(await dispatch()).toBe(2)
      const legitimate = await markOf(id)

      expect((await refusal(setMark(caller, id, null))).code).toBe('42501')

      expect(await markOf(id)).toBe(legitimate)
      expect(await dispatch()).toBe(0)
      expect(await reminderCount()).toBe(2)
    })

    it.each(CALLERS)('the %s setting it early cannot suppress the reminder', async (caller) => {
      const id = await appointmentIn(12)

      expect((await refusal(setMark(caller, id, B))).code).toBe('42501')

      expect(await markOf(id)).toBeNull()
      expect(await dispatch()).toBe(2)
      expect(await dispatch()).toBe(0)
    })

    it.each(CALLERS)('the %s booking with it set cannot suppress the first reminder', async (caller) => {
      const error = await refusal(
        as(
          caller,
          `insert into public.appointment
             (pat_id, doc_id, appointment_date, appointment_reminder_sent_at)
           values ($1, $2, now() + interval '12 hours', now())`,
          [fx.alicePatId, fx.doctorAId],
        ),
      )

      expect(error.code).toBe('42501')
      expect(await appointmentCount()).toBe(0)
    })

    it.each(CALLERS)('the %s changing it with other columns has the whole update refused', async (caller) => {
      const id = await appointmentIn(12, A)

      await refusal(
        as(
          caller,
          `update public.appointment
              set appointment_status = 'confirmed', appointment_reminder_sent_at = null
            where appointment_id = $1`,
          [id],
        ),
      )

      expect(await statusOf(id)).toBe('scheduled')
      expect(await markOf(id)).not.toBeNull()
    })
  })

  // --- Everything else about appointments ---------------------------------------

  describe('leaves the other appointment rules as they were', () => {
    it('F-02: a cancellation still sends one pair and leaves the mark alone', async () => {
      const id = await appointmentIn(12)
      await dispatch()
      const mark = await markOf(id)

      await as(
        'patient',
        `update public.appointment set appointment_status = 'cancelled' where appointment_id = $1`,
        [id],
      )

      const notices = await database.asService<{ user_id: string }>(
        `select user_id from public.notification
          where notification_message like '%has been cancelled.'`,
      )
      expect(notices.map((row) => row.user_id).sort()).toEqual(
        [fx.aliceUserId, fx.doctorAUserId].sort(),
      )
      expect(await markOf(id)).toBe(mark)
    })

    it('the closed-status guard still refuses reopening, and allows the no-show correction', async () => {
      const cancelled = await appointmentIn(12, null, 'cancelled')
      const reopen = await refusal(
        as(
          'patient',
          `update public.appointment set appointment_status = 'confirmed' where appointment_id = $1`,
          [cancelled],
        ),
      )
      expect(reopen.message).toMatch(/has already been cancelled/)

      const noShow = await appointmentIn(13, null, 'no_show')
      expect(
        await as(
          'doctor',
          `update public.appointment set appointment_status = 'completed'
            where appointment_id = $1 returning appointment_id`,
          [noShow],
        ),
      ).toHaveLength(1)
    })
  })

  // --- Security -------------------------------------------------------------------

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
        where p.oid = 'public.appointment_guard_reminder_mark'::regproc`,
    )
    expect(fn!.definer).toBe(false)
    expect(fn!.config).toEqual(['search_path=""'])
    expect(fn!.authenticated).toBe(false)
    expect(fn!.anon).toBe(false)

    for (const caller of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asUser(caller, 'select public.appointment_guard_reminder_mark()'),
      ).rejects.toThrow()
    }
    await expect(
      database.asAnon('select public.appointment_guard_reminder_mark()'),
    ).rejects.toThrow()
  })

  it('guards inserts and updates of the mark', async () => {
    const [trigger] = await database.asService<{ definition: string }>(
      `select pg_get_triggerdef(oid) as definition
         from pg_trigger where tgname = 'appointment_guard_reminder_mark'`,
    )
    expect(trigger!.definition).toMatch(
      /BEFORE INSERT OR UPDATE OF appointment_reminder_sent_at ON public\.appointment FOR EACH ROW EXECUTE FUNCTION appointment_guard_reminder_mark\(\)/,
    )
  })
})
