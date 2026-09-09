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
})
