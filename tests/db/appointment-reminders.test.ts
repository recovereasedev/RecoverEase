import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 6.5 — upcoming appointment reminders.
 *
 * A scheduler fires this hourly and unattended, so the properties worth
 * testing are not "does it send a reminder" but "does it send exactly one
 * pair, only for appointments that are still going to happen, only inside
 * the lead window, only to the two people involved, and never twice however
 * often it runs".
 */
describe('appointment reminders', () => {
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
    // Each test reasons about counts, so start from no notifications and no
    // appointment that could fall inside the window on its own.
    await database.asService('delete from public.notification')
    await database.asService('delete from public.appointment')
  })

  /** An appointment `hoursAway` from now, for Alice under doctorA. */
  async function appointmentIn(
    hoursAway: number,
    status = 'scheduled',
  ): Promise<string> {
    const [row] = await database.asService<{ appointment_id: string }>(
      `insert into public.appointment
         (pat_id, doc_id, appointment_date, appointment_status)
       values ($1, $2, now() + make_interval(hours => $3), $4)
       returning appointment_id`,
      [fx.alicePatId, fx.doctorAId, hoursAway, status],
    )
    return row!.appointment_id
  }

  async function dispatch(leadHours = 24): Promise<number> {
    const [row] = await database.asService<{
      dispatch_appointment_reminders: number
    }>('select public.dispatch_appointment_reminders($1)', [leadHours])
    return Number(row!.dispatch_appointment_reminders)
  }

  async function notificationsFor(userId: string): Promise<string[]> {
    const rows = await database.asService<{ notification_message: string }>(
      `select notification_message from public.notification
        where user_id = $1 and notification_type = 'appointment'`,
      [userId],
    )
    return rows.map((r) => r.notification_message)
  }

  it('tells both the clinician and the patient about a scheduled appointment', async () => {
    await appointmentIn(12)

    expect(await dispatch()).toBe(2)

    const doctor = await notificationsFor(fx.doctorAUserId)
    const patient = await notificationsFor(fx.aliceUserId)
    expect(doctor).toHaveLength(1)
    expect(patient).toHaveLength(1)
  })

  it('does the same for a confirmed appointment', async () => {
    // 'confirmed' is still going to happen, so it is still worth a reminder.
    await appointmentIn(12, 'confirmed')

    expect(await dispatch()).toBe(2)
    expect(await notificationsFor(fx.doctorAUserId)).toHaveLength(1)
    expect(await notificationsFor(fx.aliceUserId)).toHaveLength(1)
  })

  it.each(['cancelled', 'completed', 'no_show'])(
    'says nothing about a %s appointment',
    async (status) => {
      // Settled appointments. Reminding anyone about one of these is worse
      // than saying nothing.
      await appointmentIn(12, status)

      expect(await dispatch()).toBe(0)
      expect(await notificationsFor(fx.doctorAUserId)).toHaveLength(0)
      expect(await notificationsFor(fx.aliceUserId)).toHaveLength(0)
    },
  )

  it('goes quiet once the clinician cancels it', async () => {
    // QA-03. Before the doctor had a Cancel button, an appointment the
    // patient had called off by phone stayed 'scheduled', and this job then
    // reminded both of them about a visit that was not going to happen. The
    // cancellation is written by the doctor, under RLS, exactly as the
    // client's `setAppointmentStatus` writes it.
    const id = await appointmentIn(12)

    await database.asUser(
      fx.doctorAUserId,
      `update public.appointment set appointment_status = 'cancelled'
        where appointment_id = $1`,
      [id],
    )

    const [row] = await database.asService<{ appointment_status: string }>(
      'select appointment_status from public.appointment where appointment_id = $1',
      [id],
    )
    // The doctor's own update was allowed — no separate endpoint needed.
    expect(row!.appointment_status).toBe('cancelled')

    expect(await dispatch()).toBe(0)
    expect(await notificationsFor(fx.doctorAUserId)).toHaveLength(0)
    expect(await notificationsFor(fx.aliceUserId)).toHaveLength(0)
  })

  it('sends nothing further when the cancellation follows the reminder', async () => {
    // The other order: the reminder has already gone out and the doctor
    // cancels afterwards. Neither party may be reminded a second time.
    const id = await appointmentIn(12)
    expect(await dispatch()).toBe(2)

    await database.asUser(
      fx.doctorAUserId,
      `update public.appointment set appointment_status = 'cancelled'
        where appointment_id = $1`,
      [id],
    )

    expect(await dispatch()).toBe(0)
    expect(await notificationsFor(fx.doctorAUserId)).toHaveLength(1)
    expect(await notificationsFor(fx.aliceUserId)).toHaveLength(1)
  })

  it('does not duplicate when the hourly job runs again', async () => {
    // The whole point of the guard: the scheduler fires every hour and an
    // appointment sits inside a 24-hour window for 24 of them.
    await appointmentIn(12)

    expect(await dispatch()).toBe(2)
    expect(await dispatch()).toBe(0)
    expect(await dispatch()).toBe(0)

    expect(await notificationsFor(fx.doctorAUserId)).toHaveLength(1)
    expect(await notificationsFor(fx.aliceUserId)).toHaveLength(1)
  })

  it('stamps the appointment so the guard is visible in the row', async () => {
    const id = await appointmentIn(12)
    await dispatch()

    const [row] = await database.asService<{ stamped: boolean }>(
      `select appointment_reminder_sent_at is not null as stamped
         from public.appointment where appointment_id = $1`,
      [id],
    )
    expect(row!.stamped).toBe(true)
  })

  it('waits until the appointment is inside the lead window', async () => {
    // Three days out. An hourly job must not reach forward and remind now.
    await appointmentIn(72)
    expect(await dispatch(24)).toBe(0)

    // Same appointment, a window wide enough to include it.
    expect(await dispatch(96)).toBe(2)
  })

  it('decides the window on the stored instant, not on the clinic timezone', async () => {
    // The reminder window compares two timestamptz values — the stored
    // appointment instant against now() — so it is an absolute comparison.
    // `app.timezone` is used only to format the message. This pins that: the
    // same two appointments either side of the boundary must be included and
    // excluded identically whatever the clinic zone is, or an appointment
    // near 24 hours out would be reminded twice in one zone and never in
    // another.
    async function boundaryUnder(zone: string) {
      await database.asService(
        `insert into public.system_setting (system_setting_key, system_setting_value)
         values ('app.timezone', $1)
         on conflict (system_setting_key)
         do update set system_setting_value = excluded.system_setting_value`,
        [zone],
      )
      await database.asService('delete from public.notification')
      await database.asService('delete from public.appointment')

      // Just inside the boundary, and just outside it.
      const inside = await database.asService<{ appointment_id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '23 hours 59 minutes')
         returning appointment_id`,
        [fx.alicePatId, fx.doctorAId],
      )
      await database.asService(
        `insert into public.appointment (pat_id, doc_id, appointment_date)
         values ($1, $2, now() + interval '24 hours 1 minute')`,
        [fx.alicePatId, fx.doctorAId],
      )

      const created = await dispatch(24)
      const [stamped] = await database.asService<{ stamped: boolean }>(
        `select appointment_reminder_sent_at is not null as stamped
           from public.appointment where appointment_id = $1`,
        [inside[0]!.appointment_id],
      )
      return { created, insideWasStamped: stamped!.stamped }
    }

    // UTC+14 and UTC-11: 25 hours apart, far more than any boundary error.
    const kiritimati = await boundaryUnder('Pacific/Kiritimati')
    const midway = await boundaryUnder('Pacific/Midway')
    const manila = await boundaryUnder('Asia/Manila')

    // Exactly one appointment in range each time — the 23:59 one — and never
    // the 24:01 one, in every zone.
    for (const result of [kiritimati, midway, manila]) {
      expect(result.created).toBe(2)
      expect(result.insideWasStamped).toBe(true)
    }

    // `app.timezone` is shared state and was unset before this ran — the
    // dispatcher falls back to UTC when the row is absent. Put it back, so a
    // test added after this one does not silently inherit a clinic zone.
    await database.asService(
      `delete from public.system_setting where system_setting_key = 'app.timezone'`,
    )
  })

  it('never chases an appointment that has already passed', async () => {
    // Left behind as 'scheduled' because nobody marked it. A reminder for a
    // visit that has been and gone is noise at best.
    await appointmentIn(-2)
    expect(await dispatch()).toBe(0)
  })

  it('reminds only the two people involved', async () => {
    await appointmentIn(12)
    await dispatch()

    // Not the other clinician, not another patient of the same clinician,
    // and not the administrator.
    for (const outsider of [fx.doctorBUserId, fx.bobUserId, fx.adminUserId]) {
      expect(await notificationsFor(outsider)).toHaveLength(0)
    }
  })

  it('keeps the patient’s reminder free of clinical or personal detail', async () => {
    await appointmentIn(12)
    await dispatch()

    const [message] = await notificationsFor(fx.aliceUserId)
    // A time and a date. No name, no condition, no clinician.
    expect(message).toMatch(/^You have an upcoming appointment on .+ at \d{2}:\d{2}\.$/)
    expect(message).not.toMatch(/Alice|Santos/i)
  })

  it('names the patient for the clinician, who already sees it everywhere', async () => {
    await appointmentIn(12)
    await dispatch()

    const [message] = await notificationsFor(fx.doctorAUserId)
    expect(message).toMatch(/^Upcoming appointment with .+ on .+ at \d{2}:\d{2}\.$/)
  })

  it('is not callable by a patient, a doctor, or an anonymous caller', async () => {
    // It writes notifications for other people. Only the scheduler runs it.
    await appointmentIn(12)

    for (const caller of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asUser(
          caller,
          'select public.dispatch_appointment_reminders(24)',
        ),
      ).rejects.toThrow()
    }
    await expect(
      database.asAnon('select public.dispatch_appointment_reminders(24)'),
    ).rejects.toThrow()
  })

  describe('after a reschedule', () => {
    // F-01. The duplicate guard is one timestamp on the appointment, and an
    // approved reschedule moves that same row to a new time. Before this was
    // fixed the guard survived the move: an appointment reminded about its
    // old time was never reminded about its new one, and both people were
    // left holding a notification with the wrong time on it.

    /** An instant `interval` from now, as the timestamptz text the client sends. */
    async function timeFromNow(interval: string): Promise<string> {
      const [row] = await database.asService<{ at: string }>(
        'select (now() + $1::interval)::text as at',
        [interval],
      )
      return row!.at
    }

    /** The patient asks for a new time, as `createRescheduleRequest` does, under RLS. */
    async function requestReschedule(
      appointmentId: string,
      proposedFor: string,
    ): Promise<string> {
      const [row] = await database.asUser<{ reschedule_request_id: string }>(
        fx.aliceUserId,
        `insert into public.reschedule_request
           (appointment_id, user_id, reschedule_request_date, reschedule_request_reason)
         values ($1, $2, $3::timestamptz, 'Work commitment')
         returning reschedule_request_id`,
        [appointmentId, fx.aliceUserId, proposedFor],
      )
      return row!.reschedule_request_id
    }

    /** The clinician approves, as `decideRescheduleRequest` does: the status only, under RLS. */
    async function approve(requestId: string): Promise<void> {
      await database.asUser(
        fx.doctorAUserId,
        `update public.reschedule_request
            set reschedule_request_status = 'approved'
          where reschedule_request_id = $1`,
        [requestId],
      )
    }

    async function rescheduleTo(appointmentId: string, proposedFor: string) {
      await approve(await requestReschedule(appointmentId, proposedFor))
    }

    /** The appointment as the dispatcher sees it, with its time as a reminder prints it. */
    async function appointmentRow(appointmentId: string) {
      const [row] = await database.asService<{
        appointment_date: string
        appointment_status: string
        stamped: boolean
        clock: string
      }>(
        `select appointment_date::text as appointment_date,
                appointment_status,
                appointment_reminder_sent_at is not null as stamped,
                to_char(
                  appointment_date at time zone coalesce(
                    (select system_setting_value from public.system_setting
                      where system_setting_key = 'app.timezone'),
                    'UTC'),
                  'HH24:MI') as clock
           from public.appointment where appointment_id = $1`,
        [appointmentId],
      )
      return row!
    }

    /** One person's appointment notifications, oldest first. */
    async function messagesFor(userId: string): Promise<string[]> {
      const rows = await database.asService<{ notification_message: string }>(
        `select notification_message from public.notification
          where user_id = $1 and notification_type = 'appointment'
          order by notification_created_at`,
        [userId],
      )
      return rows.map((row) => row.notification_message)
    }

    it('reminds the patient and the clinician again, at the new time', async () => {
      const id = await appointmentIn(12)
      expect(await dispatch()).toBe(2)

      const before = await appointmentRow(id)
      expect(before.stamped).toBe(true)
      expect(await messagesFor(fx.aliceUserId)).toHaveLength(1)
      expect(await messagesFor(fx.doctorAUserId)).toHaveLength(1)

      // Eight hours later: still inside the 24-hour window, at a new time.
      await rescheduleTo(id, await timeFromNow('20 hours'))

      const after = await appointmentRow(id)
      expect(after.appointment_date).not.toBe(before.appointment_date)
      expect(after.appointment_status).toBe('scheduled')
      expect(after.stamped).toBe(false)

      // The existing hourly job sends the reminder; the approval does not.
      expect(await dispatch()).toBe(2)
      expect((await appointmentRow(id)).stamped).toBe(true)

      const patient = await messagesFor(fx.aliceUserId)
      const doctor = await messagesFor(fx.doctorAUserId)
      expect(patient).toHaveLength(2)
      expect(doctor).toHaveLength(2)
      // The earlier notification is history and is kept; the new one names
      // the new time.
      expect(patient[0]).toContain(`at ${before.clock}.`)
      expect(patient[1]).toContain(`at ${after.clock}.`)
      expect(doctor[1]).toContain(`at ${after.clock}.`)
    })

    it('does the same for a confirmed appointment, which the move makes scheduled again', async () => {
      const id = await appointmentIn(12, 'confirmed')
      expect(await dispatch()).toBe(2)

      await rescheduleTo(id, await timeFromNow('20 hours'))

      const after = await appointmentRow(id)
      expect(after.appointment_status).toBe('scheduled')
      expect(after.stamped).toBe(false)
      expect(await dispatch()).toBe(2)
    })

    it('reminds once at the new time when the reschedule came before any reminder', async () => {
      const id = await appointmentIn(72)
      expect(await dispatch()).toBe(0)

      await rescheduleTo(id, await timeFromNow('20 hours'))

      expect(await dispatch()).toBe(2)
      expect(await dispatch()).toBe(0)
      const clock = (await appointmentRow(id)).clock
      expect(await messagesFor(fx.aliceUserId)).toEqual([
        expect.stringContaining(`at ${clock}.`),
      ])
      expect(await messagesFor(fx.doctorAUserId)).toHaveLength(1)
    })

    it('keeps the reminder guard when an approval leaves the time unchanged', async () => {
      // Nothing about the appointment moved, so the reminder already sent is
      // still the right one and must not be sent again.
      const id = await appointmentIn(12)
      expect(await dispatch()).toBe(2)
      const before = await appointmentRow(id)

      await rescheduleTo(id, before.appointment_date)

      const after = await appointmentRow(id)
      expect(after.appointment_date).toBe(before.appointment_date)
      expect(after.stamped).toBe(true)
      expect(await dispatch()).toBe(0)
      expect(await messagesFor(fx.aliceUserId)).toHaveLength(1)
      expect(await messagesFor(fx.doctorAUserId)).toHaveLength(1)
    })

    it.each(['cancelled', 'completed', 'no_show'])(
      'cannot revive a %s appointment, and leaves its reminder state alone',
      async (status) => {
        const id = await appointmentIn(12)
        expect(await dispatch()).toBe(2)
        // Asked for while it was still active, decided after it was settled.
        const requestId = await requestReschedule(id, await timeFromNow('20 hours'))
        await database.asService(
          'update public.appointment set appointment_status = $2 where appointment_id = $1',
          [id, status],
        )

        await expect(approve(requestId)).rejects.toThrow(/no longer active/)

        const after = await appointmentRow(id)
        expect(after.appointment_status).toBe(status)
        expect(after.stamped).toBe(true)
        expect(await dispatch()).toBe(0)
      },
    )

    it('does not duplicate the new-time reminder when the hourly job runs again', async () => {
      const id = await appointmentIn(12)
      expect(await dispatch()).toBe(2)
      await rescheduleTo(id, await timeFromNow('20 hours'))

      expect(await dispatch()).toBe(2)
      expect(await dispatch()).toBe(0)
      expect(await dispatch()).toBe(0)

      expect(await messagesFor(fx.aliceUserId)).toHaveLength(2)
      expect(await messagesFor(fx.doctorAUserId)).toHaveLength(2)
    })

    it('still reminds only the two people involved', async () => {
      const id = await appointmentIn(12)
      await dispatch()
      await rescheduleTo(id, await timeFromNow('20 hours'))
      await dispatch()

      for (const outsider of [fx.doctorBUserId, fx.bobUserId, fx.adminUserId]) {
        expect(await messagesFor(outsider)).toHaveLength(0)
      }
    })

    it('keeps the decision function a definer with an empty search path, not callable directly', async () => {
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
          where p.oid = 'public.reschedule_request_apply_decision'::regproc`,
      )
      expect(fn!.definer).toBe(true)
      expect(fn!.config).toEqual(['search_path=""'])
      expect(fn!.authenticated).toBe(false)
      expect(fn!.anon).toBe(false)
    })
  })
})
