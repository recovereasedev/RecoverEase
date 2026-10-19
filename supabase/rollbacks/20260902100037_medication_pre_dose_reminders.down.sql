-- ===========================================================================
-- Rollback of migration 37 (medication_pre_dose_reminders)
-- ===========================================================================
-- Removes the reminder before each dose: its job, its function, the guard on
-- its mark and the mark itself, returning the schema to exactly what 36 left
-- (tests/db/medication-pre-dose-reminders.test.ts). Applied as a new
-- migration, with approval. Roll this back before 36's.
--
-- Roll the website back first: the settings page from 37 on offers the lead
-- time, which nothing reads once this has run. Kept: every dose, every
-- reminder already sent (they are notifications like any other), and each
-- clinic's `medication.reminder_lead_minutes` setting, which is data - delete
-- it separately if it should go too. The follow-up reminder is untouched.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'medication_log'
       and column_name = 'medication_log_pre_dose_sent_at'
  ) then
    raise exception 'Migration 37 is not applied. Nothing was changed.';
  end if;
end
$$;

-- The job first, so nothing calls the function being removed. Nested, so
-- `cron.job` is only read where pg_cron exists.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid)
       from cron.job j
      where j.jobname = 'recoverease-medication-pre-dose-reminders';
  end if;
end
$$;

drop function public.dispatch_medication_pre_dose_reminders();

drop trigger medication_log_guard_pre_dose_mark on public.medication_log;
drop function public.medication_log_guard_pre_dose_mark();

alter table public.medication_log drop column medication_log_pre_dose_sent_at;
