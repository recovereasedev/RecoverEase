-- ===========================================================================
-- RecoverEase — 58. A medicine's own instructions
-- ===========================================================================
-- A prescription carries general notes (`prescription_notes`), which apply to
-- every medicine on it. A medicine had nowhere for instructions of its own -
-- "before meals" for one, "with water" for another. This adds that field to
-- the medicine's schedule:
--
--   medication_schedule.medication_schedule_instructions   text, nullable
--
-- It is the doctor's own wording. Nothing writes it but the doctor, and
-- nothing is copied into it: every existing schedule keeps NULL, and the
-- prescription's notes stay where they are.
--
-- It is optional. When present it is not blank and at most 500 characters,
-- the limit the form shows; "none" is NULL, never an empty string.
--
-- Who may read and write it does not change, because no policy does. The
-- policies of migration 6 already decide this for the whole row:
--
--   * medication_schedule_select        - the patient, their doctor, and the
--                                         clinic's administrator, read it;
--   * medication_schedule_insert_doctor - only the patient's own doctor adds
--                                         a schedule;
--   * medication_schedule_update_doctor - only the patient's own doctor
--                                         updates one.
--
-- A patient has no update policy on a schedule, so cannot change it. The
-- guard of migration 48 fixes a schedule's times, frequency, start date and
-- prescription; the instructions are not among them and can be corrected.
-- No trigger fires on this column: doses, reminders and the schedule itself
-- are untouched by a change to it.
--
-- Rollback: supabase/rollbacks/20260902100058_medication_schedule_instructions.down.sql
-- ===========================================================================

-- Adding the column and its check locks `medication_schedule`, which the
-- reminder jobs read - the pre-dose job every minute. Waiting at most 3
-- seconds for that lock, the migration fails rather than holding the website
-- up behind it (docs/deployment.md, "Migration timing and run history"). A
-- plain SET, not SET LOCAL, so it holds whether or not the runner wraps this
-- file in one transaction; it is reset at the end.
set lock_timeout = '3s';

-- One statement, so the table is locked once. No default: every existing
-- row reads NULL without being rewritten, and the check passes on NULL.
alter table public.medication_schedule
  add column medication_schedule_instructions text,
  add constraint medication_schedule_instructions_valid
    check (
      medication_schedule_instructions is null
      or (
        btrim(medication_schedule_instructions) <> ''
        and char_length(medication_schedule_instructions) <= 500
      )
    );

comment on column public.medication_schedule.medication_schedule_instructions is
  'The doctor''s instructions for this one medicine, apart from the '
  'prescription''s general notes. Optional; at most 500 characters.';

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
