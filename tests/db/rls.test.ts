import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Authorization tests.
 *
 * These do not check that policies exist — schema.test.ts does that. They
 * check what the policies actually DO, by issuing real queries as real
 * principals against a real PostgreSQL with RLS engaged.
 *
 * Every test is written so that a policy which denies everything would fail
 * it just as loudly as a policy which permits everything.
 */
describe('row level security', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  // =========================================================================
  describe('unauthenticated access', () => {
    it('exposes no patient data to an anonymous caller', async () => {
      for (const table of [
        'patient',
        'treatment_plan',
        'prescription',
        'recovery_log',
        'doctor_note',
        'appointment',
        'chat_message',
        'notification',
        'audit_log',
      ]) {
        await expectDenied(() => database.asAnon(`select * from public.${table}`))
      }
    })

    it('exposes no announcements to an anonymous caller', async () => {
      await expectDenied(() =>
        database.asAnon('select * from public.announcement'),
      )
    })
  })

  // =========================================================================
  describe('patient isolation', () => {
    it('lets a patient read their own record', async () => {
      const rows = await database.asUser(
        fx.aliceUserId,
        'select pat_id from public.patient',
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ pat_id: fx.alicePatId })
    })

    it('hides a patient sharing the same doctor', async () => {
      // Alice and Bob are both doctorA's patients. A policy scoped by doctor
      // rather than by patient would leak Bob's record to Alice here.
      const rows = await database.asUser(
        fx.aliceUserId,
        'select pat_id from public.patient where pat_id = $1',
        [fx.bobPatId],
      )
      expect(rows).toEqual([])
    })

    it('hides a patient under a different doctor', async () => {
      const rows = await database.asUser(
        fx.aliceUserId,
        'select pat_id from public.patient where pat_id = $1',
        [fx.carolPatId],
      )
      expect(rows).toEqual([])
    })

    it.each([
      ['treatment_plan', 'treatment_plan_id'],
      ['prescription', 'prescription_id'],
      ['recovery_log', 'recovery_log_id'],
      ['appointment', 'appointment_id'],
      ['chat_session', 'chat_session_id'],
    ])('scopes %s to the owning patient', async (table, idColumn) => {
      const mine = await database.asUser(
        fx.aliceUserId,
        `select ${idColumn} from public.${table}`,
      )
      expect(mine.length).toBeGreaterThan(0)

      const theirs = await database.asUser(
        fx.carolUserId,
        `select ${idColumn} from public.${table}`,
      )

      const mineIds = mine.map((row) => (row as Record<string, string>)[idColumn])
      const theirsIds = theirs.map(
        (row) => (row as Record<string, string>)[idColumn],
      )
      expect(mineIds.some((id) => theirsIds.includes(id))).toBe(false)
    })

    it('never shows doctor notes to any patient', async () => {
      // Modules 5.4 and 5.5 are doctor-only. The patient this note is about
      // still cannot read it.
      const rows = await database.asUser(
        fx.aliceUserId,
        'select doctor_note_id from public.doctor_note',
      )
      expect(rows).toEqual([])
    })

    it('hides unpublished announcements from patients', async () => {
      const rows = await database.asUser<{ announcement_id: string }>(
        fx.aliceUserId,
        'select announcement_id from public.announcement',
      )
      expect(rows.map((r) => r.announcement_id)).toEqual([
        fx.publishedAnnouncementId,
      ])
    })
  })

  // =========================================================================
  describe('doctor authorization', () => {
    it('shows a doctor exactly their own patients', async () => {
      const rows = await database.asUser<{ pat_id: string }>(
        fx.doctorAUserId,
        'select pat_id from public.patient order by pat_first_name',
      )
      expect(rows.map((r) => r.pat_id).sort()).toEqual(
        [fx.alicePatId, fx.bobPatId].sort(),
      )
    })

    it('hides another doctor’s patient', async () => {
      const rows = await database.asUser(
        fx.doctorAUserId,
        'select pat_id from public.patient where pat_id = $1',
        [fx.carolPatId],
      )
      expect(rows).toEqual([])
    })

    it('hides another doctor’s clinical records', async () => {
      const rows = await database.asUser(
        fx.doctorBUserId,
        'select treatment_plan_id from public.treatment_plan where pat_id = $1',
        [fx.alicePatId],
      )
      expect(rows).toEqual([])
    })

    it('refuses to let a doctor write to a patient who is not theirs', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.doctorBUserId,
          `insert into public.doctor_note (pat_id, doc_id, doctor_note_text)
           values ($1, $2, 'Unauthorised note') returning doctor_note_id`,
          [fx.alicePatId, fx.doctorBId],
        ),
      )
    })

    it('refuses to let a doctor attribute a record to another doctor', async () => {
      // Even for their own patient, doctorA cannot write a plan signed by
      // doctorB: the WITH CHECK pins doc_id to the caller.
      await expectDenied(() =>
        database.asUser(
          fx.doctorAUserId,
          `insert into public.treatment_plan
             (pat_id, doc_id, treatment_plan_title)
           values ($1, $2, 'Forged plan') returning treatment_plan_id`,
          [fx.alicePatId, fx.doctorBId],
        ),
      )
    })

    it('revokes all patient access when a doctor is deactivated', async () => {
      // doctorC still has an account and can authenticate, but module 11.3
      // deactivation must remove data access at the database.
      const rows = await database.asUser(
        fx.doctorCUserId,
        'select pat_id from public.patient',
      )
      expect(rows).toEqual([])
    })
  })

  // =========================================================================
  describe('administrator boundaries', () => {
    it('does not let an administrator read patient records', async () => {
      // The module list gives admin no patient-management module. The
      // dashboard gets counts from an aggregate function instead.
      const rows = await database.asUser(
        fx.adminUserId,
        'select pat_id from public.patient',
      )
      expect(rows).toEqual([])
    })

    it.each([
      'treatment_plan',
      'prescription',
      'recovery_log',
      'doctor_note',
      'chat_message',
      'medication_log',
    ])('does not let an administrator read %s', async (table) => {
      const rows = await database.asUser(
        fx.adminUserId,
        `select * from public.${table}`,
      )
      expect(rows).toEqual([])
    })

    it('lets an administrator list doctors', async () => {
      const rows = await database.asUser(
        fx.adminUserId,
        'select doc_id from public.doctor',
      )
      expect(rows).toHaveLength(3)
    })

    it('lets an administrator read the audit log', async () => {
      const rows = await database.asUser(
        fx.adminUserId,
        'select audit_log_id from public.audit_log',
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it('hides the audit log from doctors and patients', async () => {
      for (const userId of [fx.doctorAUserId, fx.aliceUserId]) {
        const rows = await database.asUser(
          userId,
          'select audit_log_id from public.audit_log',
        )
        expect(rows).toEqual([])
      }
    })

    it('returns aggregate counts without exposing rows', async () => {
      const rows = await database.asUser<{ admin_dashboard_stats: unknown }>(
        fx.adminUserId,
        'select public.admin_dashboard_stats()',
      )
      const stats = rows[0]?.admin_dashboard_stats as {
        patients: { total: number }
        doctors: { total: number }
      }
      expect(stats.patients.total).toBe(4)
      expect(stats.doctors.total).toBe(3)
    })

    it('refuses the aggregate function to non-administrators', async () => {
      for (const userId of [fx.doctorAUserId, fx.aliceUserId]) {
        await expect(
          database.asUser(userId, 'select public.admin_dashboard_stats()'),
        ).rejects.toThrow(/Administrator privileges/)
      }
    })

    it('reveals no patient content through audit log details', async () => {
      // Administrators can read audit_log but not patient records. If audit
      // details carried row values, the audit trail would become a bypass.
      const rows = await database.asUser<{ audit_log_details: unknown }>(
        fx.adminUserId,
        `select audit_log_details from public.audit_log
          where audit_log_entity in ('patient', 'prescription', 'treatment_plan')`,
      )

      expect(rows.length).toBeGreaterThan(0)
      const serialised = JSON.stringify(rows)
      expect(serialised).not.toContain('Alice')
      expect(serialised).not.toContain('Take with food')
      expect(serialised).not.toContain('Post-operative knee recovery')
    })
  })

  // =========================================================================
  describe('privilege escalation', () => {
    it('stops a patient reassigning themselves to another doctor', async () => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          'update public.patient set doc_id = $1 where pat_id = $2',
          [fx.doctorBId, fx.alicePatId],
        ),
      ).rejects.toThrow(/cannot change your assigned doctor/i)
    })

    it('stops a patient changing their own status', async () => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          `update public.patient set pat_status = 'discharged' where pat_id = $1`,
          [fx.alicePatId],
        ),
      ).rejects.toThrow(/cannot change your own patient status/i)
    })

    it('still lets a patient edit their own profile fields', async () => {
      // The guard must not be so broad that module 2.7 stops working.
      await database.asUser(
        fx.aliceUserId,
        `update public.patient set pat_contact_no = '0917-000-0000'
          where pat_id = $1`,
        [fx.alicePatId],
      )

      const [row] = await database.asUser<{ pat_contact_no: string }>(
        fx.aliceUserId,
        'select pat_contact_no from public.patient where pat_id = $1',
        [fx.alicePatId],
      )
      expect(row?.pat_contact_no).toBe('0917-000-0000')
    })

    it('stops a deactivated doctor reactivating themselves', async () => {
      await expect(
        database.asUser(
          fx.doctorCUserId,
          'update public.doctor set doc_is_active = true where doc_id = $1',
          [fx.doctorCId],
        ),
      ).rejects.toThrow(/administrator/i)
    })

    it('stops a patient promoting their own account role', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.user_account set user_role = 'admin'
            where user_id = $1 returning user_id`,
          [fx.aliceUserId],
        ),
      )

      const [row] = await database.asService<{ user_role: string }>(
        'select user_role from public.user_account where user_id = $1',
        [fx.aliceUserId],
      )
      expect(row?.user_role).toBe('patient')
    })

    it('stops a patient creating a patient record for themselves', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `insert into public.patient
             (user_id, doc_id, pat_first_name, pat_last_name)
           values ($1, $2, 'Fake', 'Patient') returning pat_id`,
          [fx.aliceUserId, fx.doctorAId],
        ),
      )
    })

    it('stops anyone forging or erasing audit history', async () => {
      for (const userId of [fx.adminUserId, fx.doctorAUserId, fx.aliceUserId]) {
        await expectDenied(() =>
          database.asUser(
            userId,
            `insert into public.audit_log
               (audit_log_action, audit_log_entity)
             values ('forged', 'patient') returning audit_log_id`,
          ),
        )
        await expectDenied(() =>
          database.asUser(
            userId,
            'delete from public.audit_log returning audit_log_id',
          ),
        )
      }
    })
  })

  // =========================================================================
  describe('workflow integrity', () => {
    it('stops a patient approving their own reschedule request', async () => {
      const [request] = await database.asUser<{ reschedule_request_id: string }>(
        fx.aliceUserId,
        `insert into public.reschedule_request
           (appointment_id, user_id, reschedule_request_date,
            reschedule_request_reason)
         values ($1, $2, now() + interval '10 days', 'Work conflict')
         returning reschedule_request_id`,
        [fx.aliceAppointmentId, fx.aliceUserId],
      )

      expect(request).toBeDefined()

      // Module 6.4 assigns approval to the doctor. The patient submitting the
      // request must not be able to grant it.
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.reschedule_request
              set reschedule_request_status = 'approved',
                  reschedule_request_responded_at = now()
            where reschedule_request_id = $1
            returning reschedule_request_id`,
          [request!.reschedule_request_id],
        ),
      )
    })

    it('moves the appointment when the doctor approves a reschedule', async () => {
      const [request] = await database.asUser<{ reschedule_request_id: string }>(
        fx.carolUserId,
        `insert into public.reschedule_request
           (appointment_id, user_id, reschedule_request_date)
         values ($1, $2, now() + interval '21 days')
         returning reschedule_request_id`,
        [fx.carolAppointmentId, fx.carolUserId],
      )

      await database.asUser(
        fx.doctorBUserId,
        `update public.reschedule_request
            set reschedule_request_status = 'approved'
          where reschedule_request_id = $1`,
        [request!.reschedule_request_id],
      )

      const [appointment] = await database.asService<{
        appointment_date: string
        appointment_status: string
      }>(
        `select appointment_date, appointment_status
           from public.appointment where appointment_id = $1`,
        [fx.carolAppointmentId],
      )

      // Approval is only meaningful if the appointment actually moves.
      const movedTo = new Date(appointment!.appointment_date).getTime()
      const inTwoWeeks = Date.now() + 14 * 24 * 60 * 60 * 1000
      expect(movedTo).toBeGreaterThan(inTwoWeeks)
      expect(appointment!.appointment_status).toBe('scheduled')
    })

    it('stops a doctor editing medication adherence', async () => {
      // Module 4.6 gives marking-as-taken to the patient only. An adherence
      // record the treating clinician can edit proves nothing.
      const [dose] = await database.asService<{ medication_log_id: string }>(
        `select medication_log_id from public.medication_log
          where medication_schedule_id = $1 limit 1`,
        [fx.aliceScheduleId],
      )

      expect(dose).toBeDefined()

      await expectDenied(() =>
        database.asUser(
          fx.doctorAUserId,
          `update public.medication_log set medication_log_status = 'taken'
            where medication_log_id = $1 returning medication_log_id`,
          [dose!.medication_log_id],
        ),
      )
    })

    it('lets the patient mark a dose taken and stamps the time', async () => {
      const [dose] = await database.asService<{ medication_log_id: string }>(
        `select medication_log_id from public.medication_log
          where medication_schedule_id = $1 limit 1`,
        [fx.aliceScheduleId],
      )

      await database.asUser(
        fx.aliceUserId,
        `update public.medication_log set medication_log_status = 'taken'
          where medication_log_id = $1`,
        [dose!.medication_log_id],
      )

      const [row] = await database.asService<{
        medication_log_status: string
        medication_log_taken_at: string | null
      }>(
        `select medication_log_status, medication_log_taken_at
           from public.medication_log where medication_log_id = $1`,
        [dose!.medication_log_id],
      )

      expect(row?.medication_log_status).toBe('taken')
      expect(row?.medication_log_taken_at).not.toBeNull()
    })

    it('stops a patient rescheduling by editing the appointment directly', async () => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          `update public.appointment
              set appointment_date = now() + interval '60 days'
            where appointment_id = $1`,
          [fx.aliceAppointmentId],
        ),
      ).rejects.toThrow(/reschedule request/i)
    })

    it('stops a patient marking their own appointment completed', async () => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          `update public.appointment set appointment_status = 'completed'
            where appointment_id = $1`,
          [fx.aliceAppointmentId],
        ),
      ).rejects.toThrow(/confirm or cancel/i)
    })

    it('lets a patient confirm attendance', async () => {
      await database.asUser(
        fx.aliceUserId,
        `update public.appointment set appointment_status = 'confirmed'
          where appointment_id = $1`,
        [fx.aliceAppointmentId],
      )

      const [row] = await database.asUser<{ appointment_status: string }>(
        fx.aliceUserId,
        'select appointment_status from public.appointment where appointment_id = $1',
        [fx.aliceAppointmentId],
      )
      expect(row?.appointment_status).toBe('confirmed')
    })

    it('stops a patient booking with a doctor who is not theirs', async () => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          `insert into public.appointment (pat_id, doc_id, appointment_date)
           values ($1, $2, now() + interval '5 days')`,
          [fx.alicePatId, fx.doctorBId],
        ),
      ).rejects.toThrow(/assigned doctor/i)
    })

    it('stops a patient booking on behalf of another patient', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `insert into public.appointment (pat_id, doc_id, appointment_date)
           values ($1, $2, now() + interval '5 days') returning appointment_id`,
          [fx.bobPatId, fx.doctorAId],
        ),
      )
    })
  })

  // =========================================================================
  describe('notifications', () => {
    it('shows a user only their own notifications', async () => {
      await database.asService(
        `insert into public.notification
           (user_id, notification_type, notification_message)
         values ($1, 'general', 'For Alice only')`,
        [fx.aliceUserId],
      )

      const bobsView = await database.asUser(
        fx.bobUserId,
        'select notification_id from public.notification',
      )
      expect(bobsView).toEqual([])

      const alicesView = await database.asUser(
        fx.aliceUserId,
        'select notification_id from public.notification',
      )
      expect(alicesView).toHaveLength(1)
    })

    it('lets a doctor notify their own patient but nobody else’s', async () => {
      await database.asUser(
        fx.doctorAUserId,
        `insert into public.notification
           (user_id, notification_type, notification_message)
         values ($1, 'treatment', 'Please review your plan')`,
        [fx.aliceUserId],
      )

      await expectDenied(() =>
        database.asUser(
          fx.doctorAUserId,
          `insert into public.notification
             (user_id, notification_type, notification_message)
           values ($1, 'general', 'Not your patient') returning notification_id`,
          [fx.carolUserId],
        ),
      )
    })
  })
})
