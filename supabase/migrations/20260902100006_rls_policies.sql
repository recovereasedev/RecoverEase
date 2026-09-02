-- ===========================================================================
-- RecoverEase — 07. Row Level Security
-- ===========================================================================
-- Authorization lives here, in the database, not in the React router. Hiding
-- a nav link changes what a user sees; it does not change what they can
-- fetch. Every rule below is derived from a specific numbered module in the
-- program specification, cited in the comment above it.
--
-- Conventions applied throughout, each guarding against a specific failure:
--
--   * Every policy names `TO authenticated`. `auth.role() = 'authenticated'`
--     is deprecated and silently passes anonymous sign-ins.
--   * `TO authenticated` is never used on its own. Role alone is
--     authentication, not authorization; every policy also carries an
--     ownership predicate, or it would be a broken-object-level-authorization
--     hole.
--   * Every UPDATE policy defines both USING and WITH CHECK. USING alone lets
--     a user rewrite a row's owning key and hand the row to somebody else.
--   * Helper calls are wrapped as `(select fn())` so PostgreSQL evaluates
--     them once per statement instead of once per row.
--   * Tables with no policy for an operation deny it. That is the default and
--     it is deliberate — audit_log has no UPDATE or DELETE policy at all.
-- ===========================================================================

alter table public.user_account        enable row level security;
alter table public.doctor              enable row level security;
alter table public.admin               enable row level security;
alter table public.patient             enable row level security;
alter table public.treatment_plan      enable row level security;
alter table public.treatment_goal      enable row level security;
alter table public.prescription        enable row level security;
alter table public.medication_schedule enable row level security;
alter table public.medication_log      enable row level security;
alter table public.recovery_log        enable row level security;
alter table public.doctor_note         enable row level security;
alter table public.appointment         enable row level security;
alter table public.reschedule_request  enable row level security;
alter table public.chat_session        enable row level security;
alter table public.chat_message        enable row level security;
alter table public.notification        enable row level security;
alter table public.announcement        enable row level security;
alter table public.report              enable row level security;
alter table public.audit_log           enable row level security;
alter table public.system_setting      enable row level security;

-- ===========================================================================
-- user_account
-- ===========================================================================
-- Read: yourself; an admin (module 11.1 needs to list accounts); a doctor
-- looking at their own patient (module 2.4 View Patient Profile).
--
-- Write: administrators only. Role changes are privilege changes, so nobody
-- edits their own. Everyone edits their display details in their own role
-- table instead (modules 2.6 and 2.7). There is no INSERT policy: accounts
-- are provisioned by an Edge Function using the service role, because
-- creating an auth user requires privileges no browser session may hold.

create policy user_account_select
  on public.user_account for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
    or (select app_private.is_user_my_patient(user_id))
  );

create policy user_account_update_admin
  on public.user_account for update to authenticated
  using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));

-- ===========================================================================
-- doctor
-- ===========================================================================
-- Read: yourself; an admin (module 11.1 View Doctor List); the patients
-- assigned to you, who need to see who is treating them.
--
-- Write: yourself (module 2.6 View and Update Doctor Profile) or an admin
-- (modules 11.2, 11.3). A guard trigger stops a doctor flipping their own
-- `doc_is_active`, since that column is an admin control.

create policy doctor_select
  on public.doctor for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
    or (select app_private.is_my_doctor(doc_id))
  );

create policy doctor_insert_admin
  on public.doctor for insert to authenticated
  with check ((select app_private.is_admin()));

create policy doctor_update_self_or_admin
  on public.doctor for update to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
  )
  with check (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
  );

-- ===========================================================================
-- admin
-- ===========================================================================
-- No module lets anyone enumerate administrators, so the row is visible only
-- to its owner (module 14.2 View and Update Admin Profile). Administrators
-- are provisioned out of band.

create policy admin_select_self
  on public.admin for select to authenticated
  using (user_id = (select auth.uid()));

create policy admin_update_self
  on public.admin for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ===========================================================================
-- patient
-- ===========================================================================
-- Read: the patient themselves, or their assigned doctor (module 2.3 View
-- Patient List, 2.4 View Patient Profile).
--
-- Administrators are deliberately absent. The module list gives admin no
-- patient-management module at all; the admin dashboard's "Doctor/Patient
-- Count Overview" (module 10.1) is served by an aggregate function that
-- returns counts and never rows.
--
-- Write: the assigned doctor (module 2.5 Update Patient Information) or the
-- patient (module 2.7 View and Update Patient Profile). A guard trigger keeps
-- the patient out of the columns that decide their own access.
--
-- No DELETE policy anywhere: patients are moved to an inactive status, never
-- removed.

create policy patient_select
  on public.patient for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_my_patient(pat_id))
  );

-- Module 2.2 Register Patient Account. A doctor may only create a patient
-- assigned to themselves.
create policy patient_insert_own_doctor
  on public.patient for insert to authenticated
  with check (doc_id = (select app_private.current_doctor_id()));

create policy patient_update
  on public.patient for update to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_my_patient(pat_id))
  )
  with check (
    user_id = (select auth.uid())
    or (select app_private.is_my_patient(pat_id))
  );

-- ===========================================================================
-- treatment_plan / treatment_goal
-- ===========================================================================
-- Read: patient (module 3.4) and assigned doctor.
-- Write: assigned doctor only (modules 3.1, 3.2, 3.3).
-- No DELETE: a plan is cancelled by status, preserving the clinical record.

create policy treatment_plan_select
  on public.treatment_plan for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

create policy treatment_plan_insert_doctor
  on public.treatment_plan for insert to authenticated
  with check (
    (select app_private.is_my_patient(pat_id))
    and doc_id = (select app_private.current_doctor_id())
  );

create policy treatment_plan_update_doctor
  on public.treatment_plan for update to authenticated
  using ((select app_private.is_my_patient(pat_id)))
  with check (
    (select app_private.is_my_patient(pat_id))
    and doc_id = (select app_private.current_doctor_id())
  );

create policy treatment_goal_select
  on public.treatment_goal for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_treatment_plan(treatment_plan_id))
    ))
  );

create policy treatment_goal_insert_doctor
  on public.treatment_goal for insert to authenticated
  with check (
    (select app_private.is_my_patient(
      (select app_private.patient_of_treatment_plan(treatment_plan_id))
    ))
  );

create policy treatment_goal_update_doctor
  on public.treatment_goal for update to authenticated
  using (
    (select app_private.is_my_patient(
      (select app_private.patient_of_treatment_plan(treatment_plan_id))
    ))
  )
  with check (
    (select app_private.is_my_patient(
      (select app_private.patient_of_treatment_plan(treatment_plan_id))
    ))
  );

create policy treatment_goal_delete_doctor
  on public.treatment_goal for delete to authenticated
  using (
    (select app_private.is_my_patient(
      (select app_private.patient_of_treatment_plan(treatment_plan_id))
    ))
  );

-- ===========================================================================
-- prescription / medication_schedule
-- ===========================================================================
-- Read: patient (modules 4.5, 4.10) and assigned doctor.
-- Write: assigned doctor (modules 4.1, 4.3).

create policy prescription_select
  on public.prescription for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

create policy prescription_insert_doctor
  on public.prescription for insert to authenticated
  with check (
    (select app_private.is_my_patient(pat_id))
    and doc_id = (select app_private.current_doctor_id())
  );

create policy prescription_update_doctor
  on public.prescription for update to authenticated
  using ((select app_private.is_my_patient(pat_id)))
  with check (
    (select app_private.is_my_patient(pat_id))
    and doc_id = (select app_private.current_doctor_id())
  );

create policy medication_schedule_select
  on public.medication_schedule for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_prescription(prescription_id))
    ))
  );

create policy medication_schedule_insert_doctor
  on public.medication_schedule for insert to authenticated
  with check (
    (select app_private.is_my_patient(
      (select app_private.patient_of_prescription(prescription_id))
    ))
  );

create policy medication_schedule_update_doctor
  on public.medication_schedule for update to authenticated
  using (
    (select app_private.is_my_patient(
      (select app_private.patient_of_prescription(prescription_id))
    ))
  )
  with check (
    (select app_private.is_my_patient(
      (select app_private.patient_of_prescription(prescription_id))
    ))
  );

-- ===========================================================================
-- medication_log
-- ===========================================================================
-- Read: patient (module 4.8 weekly adherence) and assigned doctor (module 5.3
-- Track Medication Adherence).
--
-- Write: the PATIENT ONLY (module 4.6 Mark Medication as Taken). The doctor
-- has a read module and no write module, and that asymmetry is the point: an
-- adherence record the treating clinician can edit is not evidence of
-- anything. Rows are created by the slot generator, not by either party.

create policy medication_log_select
  on public.medication_log for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_medication_schedule(
        medication_schedule_id
      ))
    ))
  );

create policy medication_log_update_patient
  on public.medication_log for update to authenticated
  using (
    (select app_private.is_own_patient_record(
      (select app_private.patient_of_medication_schedule(
        medication_schedule_id
      ))
    ))
  )
  with check (
    (select app_private.is_own_patient_record(
      (select app_private.patient_of_medication_schedule(
        medication_schedule_id
      ))
    ))
  );

-- ===========================================================================
-- recovery_log
-- ===========================================================================
-- Read: patient (modules 5.6, 5.10, 5.11, 5.12) and assigned doctor
-- (modules 5.1, 5.2).
-- Write: patient only (module 5.9 Log Daily Recovery Progress).

create policy recovery_log_select
  on public.recovery_log for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

create policy recovery_log_insert_patient
  on public.recovery_log for insert to authenticated
  with check ((select app_private.is_own_patient_record(pat_id)));

create policy recovery_log_update_patient
  on public.recovery_log for update to authenticated
  using ((select app_private.is_own_patient_record(pat_id)))
  with check ((select app_private.is_own_patient_record(pat_id)));

-- ===========================================================================
-- doctor_note
-- ===========================================================================
-- Modules 5.4 "Add Doctor's Notes" and 5.5 "View Doctor's Notes History" are
-- both marked doctor-only, and no patient module mentions notes. There is
-- therefore NO patient SELECT policy: a patient querying this table receives
-- zero rows, not a filtered subset.

create policy doctor_note_select_doctor
  on public.doctor_note for select to authenticated
  using ((select app_private.is_my_patient(pat_id)));

create policy doctor_note_insert_doctor
  on public.doctor_note for insert to authenticated
  with check (
    (select app_private.is_my_patient(pat_id))
    and doc_id = (select app_private.current_doctor_id())
  );

-- ===========================================================================
-- appointment
-- ===========================================================================
-- Read: both parties (module 6.2 View Appointment Calendar, 6.7 History).
-- Insert: the patient (module 6.1 Schedule Follow-up Appointment); a table
-- trigger already forces the appointment onto their assigned doctor.
-- Update: patient (module 6.6 Confirm Appointment Attendance) or doctor.

create policy appointment_select
  on public.appointment for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

create policy appointment_insert_patient
  on public.appointment for insert to authenticated
  with check ((select app_private.is_own_patient_record(pat_id)));

create policy appointment_update
  on public.appointment for update to authenticated
  using ((select app_private.can_access_patient(pat_id)))
  with check ((select app_private.can_access_patient(pat_id)));

-- ===========================================================================
-- reschedule_request
-- ===========================================================================
-- Read: the patient the appointment belongs to, and their doctor
-- (module 6.3 Review Appointment Reschedule Request).
-- Insert: the patient, for their own appointment (module 6.5).
-- Update: the doctor only (module 6.4 Approve or Decline). The patient must
-- not be able to approve their own request.

create policy reschedule_request_select
  on public.reschedule_request for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_appointment(appointment_id))
    ))
  );

create policy reschedule_request_insert_patient
  on public.reschedule_request for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select app_private.is_own_patient_record(
      (select app_private.patient_of_appointment(appointment_id))
    ))
  );

create policy reschedule_request_update_doctor
  on public.reschedule_request for update to authenticated
  using (
    (select app_private.is_my_patient(
      (select app_private.patient_of_appointment(appointment_id))
    ))
  )
  with check (
    (select app_private.is_my_patient(
      (select app_private.patient_of_appointment(appointment_id))
    ))
  );

-- ===========================================================================
-- chat_session / chat_message
-- ===========================================================================
-- Read: the patient (module 8.4 View Chat History) and their doctor
-- (module 8.5 View Patient Chat Transcript).
--
-- Administrators are absent again: module 8.6 is "Monitor Chatbot Usage
-- Logs", which is usage statistics, not transcripts. It is served by an
-- aggregate function. An administrator has no business reading what a patient
-- told a health chatbot.

create policy chat_session_select
  on public.chat_session for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

create policy chat_session_insert_patient
  on public.chat_session for insert to authenticated
  with check ((select app_private.is_own_patient_record(pat_id)));

create policy chat_session_update_patient
  on public.chat_session for update to authenticated
  using ((select app_private.is_own_patient_record(pat_id)))
  with check ((select app_private.is_own_patient_record(pat_id)));

create policy chat_message_select
  on public.chat_message for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_chat_session(chat_session_id))
    ))
  );

create policy chat_message_insert_patient
  on public.chat_message for insert to authenticated
  with check (
    (select app_private.is_own_patient_record(
      (select app_private.patient_of_chat_session(chat_session_id))
    ))
  );

-- ===========================================================================
-- notification
-- ===========================================================================
-- Read and mark-as-read: the addressee alone (module 7.3).
-- Insert: a doctor may notify their own patient (module 7.1 Send Notification
-- to Patient). Everything else is inserted by triggers and Edge Functions
-- running with elevated privilege.

create policy notification_select_own
  on public.notification for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_update_own
  on public.notification for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check ((select app_private.is_user_my_patient(user_id)));

-- ===========================================================================
-- announcement
-- ===========================================================================
-- Read: any signed-in user, but only once published (module 7.4 View System
-- Announcements). Administrators additionally see their own drafts.
-- Write and delete: administrators (module 12).

create policy announcement_select_published
  on public.announcement for select to authenticated
  using (
    announcement_published_at is not null
    or (select app_private.is_admin())
  );

create policy announcement_insert_admin
  on public.announcement for insert to authenticated
  with check (
    (select app_private.is_admin())
    and admin_id = (select app_private.current_admin_id())
  );

create policy announcement_update_admin
  on public.announcement for update to authenticated
  using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));

create policy announcement_delete_admin
  on public.announcement for delete to authenticated
  using ((select app_private.is_admin()));

-- ===========================================================================
-- report
-- ===========================================================================
-- Module 9 assigns report generation to doctors (9.1, 9.2) and administrators
-- (9.3, 9.4, 9.5). No patient module mentions reports, so patients get no
-- policy here.
--
-- Read: whoever generated it, plus administrators for system-wide reports
-- (module 9.5 View Recently Generated Reports).

create policy report_select
  on public.report for select to authenticated
  using (
    user_id = (select auth.uid())
    or (
      report_type = 'system_wide'
      and (select app_private.is_admin())
    )
  );

create policy report_insert_doctor
  on public.report for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and report_type = 'patient_recovery'
    and (select app_private.is_my_patient(pat_id))
  );

create policy report_insert_admin
  on public.report for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and report_type = 'system_wide'
    and (select app_private.is_admin())
  );

-- ===========================================================================
-- audit_log
-- ===========================================================================
-- Read: administrators (modules 13.1, 13.2).
--
-- There is intentionally no INSERT, UPDATE or DELETE policy for any role.
-- Rows are written by SECURITY DEFINER triggers, so no session can forge an
-- entry, and no session — administrators included — can alter or erase one.
-- An audit trail that its subject can edit is not an audit trail.

create policy audit_log_select_admin
  on public.audit_log for select to authenticated
  using ((select app_private.is_admin()));

-- ===========================================================================
-- system_setting
-- ===========================================================================
-- Administrators only, in both directions (modules 14.1 and 8.7). Settings
-- needed by server-side code are read by Edge Functions with the service
-- role, which bypasses RLS.

create policy system_setting_select_admin
  on public.system_setting for select to authenticated
  using ((select app_private.is_admin()));

create policy system_setting_insert_admin
  on public.system_setting for insert to authenticated
  with check ((select app_private.is_admin()));

create policy system_setting_update_admin
  on public.system_setting for update to authenticated
  using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));
