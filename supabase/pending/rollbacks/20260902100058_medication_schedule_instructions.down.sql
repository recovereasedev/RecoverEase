-- ===========================================================================
-- Rollback of migration 58 (medication_schedule_instructions)
-- ===========================================================================
-- Removes `medication_schedule.medication_schedule_instructions` and its
-- check, back to the schema before 58. Applied as a new migration, with
-- approval (tests/db/medication-instructions.test.ts).
--
-- THIS DELETES DATA: every instruction a doctor has written for a medicine
-- since 58 goes with the column, and cannot be brought back from here. Export
-- them first if they must be kept:
--
--   select medication_schedule_id, medication_schedule_instructions
--     from public.medication_schedule
--    where medication_schedule_instructions is not null;
--
-- Nothing else changes: schedules, doses, reminders and prescription notes
-- are untouched.
--
-- Roll the website back first. The website from 58 on sends this column when
-- a doctor writes instructions, and that save fails once the column is gone.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'medication_schedule'
       and column_name = 'medication_schedule_instructions'
  ) then
    raise exception 'Migration 58 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the column locks `medication_schedule`, which the reminder jobs
-- read. Waiting at most 3 seconds for that lock, the rollback fails rather
-- than holding the website up behind it. It comes after the check, so a
-- refusal changes no setting, and it is reset at the end.
set lock_timeout = '3s';

-- The check goes with its column.
alter table public.medication_schedule
  drop column medication_schedule_instructions;

reset lock_timeout;
