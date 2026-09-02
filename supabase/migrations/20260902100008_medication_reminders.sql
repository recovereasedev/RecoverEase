-- ===========================================================================
-- RecoverEase — 09. Medication reminder dispatch
-- ===========================================================================
-- Modules 4.2 "Configure Automated Medication Reminders" (doctor), 4.7
-- "Receive Medication Reminders" (patient) and 4.9 "Configure Medication
-- Reminder Preferences" (patient).
--
-- Migration 08 generates one row per due dose and later marks unrecorded
-- doses as missed. Between those two steps the ERD provides
-- `medicationLogFollowUpSentAt` — and until now nothing wrote it, so no
-- reminder was ever sent. This migration closes that gap.
--
-- Reading of the ERD columns, stated so it can be checked:
--
--   medication_log_follow_up_sent_at
--     Named "follow up", and it hangs off an individual dose. It records
--     that we have already chased THIS dose, which is what makes the
--     dispatcher safe to run on a schedule.
--
--   pat_reminder_is_enabled
--     The patient's opt-out (module 4.9). Doses still appear in the app.
--
--   pat_reminder_preferred_time
--     The earliest clock time, in the clinic's zone, at which that patient
--     is willing to be chased on a given day. A patient who nominates 09:00
--     is not pinged at 06:30 about a 06:00 dose; the follow-up waits.
--     NULL means no preference, so it goes out as soon as the grace period
--     has passed.
-- ===========================================================================

create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone       text;
  dispatched integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in clinic-local
       -- terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone zone)::time) >= p.pat_reminder_preferred_time
       )
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_follow_up_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- predicate against the just-updated row, and skips it — so two
       -- schedulers firing at once cannot double-notify.
       and ml.medication_log_follow_up_sent_at is null
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select due.user_id,
         'medication',
         format(
           'Have you taken your %s (%s)? It was due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone zone,
             'HH24:MI'
           )
         )
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

comment on function public.dispatch_medication_reminders(integer) is
  'Modules 4.2/4.7. Sends one follow-up notification per unrecorded dose, '
  'stamping medication_log_follow_up_sent_at in the same statement so it is '
  'idempotent and safe to run on a schedule. Honours the patient''s '
  'reminder opt-out and preferred time of day.';

-- Runs as a scheduled job with elevated privilege, never from a browser.
revoke all on function public.dispatch_medication_reminders(integer)
  from public, anon, authenticated;

grant execute on function public.dispatch_medication_reminders(integer)
  to service_role;
