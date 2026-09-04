-- ===========================================================================
-- Module 6.1 "Schedule Follow-up Appointment" is a doctor's task, and the
-- database did not allow it.
-- ===========================================================================
-- `appointment` carried one insert policy, `appointment_insert_patient`,
-- checking `is_own_patient_record(pat_id)`. That covers a patient booking
-- their own follow-up, which is how the table was first used. A clinician
-- inserting an appointment for their own patient was refused with "new row
-- violates row-level security policy for table appointment", so the module
-- could not be completed from the side that owns it.
--
-- This adds the missing policy and changes nothing else. Postgres combines
-- permissive policies for the same command with OR, so the patient policy
-- keeps working exactly as before and neither policy is widened.
--
-- The doctor is still not free to book anything they like:
--
--   * `is_my_patient` restricts the insert to the caller's own caseload, so
--     one clinician cannot put an appointment on another's patient.
--   * `appointment_check_assigned_doctor` already fires `before insert` for
--     every row whatever the caller, and rejects any appointment whose
--     `doc_id` is not the patient's assigned doctor. Naming another doctor
--     in the payload therefore fails even when the caller may access the
--     patient.
--
-- Administrators gain nothing: `is_my_patient` is false for an account with
-- no doctor row, so the admin clinical boundary is unchanged.

create policy appointment_insert_doctor
  on public.appointment for insert to authenticated
  with check ((select app_private.is_my_patient(pat_id)));

comment on policy appointment_insert_doctor on public.appointment is
  'Module 6.1. A doctor may schedule an appointment for a patient in their '
  'own caseload. The assigned-doctor trigger still pins doc_id, so this '
  'cannot be used to book with an unrelated clinician.';
