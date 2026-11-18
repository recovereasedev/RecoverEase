-- ===========================================================================
-- Rollback of migration 59 (medication_schedule_reminder_control)
-- ===========================================================================
-- Removes the doctor's reminder switch: the two columns, the trigger and its
-- function go, and the three functions that read the switch go back to
-- exactly what migration 53 left. Applied as a new migration, with approval
-- (tests/db/medication-reminder-controls.test.ts).
--
-- THIS DELETES DATA AND RESUMES REMINDERS: every doctor's "off" is lost with
-- the column, and every medicine is reminded about again from the next run
-- of the jobs, as before 59. List the medicines switched off first if they
-- must be known:
--
--   select medication_schedule_id, medication_schedule_name
--     from public.medication_schedule
--    where not medication_schedule_reminders_is_enabled;
--
-- No dose, notification, schedule field or patient setting changes.
--
-- Roll the website back first: from 59 on it reads and writes the column.
-- 53's down-script refuses while 59 is installed, so 59 goes back before it.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'medication_schedule'
       and column_name = 'medication_schedule_reminders_is_enabled'
  ) then
    raise exception 'Migration 59 is not applied. Nothing was changed.';
  end if;

  -- Migration 60 added "the patient's care is open" to the reminder functions
  -- this restores. Restoring them over it would remind discharged patients.
  if to_regprocedure('app_private.patient_care_is_open(uuid)') is not null then
    raise exception 'Roll back migration 60 first: it replaced the reminder functions this restores. Nothing was changed.';
  end if;
end
$$;

-- Dropping the trigger and columns locks `medication_schedule`, which the
-- reminder jobs read. Waiting at most 3 seconds for that lock, the rollback
-- fails rather than holding the website up behind it. It comes after the
-- check, so a refusal changes no setting, and it is reset at the end.
set lock_timeout = '3s';

-- The three readers first, as migration 53 left them, so nothing reads a
-- column that is about to go.

create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           c.clinic_timezone as zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join public.clinic c
        on c.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone c.clinic_timezone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
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
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Have you taken your %s (%s)? It was due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_follow_up', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function public.dispatch_medication_pre_dose_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each clinic's lead time, as its settings hold it: 5, 10, 15 or 30
  -- minutes, and ten for anything else. Leading zeros and spaces around the
  -- number are read past, as the grace period's are.
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*(5|10|15|30)\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_lead_minutes'),
             10
           ) as lead_minutes
      from public.clinic c
  ),
  due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           r.zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join clinic_rule r
        on r.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already reminded. This is the duplicate guard.
       and ml.medication_log_pre_dose_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Not yet due, and due within the clinic's lead time. The half hour is
       -- the longest lead time a clinic can set: it bounds the read of
       -- medication_log_due_idx to the next 30 minutes, where the slots run
       -- 30 days ahead, on a job that runs every minute.
       and ml.medication_log_scheduled_at > now()
       and ml.medication_log_scheduled_at <= now() + interval '30 minutes'
       and ml.medication_log_scheduled_at
           <= now() + make_interval(mins => r.lead_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone r.zone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_pre_dose_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot: a second
       -- run that overlaps this one re-reads the row it waited for and skips
       -- it, and a dose marked taken meanwhile is not reminded about.
       and ml.medication_log_pre_dose_sent_at is null
       and ml.medication_log_status = 'pending'
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Your %s (%s) is due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_pre_dose', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function app_private.push_source_is_current(
  source_event  text,
  medication_log_id uuid,
  appointment_id uuid,
  due_at        timestamptz,
  owner         uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when source_event in ('medication_pre_dose', 'medication_follow_up') then exists (
      select 1
        from public.medication_log ml
        join public.medication_schedule ms on ms.medication_schedule_id = ml.medication_schedule_id
        join public.prescription pr on pr.prescription_id = ms.prescription_id
        join public.patient p on p.pat_id = pr.pat_id
       where ml.medication_log_id = push_source_is_current.medication_log_id
         and p.user_id = owner
         -- Not yet recorded (taken, skipped or missed) ...
         and ml.medication_log_status = 'pending'
         -- ... still the dose it was about, not one moved to another time ...
         and ml.medication_log_scheduled_at = due_at
         -- ... within the course's dates ...
         and ml.medication_log_dose_date >= ms.medication_schedule_start_date
         and (ms.medication_schedule_end_date is null
              or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
         -- ... and the patient still wants medication reminders.
         and p.pat_reminder_is_enabled
         -- A "due soon" reminder is pointless half an hour after the dose.
         and (push_source_is_current.source_event = 'medication_follow_up'
              or now() <= ml.medication_log_scheduled_at + interval '30 minutes')
    )
    when source_event = 'appointment_reminder' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status in ('scheduled', 'confirmed')
         -- An approved reschedule moves appointment_date: the old reminder
         -- is about a time that no longer exists.
         and a.appointment_date = due_at
         and a.appointment_date > now()
    )
    when source_event = 'appointment_cancellation' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status = 'cancelled'
    )
    else false
  end
$$;

drop trigger if exists medication_schedule_stamp_reminders on public.medication_schedule;
drop function if exists public.medication_schedule_stamp_reminders();

alter table public.medication_schedule
  drop column medication_schedule_reminders_is_enabled,
  drop column medication_schedule_reminders_enabled_at;

reset lock_timeout;
