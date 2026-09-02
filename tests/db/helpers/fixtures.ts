import type { TestDatabase } from './database'

/**
 * A deliberately adversarial fixture.
 *
 * Two doctors each hold patients, so every test can distinguish "this doctor
 * cannot see that patient" from "no doctor can see any patient" — a policy
 * that denies everything would pass a single-tenant fixture while being
 * completely broken.
 *
 *   doctorA  -> alice, bob
 *   doctorB  -> carol
 *   doctorC  -> dave        (doctorC is deactivated)
 *   admin
 *
 * Alice and Bob share a doctor, which is what catches the subtler bug: a
 * policy that scopes by doctor instead of by patient would let Alice read
 * Bob's records.
 */
export type Fixture = {
  adminUserId: string
  adminId: string

  doctorAUserId: string
  doctorAId: string
  doctorBUserId: string
  doctorBId: string
  doctorCUserId: string
  doctorCId: string

  aliceUserId: string
  alicePatId: string
  bobUserId: string
  bobPatId: string
  carolUserId: string
  carolPatId: string
  daveUserId: string
  davePatId: string

  alicePlanId: string
  aliceGoalId: string
  alicePrescriptionId: string
  aliceScheduleId: string
  aliceAppointmentId: string
  aliceRecoveryLogId: string
  aliceNoteId: string
  aliceChatSessionId: string

  carolPlanId: string
  carolAppointmentId: string

  publishedAnnouncementId: string
  draftAnnouncementId: string
}

async function createAccount(
  database: TestDatabase,
  email: string,
  role: 'patient' | 'doctor' | 'admin',
): Promise<string> {
  const [row] = await database.asService<{ id: string }>(
    `insert into auth.users (id, email)
     values (gen_random_uuid(), $1)
     returning id`,
    [email],
  )

  const userId = row!.id

  await database.asService(
    `insert into public.user_account (user_id, user_email, user_role)
     values ($1, $2, $3)`,
    [userId, email, role],
  )

  return userId
}

export async function seedFixture(database: TestDatabase): Promise<Fixture> {
  const one = async <T>(sql: string, params: unknown[]): Promise<T> => {
    const rows = await database.asService<Record<string, unknown>>(sql, params)
    return Object.values(rows[0]!)[0] as T
  }

  // --- Accounts ----------------------------------------------------------
  const adminUserId = await createAccount(database, 'admin@recoverease.test', 'admin')
  const adminId = await one<string>(
    `insert into public.admin (user_id, admin_first_name, admin_last_name)
     values ($1, 'Ada', 'Reyes') returning admin_id`,
    [adminUserId],
  )

  const doctorAUserId = await createAccount(database, 'doctor.a@recoverease.test', 'doctor')
  const doctorAId = await one<string>(
    `insert into public.doctor
       (user_id, doc_first_name, doc_last_name, doc_license_no)
     values ($1, 'Alan', 'Cruz', 'LIC-A-001') returning doc_id`,
    [doctorAUserId],
  )

  const doctorBUserId = await createAccount(database, 'doctor.b@recoverease.test', 'doctor')
  const doctorBId = await one<string>(
    `insert into public.doctor
       (user_id, doc_first_name, doc_last_name, doc_license_no)
     values ($1, 'Bea', 'Lim', 'LIC-B-002') returning doc_id`,
    [doctorBUserId],
  )

  // Deactivated: used to prove that module 11.3 revokes data access, not just
  // the ability to sign in.
  const doctorCUserId = await createAccount(database, 'doctor.c@recoverease.test', 'doctor')
  const doctorCId = await one<string>(
    `insert into public.doctor
       (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active)
     values ($1, 'Cay', 'Tan', 'LIC-C-003', false) returning doc_id`,
    [doctorCUserId],
  )

  // --- Patients ----------------------------------------------------------
  const makePatient = async (
    email: string,
    first: string,
    docId: string,
  ): Promise<{ userId: string; patId: string }> => {
    const userId = await createAccount(database, email, 'patient')
    const patId = await one<string>(
      `insert into public.patient
         (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, $3, 'Santos', now()) returning pat_id`,
      [userId, docId, first],
    )
    return { userId, patId }
  }

  const alice = await makePatient('alice@recoverease.test', 'Alice', doctorAId)
  const bob = await makePatient('bob@recoverease.test', 'Bob', doctorAId)
  const carol = await makePatient('carol@recoverease.test', 'Carol', doctorBId)
  const dave = await makePatient('dave@recoverease.test', 'Dave', doctorCId)

  // --- Alice's clinical record ------------------------------------------
  const alicePlanId = await one<string>(
    `insert into public.treatment_plan
       (pat_id, doc_id, treatment_plan_title, treatment_plan_description)
     values ($1, $2, 'Post-operative knee recovery', 'Twelve week programme')
     returning treatment_plan_id`,
    [alice.patId, doctorAId],
  )

  const aliceGoalId = await one<string>(
    `insert into public.treatment_goal
       (treatment_plan_id, treatment_goal_description, treatment_goal_target_date)
     values ($1, 'Walk 500 metres unaided', public.app_today() + 30)
     returning treatment_goal_id`,
    [alicePlanId],
  )

  const alicePrescriptionId = await one<string>(
    `insert into public.prescription (pat_id, doc_id, prescription_notes)
     values ($1, $2, 'Take with food') returning prescription_id`,
    [alice.patId, doctorAId],
  )

  const aliceScheduleId = await one<string>(
    `insert into public.medication_schedule
       (prescription_id, medication_schedule_name, medication_schedule_dosage,
        medication_schedule_frequency, medication_schedule_times)
     values ($1, 'Paracetamol', '500mg', 2, '{08:00,20:00}'::time[])
     returning medication_schedule_id`,
    [alicePrescriptionId],
  )

  const aliceAppointmentId = await one<string>(
    `insert into public.appointment (pat_id, doc_id, appointment_date)
     values ($1, $2, now() + interval '7 days') returning appointment_id`,
    [alice.patId, doctorAId],
  )

  // `app_today()`, not `current_date`. The schema defines "today" as the
  // clinic's day, and the two are different dates for part of every day —
  // that gap is what broke recovery logging in production. Fixtures that
  // still used the server clock would be asserting against a definition of
  // today the application does not use.
  const aliceRecoveryLogId = await one<string>(
    `insert into public.recovery_log
       (pat_id, recovery_log_date, recovery_log_notes, recovery_log_mood_rating)
     values ($1, public.app_today(), 'Felt steady today', 4)
     returning recovery_log_id`,
    [alice.patId],
  )

  const aliceNoteId = await one<string>(
    `insert into public.doctor_note (pat_id, doc_id, doctor_note_text)
     values ($1, $2, 'Wound healing well. Continue physiotherapy.')
     returning doctor_note_id`,
    [alice.patId, doctorAId],
  )

  const aliceChatSessionId = await one<string>(
    `insert into public.chat_session (pat_id, chat_session_summary)
     values ($1, 'Asked about swelling') returning chat_session_id`,
    [alice.patId],
  )

  await database.asService(
    `insert into public.chat_message
       (chat_session_id, chat_message_role, chat_message_content)
     values ($1, 'patient', 'Is swelling normal after two weeks?')`,
    [aliceChatSessionId],
  )

  // --- Carol's record, under a different doctor -------------------------
  const carolPlanId = await one<string>(
    `insert into public.treatment_plan
       (pat_id, doc_id, treatment_plan_title)
     values ($1, $2, 'Shoulder rehabilitation') returning treatment_plan_id`,
    [carol.patId, doctorBId],
  )

  const carolAppointmentId = await one<string>(
    `insert into public.appointment (pat_id, doc_id, appointment_date)
     values ($1, $2, now() + interval '3 days') returning appointment_id`,
    [carol.patId, doctorBId],
  )

  // --- Announcements -----------------------------------------------------
  const publishedAnnouncementId = await one<string>(
    `insert into public.announcement
       (admin_id, announcement_title, announcement_content,
        announcement_published_at)
     values ($1, 'Clinic hours', 'Open 8am to 5pm', now())
     returning announcement_id`,
    [adminId],
  )

  const draftAnnouncementId = await one<string>(
    `insert into public.announcement
       (admin_id, announcement_title, announcement_content)
     values ($1, 'Unreleased policy', 'Do not show this yet')
     returning announcement_id`,
    [adminId],
  )

  return {
    adminUserId,
    adminId,
    doctorAUserId,
    doctorAId,
    doctorBUserId,
    doctorBId,
    doctorCUserId,
    doctorCId,
    aliceUserId: alice.userId,
    alicePatId: alice.patId,
    bobUserId: bob.userId,
    bobPatId: bob.patId,
    carolUserId: carol.userId,
    carolPatId: carol.patId,
    daveUserId: dave.userId,
    davePatId: dave.patId,
    alicePlanId,
    aliceGoalId,
    alicePrescriptionId,
    aliceScheduleId,
    aliceAppointmentId,
    aliceRecoveryLogId,
    aliceNoteId,
    aliceChatSessionId,
    carolPlanId,
    carolAppointmentId,
    publishedAnnouncementId,
    draftAnnouncementId,
  }
}
