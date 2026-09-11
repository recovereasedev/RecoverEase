-- ===========================================================================
-- RecoverEase — 17. The missed-dose grace period comes from System Settings
-- ===========================================================================
-- QA-03. Admin → System settings offers "Missed dose grace period (hours)",
-- stored as system_setting 'medication.reminder_grace_hours', and nothing read
-- it: the overdue job is scheduled as mark_overdue_medication_logs(6)
-- (migration 10), so a dose was written off six hours after it was due
-- whatever the setting said. Production holds '6', which hid the gap.
--
-- The function now reads the setting itself, so the scheduled job does not
-- change and the value lives in one place:
--
--   * A stored value is used when it is a whole number of hours from 1 to 24
--     in ASCII digits. Whitespace around it and leading zeros are ignored.
--     The pattern alone decides, before anything is cast, so no stored text
--     can make the job raise — a job failing every hour would show only in
--     cron's run history.
--   * Anything else — no row, 0, a negative, a decimal, text, an empty value,
--     more than 24 — is ignored, and the function's argument is used
--     instead. The job passes 6, the behaviour before this migration.
--   * The argument is not clamped. It is the fallback for a missing or
--     unusable setting, and whoever passes it does so deliberately.
--   * At least an hour keeps the order migration 10 relies on: the reminder
--     job chases a dose 30 minutes after it is due, so a dose is chased
--     before it is written off.
--
-- The value is read at each run, so a change applies at the next run to every
-- dose still pending: lowering it writes off a dose already later than the
-- new period, and raising it never restores a dose already marked missed.
--
-- Only this function reads the setting. The reminder job keeps its own
-- 30-minute rule, and dose generation is untouched.
-- ===========================================================================

-- Migration 16's function, unchanged except for how long the grace is.
create or replace function public.mark_overdue_medication_logs(
  grace_hours integer default 6
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone    text;
  stored  text;
  grace   integer := grace_hours;
  updated integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  -- The administrator's grace period, when it is one the job can use (QA-03).
  select system_setting_value
    into stored
    from public.system_setting
   where system_setting_key = 'medication.reminder_grace_hours';

  if stored ~ '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$' then
    grace := substring(stored from '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$')::integer;
  end if;

  update public.medication_log ml
     set medication_log_status = 'missed'
    from public.medication_schedule ms
   where ms.medication_schedule_id = ml.medication_schedule_id
     and ml.medication_log_status = 'pending'
     and ml.medication_log_scheduled_at
         < now() - make_interval(hours => grace)
     -- Nothing after the course's end date is written off (QA-01).
     and (ms.medication_schedule_end_date is null
          or (ml.medication_log_scheduled_at at time zone zone)::date
             <= ms.medication_schedule_end_date);

  get diagnostics updated = row_count;
  return updated;
end;
$$;

comment on function public.mark_overdue_medication_logs(integer) is
  'Marks pending doses older than the grace period as missed, except doses '
  'dated after their schedule''s end date. The grace period is the '
  'medication.reminder_grace_hours setting when it is a whole number of hours '
  'from 1 to 24; otherwise grace_hours.';

-- ---------------------------------------------------------------------------
-- Grants, restated
-- ---------------------------------------------------------------------------
-- As migrations 11 and 16 note, every migration that replaces a function
-- restates its grants: this runs as a scheduled job, never from a browser.

revoke all on function public.mark_overdue_medication_logs(integer)
  from public, anon, authenticated;
grant execute on function public.mark_overdue_medication_logs(integer)
  to service_role;
