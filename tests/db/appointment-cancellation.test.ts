import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * F-02 — cancelling an upcoming appointment tells both people.
 *
 * Cancellation used to change the status and nothing else. Nobody was told,
 * and when the reminder had already gone out both people were left with a
 * notification saying the appointment was still on. A trigger now writes one
 * notice to the patient and one to the appointment's doctor, in the same
 * transaction as the cancellation.
 *
 * What is worth pinning is less "a notice is sent" than everything around
 * it: exactly one pair, only on a real change into 'cancelled', only for an
 * appointment still ahead, only to those two people, and with the reminder
 * already sent and the reminder guard left exactly as they were.
 */
describe('appointment cancellation notifications', () => {
  const ZONE = 'Asia/Manila'

  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    // The clinic's zone in production. Expected wording below is built
    // independently of the database's own formatting, in this zone.
    await database.asService(
      `insert into public.system_setting (system_setting_key, system_setting_value)
       values ('app.timezone', $1)`,
      [ZONE],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    // Counts are the assertions, so every test starts from no notifications
    // and no appointments. Reschedule requests go with their appointments.
    await database.asService('delete from public.notification')
    await database.asService('delete from public.appointment')
  })

  // --- Helpers --------------------------------------------------------------

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

  /** Sets a status as a signed-in user, exactly as `setAppointmentStatus` does. */
  async function setStatusAs(
    userId: string,
    appointmentId: string,
    status: string,
  ): Promise<number> {
    const rows = await database.asUser(
      userId,
      `update public.appointment set appointment_status = $2
        where appointment_id = $1
        returning appointment_id`,
      [appointmentId, status],
    )
    return rows.length
  }

  const cancelAs = (userId: string, appointmentId: string) =>
    setStatusAs(userId, appointmentId, 'cancelled')

  async function dispatch(leadHours = 24): Promise<number> {
    const [row] = await database.asService<{
      dispatch_appointment_reminders: number
    }>('select public.dispatch_appointment_reminders($1)', [leadHours])
    return Number(row!.dispatch_appointment_reminders)
  }

  type NotificationRow = {
    notification_id: string
    user_id: string
    notification_type: string
    notification_message: string
    notification_is_read: boolean
    created: string
  }

  /** Every notification in the system, oldest first. */
  async function allNotifications(): Promise<NotificationRow[]> {
    return database.asService<NotificationRow>(
      `select notification_id, user_id, notification_type,
              notification_message, notification_is_read,
              notification_created_at::text as created
         from public.notification
        order by notification_created_at, notification_message`,
    )
  }

  async function cancellationNotices(): Promise<NotificationRow[]> {
    return (await allNotifications()).filter((row) =>
      row.notification_message.endsWith('has been cancelled.'),
    )
  }

  /** The appointment's instant and its reminder guard, exactly as stored. */
  async function appointmentRow(appointmentId: string) {
    const [row] = await database.asService<{
      epoch_ms: number
      status: string
      reminder_sent_at: string | null
    }>(
      `select (extract(epoch from appointment_date) * 1000)::float8 as epoch_ms,
              appointment_status as status,
              appointment_reminder_sent_at::text as reminder_sent_at
         from public.appointment where appointment_id = $1`,
      [appointmentId],
    )
    return row!
  }

  /**
   * "Saturday, 12 September" and "07:45" for an instant, in the clinic's
   * zone — the convention the reminder uses — built with Intl so the test
   * does not simply agree with the SQL it is checking.
   */
  function manila(epochMs: number): { date: string; time: string } {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(epochMs))
        .map((part) => [part.type, part.value]),
    )
    return {
      date: `${parts['weekday']}, ${parts['day']} ${parts['month']}`,
      time: `${parts['hour']}:${parts['minute']}`,
    }
  }

  async function expectedNotices(appointmentId: string) {
    const { date, time } = manila((await appointmentRow(appointmentId)).epoch_ms)
    return {
      patient: `Your appointment on ${date} at ${time} has been cancelled.`,
      doctor: `The appointment with Alice Santos on ${date} at ${time} has been cancelled.`,
    }
  }

  /** Exactly one pair: one notice each, to Alice and to doctorA, worded exactly. */
  async function expectOnePair(appointmentId: string) {
    const expected = await expectedNotices(appointmentId)
    const notices = await cancellationNotices()

    expect(notices).toHaveLength(2)
    expect(
      notices.map((n) => [n.user_id, n.notification_message]).sort(),
    ).toEqual(
      [
        [fx.aliceUserId, expected.patient],
        [fx.doctorAUserId, expected.doctor],
      ].sort(),
    )
    for (const notice of notices) {
      // The existing type, arriving unread like any other.
      expect(notice.notification_type).toBe('appointment')
      expect(notice.notification_is_read).toBe(false)
    }
  }

  /** The patient asks for a new time, as `createRescheduleRequest` does. */
  async function requestReschedule(
    appointmentId: string,
    hoursAway: number,
  ): Promise<string> {
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

  /** The clinician decides, as `decideRescheduleRequest` does: the status only. */
  async function decide(
    requestId: string,
    decision: 'approved' | 'declined',
  ): Promise<void> {
    await database.asUser(
      fx.doctorAUserId,
      `update public.reschedule_request
          set reschedule_request_status = $2
        where reschedule_request_id = $1`,
      [requestId, decision],
    )
  }

  // --- Who is told, and what ------------------------------------------------

  it('tells the patient and the doctor when the patient cancels', async () => {
    // Inside the reminder window and not yet reminded: the job would have
    // sent a pair had it not been cancelled.
    const id = await appointmentIn(12)

    expect(await cancelAs(fx.aliceUserId, id)).toBe(1)

    await expectOnePair(id)
    expect((await allNotifications())).toHaveLength(2)
    // The guard is not touched, and a cancelled appointment is not reminded.
    expect((await appointmentRow(id)).reminder_sent_at).toBeNull()
    expect(await dispatch()).toBe(0)
    expect(await cancellationNotices()).toHaveLength(2)
  })

  it('tells the patient and the doctor when the doctor cancels', async () => {
    const id = await appointmentIn(12, 'confirmed')

    expect(await cancelAs(fx.doctorAUserId, id)).toBe(1)

    await expectOnePair(id)
    expect((await allNotifications())).toHaveLength(2)
    expect((await appointmentRow(id)).reminder_sent_at).toBeNull()
    expect(await dispatch()).toBe(0)
  })

  it('leaves the reminder already sent exactly as it was', async () => {
    const id = await appointmentIn(12)
    expect(await dispatch()).toBe(2)

    // Alice has read hers; doctorA has not. Both states must survive.
    await database.asUser(
      fx.aliceUserId,
      `update public.notification set notification_is_read = true
        where user_id = $1`,
      [fx.aliceUserId],
    )
    const remindersBefore = await allNotifications()
    const guardBefore = (await appointmentRow(id)).reminder_sent_at
    expect(remindersBefore).toHaveLength(2)
    expect(guardBefore).not.toBeNull()

    await cancelAs(fx.aliceUserId, id)

    const after = await allNotifications()
    const ids = new Set(remindersBefore.map((row) => row.notification_id))
    // Byte for byte: same ids, recipients, text, read state and timestamps.
    expect(after.filter((row) => ids.has(row.notification_id))).toEqual(
      remindersBefore,
    )
    expect(
      remindersBefore.map((row) => [row.user_id, row.notification_is_read]).sort(),
    ).toEqual(
      [
        [fx.aliceUserId, true],
        [fx.doctorAUserId, false],
      ].sort(),
    )

    // The cancellation is simply the newer pair beside them.
    expect(after).toHaveLength(4)
    await expectOnePair(id)

    // And it names the same date and time as the reminder, so they pair up.
    const reminder = remindersBefore.find((row) => row.user_id === fx.aliceUserId)!
    const when = /on (.+ at \d{2}:\d{2})\.$/.exec(reminder.notification_message)![1]
    expect(
      (await cancellationNotices()).find((row) => row.user_id === fx.aliceUserId)!
        .notification_message,
    ).toBe(`Your appointment on ${when} has been cancelled.`)

    // The guard is exactly the stamp the job wrote, and nothing is resent.
    expect((await appointmentRow(id)).reminder_sent_at).toBe(guardBefore)
    expect(await dispatch()).toBe(0)
    expect(await allNotifications()).toHaveLength(4)
  })

  it('names the new time after a reschedule has been reminded', async () => {
    const id = await appointmentIn(12)
    expect(await dispatch()).toBe(2)
    const oldTime = manila((await appointmentRow(id)).epoch_ms)

    await decide(await requestReschedule(id, 20), 'approved')
    // F-01: the new time is reminded in its own right.
    expect(await dispatch()).toBe(2)
    const newTime = manila((await appointmentRow(id)).epoch_ms)
    expect(newTime.time).not.toBe(oldTime.time)

    await cancelAs(fx.aliceUserId, id)

    await expectOnePair(id)
    for (const notice of await cancellationNotices()) {
      expect(notice.notification_message).toContain(`at ${newTime.time} has`)
      expect(notice.notification_message).not.toContain(`at ${oldTime.time} has`)
    }
    // Both reminders stay; the cancellation is the only thing added.
    expect(await allNotifications()).toHaveLength(6)
    expect(await dispatch()).toBe(0)
  })

  // --- When nothing is sent -------------------------------------------------

  describe('sends nothing when', () => {
    it.each([
      ['cancelled', 'cancelled'],
      ['scheduled', 'scheduled'],
      ['confirmed', 'confirmed'],
      ['scheduled', 'confirmed'],
      ['confirmed', 'scheduled'],
      ['scheduled', 'completed'],
      ['confirmed', 'no_show'],
    ])('the status goes from %s to %s', async (from, to) => {
      // Future, so the only thing that can decide is the status change.
      const id = await appointmentIn(12, from)

      expect(await setStatusAs(fx.doctorAUserId, id, to)).toBe(1)

      expect(await allNotifications()).toHaveLength(0)
    })

    it.each(['completed', 'no_show'])(
      'a %s appointment is cancelled — refused before any notice',
      async (from) => {
        // A closed appointment cannot change status at all (migration 21), so
        // this never reaches the cancellation trigger.
        const id = await appointmentIn(12, from)

        await expect(setStatusAs(fx.doctorAUserId, id, 'cancelled')).rejects.toThrow(
          /has already been/,
        )

        expect((await appointmentRow(id)).status).toBe(from)
        expect(await allNotifications()).toHaveLength(0)
      },
    )

    it('the patient confirms attendance', async () => {
      const id = await appointmentIn(12)
      expect(await setStatusAs(fx.aliceUserId, id, 'confirmed')).toBe(1)
      expect(await allNotifications()).toHaveLength(0)
    })

    it.each(['scheduled', 'confirmed'])(
      'a %s appointment that has already passed is cancelled',
      async (status) => {
        const id = await appointmentIn(-2, status)
        expect(await cancelAs(fx.doctorAUserId, id)).toBe(1)
        expect((await appointmentRow(id)).status).toBe('cancelled')
        expect(await allNotifications()).toHaveLength(0)
      },
    )

    it('a reschedule is approved', async () => {
      const id = await appointmentIn(12)
      await decide(await requestReschedule(id, 20), 'approved')
      expect((await appointmentRow(id)).status).toBe('scheduled')
      expect(await allNotifications()).toHaveLength(0)
    })

    it('a reschedule is declined', async () => {
      const id = await appointmentIn(12)
      await decide(await requestReschedule(id, 20), 'declined')
      expect(await allNotifications()).toHaveLength(0)
    })

    it('only the date and time are changed', async () => {
      const id = await appointmentIn(12)
      await database.asUser(
        fx.doctorAUserId,
        `update public.appointment
            set appointment_date = appointment_date + interval '3 hours'
          where appointment_id = $1`,
        [id],
      )
      expect(await allNotifications()).toHaveLength(0)
    })

    it('only the reminder guard is written', async () => {
      const id = await appointmentIn(12)
      await database.asService(
        `update public.appointment set appointment_reminder_sent_at = now()
          where appointment_id = $1`,
        [id],
      )
      await database.asService(
        `update public.appointment set appointment_reminder_sent_at = null
          where appointment_id = $1`,
        [id],
      )
      expect(await allNotifications()).toHaveLength(0)
    })
  })

  // --- Once per cancellation ------------------------------------------------

  it('does not send a second pair when the cancellation is repeated', async () => {
    const id = await appointmentIn(12)
    await cancelAs(fx.aliceUserId, id)
    await expectOnePair(id)

    // The same request again, from either side, and from the service role.
    expect(await cancelAs(fx.aliceUserId, id)).toBe(1)
    expect(await cancelAs(fx.doctorAUserId, id)).toBe(1)
    await database.asService(
      `update public.appointment set appointment_status = 'cancelled'
        where appointment_id = $1`,
      [id],
    )

    await expectOnePair(id)
    expect(await allNotifications()).toHaveLength(2)
  })

  it('sends one pair when a second cancellation reaches the row after the first', async () => {
    // A writer racing another blocks on the row lock and, under READ
    // COMMITTED, then updates the row as the first writer left it — already
    // cancelled. Two cancellations in one transaction put the second in
    // exactly that position. (PGlite is a single connection, so two truly
    // concurrent sessions cannot be staged here.)
    const id = await appointmentIn(12)

    await database.db.exec(`
      begin;
      update public.appointment set appointment_status = 'cancelled'
       where appointment_id = '${id}';
      update public.appointment set appointment_status = 'cancelled'
       where appointment_id = '${id}';
      commit;
    `)

    await expectOnePair(id)
  })

  // --- Security -------------------------------------------------------------

  it('is a definer with an empty search path, and not callable directly', async () => {
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
        where p.oid = 'public.appointment_notify_cancellation'::regproc`,
    )
    expect(fn!.definer).toBe(true)
    expect(fn!.config).toEqual(['search_path=""'])
    expect(fn!.authenticated).toBe(false)
    expect(fn!.anon).toBe(false)

    for (const caller of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asUser(caller, 'select public.appointment_notify_cancellation()'),
      ).rejects.toThrow()
    }
    await expect(
      database.asAnon('select public.appointment_notify_cancellation()'),
    ).rejects.toThrow()
  })

  it('runs after the status is written, once per row', async () => {
    const [trigger] = await database.asService<{ definition: string }>(
      `select pg_get_triggerdef(oid) as definition
         from pg_trigger
        where tgname = 'appointment_on_cancellation'`,
    )
    expect(trigger!.definition).toMatch(
      /AFTER UPDATE OF appointment_status ON public\.appointment FOR EACH ROW/,
    )
  })

  it('tells nobody else, and each person can read only their own notice', async () => {
    const id = await appointmentIn(12)
    await cancelAs(fx.aliceUserId, id)

    const recipients = new Set((await allNotifications()).map((row) => row.user_id))
    expect(recipients).toEqual(new Set([fx.aliceUserId, fx.doctorAUserId]))

    // Another patient of the same doctor, another doctor's patient, another
    // doctor, a deactivated doctor and their patient, and the administrator.
    for (const outsider of [
      fx.bobUserId,
      fx.carolUserId,
      fx.doctorBUserId,
      fx.doctorCUserId,
      fx.daveUserId,
      fx.adminUserId,
    ]) {
      expect(
        await database.asUser(outsider, 'select * from public.notification'),
      ).toHaveLength(0)
    }

    const expected = await expectedNotices(id)
    const alice = await database.asUser<{ notification_message: string }>(
      fx.aliceUserId,
      'select notification_message from public.notification',
    )
    expect(alice.map((row) => row.notification_message)).toEqual([expected.patient])

    const doctor = await database.asUser<{ notification_message: string }>(
      fx.doctorAUserId,
      'select notification_message from public.notification',
    )
    expect(doctor.map((row) => row.notification_message)).toEqual([expected.doctor])
  })
})
