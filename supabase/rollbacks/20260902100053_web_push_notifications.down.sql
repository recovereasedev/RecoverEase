-- ===========================================================================
-- Rollback of migration 53 (web_push_notifications)
-- ===========================================================================
-- Removes Web Push and the notification source columns: the queue, every
-- saved device, the trigger on `notification`, the functions, and the four
-- notification writers go back to exactly what migrations 48, 42 and 31 left.
-- Every notification keeps its message, type, time and read state; only the
-- four source columns (null before 53) are dropped.
--
-- Run supabase/manual/web_push_deactivate.sql first if delivery was turned
-- on. This file also removes the job if it is still there.
--
-- Data loss: every patient's push subscription and the queue are deleted.
-- After a re-apply, patients switch phone reminders on again on each device.
--
-- Applied as a new migration, with approval. Refuses when 53 is not there.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'notification'
                    and column_name = 'notification_source') then
    raise exception 'Migration 53 is not applied. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
       from cron.job
      where jobname = 'recoverease-push-deliveries';
  end if;
end
$$;

drop trigger if exists notification_enqueue_push on public.notification;
drop function if exists app_private.enqueue_push_deliveries();
drop function if exists app_private.request_push_dispatch();
drop function if exists public.claim_push_deliveries(integer);
drop function if exists public.complete_push_delivery(uuid, text, integer, text, integer);
drop function if exists public.register_push_subscription(text, text, text, text);
drop function if exists public.unregister_push_subscription(text);
drop function if exists public.push_device_registered(text);
drop function if exists app_private.push_source_is_current(text, uuid, uuid, timestamptz, uuid);
drop table if exists app_private.push_delivery;
drop table if exists app_private.push_subscription;
drop function if exists app_private.push_endpoint_is_allowed(text);

-- The four writers, as they were before 53. ---------------------------------

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
    user_id, notification_type, notification_message
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
         )
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
    user_id, notification_type, notification_message
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
         )
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function public.dispatch_appointment_reminders(
  lead_hours integer default 24
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each message's date and time are in the clinic of the appointment's
  -- doctor - the patient's clinic too, since a patient only ever moves to a
  -- doctor in the same one.
  with due as (
    select a.appointment_id,
           a.appointment_date,
           c.clinic_timezone as zone,
           d.user_id as doctor_user_id,
           d.doc_appointment_reminder_is_enabled as doctor_wants_reminder,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
      join public.clinic  c on c.clinic_id = d.clinic_id
     where a.appointment_status in ('scheduled', 'confirmed')
       and a.appointment_reminder_sent_at is null
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from due
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          -- The doctor's, unless they have turned their reminders off.
          due.doctor_wants_reminder,
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          -- The patient's, always.
          true,
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(is_sent, user_id, message)
   where recipient.is_sent;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function public.appointment_notify_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  zone := app_private.clinic_timezone(app_private.clinic_of_doctor(new.doc_id));

  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from public.patient p
    join public.doctor  d on d.doc_id = new.doc_id
    cross join lateral (
      values
        (
          d.user_id,
          format(
            'The appointment with %s on %s at %s has been cancelled.',
            trim(p.pat_first_name || ' ' || p.pat_last_name),
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          p.user_id,
          format(
            'Your appointment on %s at %s has been cancelled.',
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message)
   where p.pat_id = new.pat_id;

  return null;
end;
$$;

-- Migration 41's policy, as it was.
drop policy if exists notification_insert_doctor_to_patient on public.notification;

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check (
    (select app_private.is_user_my_patient(user_id))
    and notification_type = 'general'
    and chat_session_id is null
    and notification_is_read = false
    and char_length(btrim(notification_message)) between 1 and 1000
  );

comment on policy notification_insert_doctor_to_patient on public.notification is
  'Module 7.1: an active doctor may send their own patient a general, unread '
  'message of up to 1,000 characters. Every other notification is written by '
  'SECURITY DEFINER functions or the service role (migration 41).';

alter table public.notification
  drop constraint if exists notification_source_shape,
  drop constraint if exists notification_source_known,
  drop column if exists notification_appointment_id,
  drop column if exists notification_medication_log_id,
  drop column if exists notification_purpose,
  drop column if exists notification_source;

reset lock_timeout;
