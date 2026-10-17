import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Decision D8, option A (migration 31): a deactivated doctor's upcoming
 * appointments move with their patients, in the same transaction, or nothing
 * moves.
 *
 *   - scheduled and confirmed appointments still to come move to the new
 *     doctor; past, completed, cancelled and no-show ones stay with the
 *     doctor they were with;
 *   - the Clinic Admin confirms both counts, re-checked under lock;
 *   - a clash - the new doctor's booking, the patient's other booking, or
 *     two moving appointments at once - refuses the whole move;
 *   - the patient and the new doctor are told; reminders already sent are
 *     not sent again; a pending reschedule request goes on with its
 *     appointment;
 *   - one administration entry with both counts, and one clinical entry per
 *     moved appointment naming only the field that changed.
 *
 * Fixture: doctor C is deactivated and has one patient, Dave.
 */

describe('D8: upcoming appointments move with their patients', () => {
  let database: TestDatabase
  let fx: Fixture
  let upcoming: string // scheduled, in two days, with a pending reschedule request
  let confirmed: string // confirmed, in five days, already reminded
  let past: string // still marked scheduled, but two days ago
  let cancelled: string // in three days, cancelled
  let completed: string // ten days ago
  let requestId: string

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

  const book = (patId: string, docId: string, offset: string, status = 'scheduled') =>
    one<string>(
      `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_status)
       values ($1, $2, date_trunc('minute', now() + $3::interval), $4::public.appointment_status)
       returning appointment_id`,
      [patId, docId, offset, status],
    )

  const counts = (userId: string, docId: string) =>
    database.asUser<{ patients: number; appointments: number }>(
      userId,
      `select public.admin_doctor_patient_count($1) as patients,
              public.admin_doctor_appointment_count($1) as appointments`,
      [docId],
    )
  const move = (expectedPatients: number, expectedAppointments: number | null, to = fx.doctorAId) =>
    database.asUser<{ n: number }>(
      fx.adminUserId,
      expectedAppointments === null
        ? 'select public.admin_reassign_doctor_patients($1, $2, $3) as n'
        : 'select public.admin_reassign_doctor_patients($1, $2, $3, $4) as n',
      expectedAppointments === null
        ? [fx.doctorCId, to, expectedPatients]
        : [fx.doctorCId, to, expectedPatients, expectedAppointments],
    )

  /** Everything a refused move must leave exactly as it was. */
  const state = async () => ({
    patients: await database.asService('select pat_id, doc_id from public.patient order by 1'),
    appointments: await database.asService(
      `select appointment_id, doc_id, appointment_status, appointment_date, appointment_reminder_sent_at
         from public.appointment order by 1`,
    ),
    requests: await database.asService('select reschedule_request_id, appointment_id, reschedule_request_status from public.reschedule_request order by 1'),
    notifications: await one<number>('select count(*)::int from public.notification'),
    audit: await one<number>('select count(*)::int from public.audit_log'),
  })

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    upcoming = await book(fx.davePatId, fx.doctorCId, '2 days')
    confirmed = await book(fx.davePatId, fx.doctorCId, '5 days', 'confirmed')
    past = await book(fx.davePatId, fx.doctorCId, '-2 days')
    cancelled = await book(fx.davePatId, fx.doctorCId, '3 days', 'cancelled')
    completed = await book(fx.davePatId, fx.doctorCId, '-10 days', 'completed')
    await database.asService(
      'update public.appointment set appointment_reminder_sent_at = now() where appointment_id = $1',
      [confirmed],
    )
    requestId = await one<string>(
      `insert into public.reschedule_request (appointment_id, user_id, reschedule_request_date, reschedule_request_reason)
       values ($1, $2, date_trunc('minute', now() + interval '4 days'), 'Work clash') returning reschedule_request_id`,
      [upcoming, fx.daveUserId],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  it('tells the Clinic Admin how many patients and how many upcoming appointments, and nothing else', async () => {
    expect(await counts(fx.adminUserId, fx.doctorCId)).toEqual([{ patients: 1, appointments: 2 }])
  })

  it('counts upcoming appointments only for a deactivated doctor, and only for Clinic Admins', async () => {
    await expect(
      database.asUser(fx.adminUserId, 'select public.admin_doctor_appointment_count($1)', [fx.doctorAId]),
    ).rejects.toThrow(/Only a deactivated doctor/)
    await expect(
      database.asUser(fx.adminUserId, 'select public.admin_doctor_appointment_count($1)', [
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toThrow('That doctor account could not be found')
    for (const userId of [fx.doctorAUserId, fx.daveUserId]) {
      await expect(
        database.asUser(userId, 'select public.admin_doctor_appointment_count($1)', [fx.doctorCId]),
      ).rejects.toThrow(/Administrator privileges/)
    }
    await expect(
      database.asAnon('select public.admin_doctor_appointment_count($1)', [fx.doctorCId]),
    ).rejects.toThrow(/permission denied/)
  })

  it('moves nothing for the dialog deployed before migration 31, which cannot confirm appointments', async () => {
    const before = await state()
    await expect(move(1, null)).rejects.toThrow(/upcoming appointments to move as well/)
    expect(await state()).toEqual(before)
  })

  it('moves nothing if the appointment count is not the one confirmed', async () => {
    const before = await state()
    await expect(move(1, 1)).rejects.toThrow(/number of upcoming appointments has changed/)
    await expect(move(1, 3)).rejects.toThrow(/number of upcoming appointments has changed/)
    expect(await state()).toEqual(before)
  })

  it('moves nothing if the new doctor already has a booking at the same time', async () => {
    // Alice is doctor A's patient; her booking is at the moment of Dave's.
    const clash = await one<string>(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       select $1, $2, appointment_date from public.appointment where appointment_id = $3
       returning appointment_id`,
      [fx.alicePatId, fx.doctorAId, upcoming],
    )
    try {
      const before = await state()
      await expect(move(1, 2)).rejects.toThrow(/1 of the upcoming appointments would clash/)
      expect(await state()).toEqual(before)
    } finally {
      await database.asService('delete from public.appointment where appointment_id = $1', [clash])
    }
  })

  it('moves nothing if the patient already has another booking at the same time', async () => {
    // A booking with another doctor cannot be made today (migration 15's
    // assigned-doctor check), so this one is planted as older data would be.
    await database.db.exec('alter table public.appointment disable trigger appointment_check_assigned_doctor')
    const elsewhere = await one<string>(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       select pat_id, $1, appointment_date from public.appointment where appointment_id = $2
       returning appointment_id`,
      [fx.doctorBId, confirmed],
    )
    await database.db.exec('alter table public.appointment enable trigger appointment_check_assigned_doctor')
    try {
      const before = await state()
      await expect(move(1, 2)).rejects.toThrow(/would clash/)
      expect(await state()).toEqual(before)
    } finally {
      await database.asService('delete from public.appointment where appointment_id = $1', [elsewhere])
    }
  })

  it('moves nothing if two of the moving appointments are at the same time', async () => {
    // A second patient of doctor C, booked at the moment of Dave's: both
    // would land in the new doctor's diary at once.
    const [account] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'eve@recoverease.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'eve@recoverease.test', 'patient')`,
      [account!.id],
    )
    const eve = await one<string>(
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, 'Eve', 'Santos', now()) returning pat_id`,
      [account!.id, fx.doctorCId],
    )
    const eveBooking = await one<string>(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       select $1, $2, appointment_date from public.appointment where appointment_id = $3
       returning appointment_id`,
      [eve, fx.doctorCId, upcoming],
    )
    try {
      expect(await counts(fx.adminUserId, fx.doctorCId)).toEqual([{ patients: 2, appointments: 3 }])
      const before = await state()
      await expect(move(2, 3)).rejects.toThrow(/2 of the upcoming appointments would clash/)
      expect(await state()).toEqual(before)
    } finally {
      await database.asService('delete from public.appointment where appointment_id = $1', [eveBooking])
      await database.asService('delete from public.patient where pat_id = $1', [eve])
    }
  })

  describe('a move that goes through', () => {
    let notificationsBefore: number

    beforeAll(async () => {
      notificationsBefore = await one<number>('select count(*)::int from public.notification')
      expect(await move(1, 2)).toEqual([{ n: 1 }])
    })

    it('hands the upcoming appointments to the new doctor and leaves the history where it was', async () => {
      const doctorOf = (id: string) =>
        one<string>('select doc_id from public.appointment where appointment_id = $1', [id])
      expect(await doctorOf(upcoming)).toBe(fx.doctorAId)
      expect(await doctorOf(confirmed)).toBe(fx.doctorAId)
      for (const id of [past, cancelled, completed]) {
        expect(await doctorOf(id)).toBe(fx.doctorCId)
      }
      expect(await one<string>('select doc_id from public.patient where pat_id = $1', [fx.davePatId])).toBe(fx.doctorAId)
      // Statuses and times are untouched, and the reminder already sent stays sent.
      expect(
        await database.asService(
          `select appointment_status::text as status, appointment_reminder_sent_at is not null as reminded
             from public.appointment where appointment_id = any ($1::uuid[]) order by appointment_date`,
          [[upcoming, confirmed]],
        ),
      ).toEqual([
        { status: 'scheduled', reminded: false },
        { status: 'confirmed', reminded: true },
      ])
    })

    it('tells the patient who they will see and the new doctor who is coming, in the clinic’s time', async () => {
      const when = (id: string, format: string) =>
        one<string>(
          `select to_char(appointment_date at time zone (select clinic_timezone from public.clinic), $2)
             from public.appointment where appointment_id = $1`,
          [id, format],
        )
      const expected = async (id: string) => ({ day: await when(id, 'FMDay, FMDD FMMonth'), time: await when(id, 'HH24:MI') })
      const a = await expected(upcoming)
      const b = await expected(confirmed)

      const messages = (userId: string) =>
        database.asService<{ m: string }>(
          `select notification_message as m from public.notification
            where user_id = $1 and notification_type = 'appointment' order by notification_message`,
          [userId],
        )
      expect(await messages(fx.daveUserId)).toEqual(
        [
          { m: `Your appointment on ${a.day} at ${a.time} will now be with Dr Alan Cruz.` },
          { m: `Your appointment on ${b.day} at ${b.time} will now be with Dr Alan Cruz.` },
        ].sort((x, y) => x.m.localeCompare(y.m)),
      )
      expect(await messages(fx.doctorAUserId)).toEqual(
        [
          { m: `The appointment with Dave Santos on ${a.day} at ${a.time} has been transferred to you.` },
          { m: `The appointment with Dave Santos on ${b.day} at ${b.time} has been transferred to you.` },
        ].sort((x, y) => x.m.localeCompare(y.m)),
      )
      expect(await messages(fx.doctorCUserId)).toEqual([])
      expect(await one<number>('select count(*)::int from public.notification')).toBe(notificationsBefore + 4)
    })

    it('does not remind again about an appointment already reminded, and reminds the new doctor about the rest', async () => {
      await database.asService('delete from public.notification')
      await database.asService('select public.dispatch_appointment_reminders(240)')
      const remindersFor = (userId: string, about = '') =>
        one<number>(
          `select count(*)::int from public.notification
            where user_id = $1 and notification_message like 'Upcoming appointment with ' || $2 || '%'
               or user_id = $1 and $2 = '' and notification_message like 'You have an upcoming appointment%'`,
          [userId, about],
        )
      // Only the scheduled appointment, never reminded before: Dave and his
      // new doctor once each, and nothing to doctor C. (The fixture's other
      // appointments, Alice's and Carol's, are reminded to their own people.)
      expect(await remindersFor(fx.daveUserId)).toBe(1)
      expect(await remindersFor(fx.doctorAUserId, 'Dave Santos')).toBe(1)
      expect(await one<number>('select count(*)::int from public.notification where user_id = $1', [fx.doctorCUserId])).toBe(0)
    })

    it('leaves the pending reschedule request with its appointment, for the new doctor to decide', async () => {
      expect(
        await database.asService('select appointment_id, reschedule_request_status::text as s from public.reschedule_request where reschedule_request_id = $1', [
          requestId,
        ]),
      ).toEqual([{ appointment_id: upcoming, s: 'pending' }])
      expect(
        await database.asUser(
          fx.doctorAUserId,
          `update public.reschedule_request set reschedule_request_status = 'approved'
            where reschedule_request_id = $1 returning reschedule_request_id`,
          [requestId],
        ),
      ).toHaveLength(1)
      expect(
        await database.asService(
          `select doc_id, appointment_date = (select reschedule_request_date from public.reschedule_request where reschedule_request_id = $2) as moved
             from public.appointment where appointment_id = $1`,
          [upcoming, requestId],
        ),
      ).toEqual([{ doc_id: fx.doctorAId, moved: true }])
    })

    it('records both counts, and each appointment’s doctor change without naming the doctor', async () => {
      const [entry] = await database.asService<{ scope: string; details: unknown }>(
        `select audit_scope::text as scope, audit_log_details as details from public.audit_log
          where audit_log_entity = 'doctor_patients' and audit_log_action = 'reassign'`,
      )
      expect(entry).toEqual({
        scope: 'administration',
        details: { from_doc_id: fx.doctorCId, to_doc_id: fx.doctorAId, patient_count: 1, appointment_count: 2 },
      })

      const perAppointment = await database.asService<{ id: string; scope: string; actor: string; details: unknown; clinic: string }>(
        `select audit_log_entity_id as id, audit_scope::text as scope, user_id as actor,
                audit_log_details as details, clinic_id as clinic
           from public.audit_log where audit_log_entity = 'appointment' order by 1`,
      )
      const clinic = await one<string>('select clinic_id from public.clinic')
      expect(perAppointment).toEqual(
        [upcoming, confirmed].sort().map((id) => ({
          id,
          scope: 'clinical',
          actor: fx.adminUserId,
          details: { changed_columns: ['doc_id'] },
          clinic,
        })),
      )
    })

    it('has nothing left to move afterwards', async () => {
      expect(await counts(fx.adminUserId, fx.doctorCId)).toEqual([{ patients: 0, appointments: 0 }])
    })
  })
})
