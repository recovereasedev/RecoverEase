-- ===========================================================================
-- Rollback of migration 42 (doctor_appointment_reminder_setting)
-- ===========================================================================
-- Every doctor is sent their appointment reminders again, as before 42:
-- `dispatch_appointment_reminders` goes back to migration 31's body, word for
-- word, the guard trigger and its function go, and the column goes with each
-- doctor's choice in it. Applied as a new migration, with approval
-- (tests/db/doctor-reminder-setting.test.ts).
--
-- Roll the website back first: from this branch the doctor's My profile
-- page reads and saves the column, and its Reminder settings would fail
-- once it is gone. Nothing else depends on 42, and no reminder already
-- written changes.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'doctor'
       and column_name = 'doc_appointment_reminder_is_enabled'
  ) then
    raise exception 'Migration 42 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Migration 31's reminder job, which sends every doctor theirs.
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
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message);

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

-- And migration 18's description of it.
comment on function public.dispatch_appointment_reminders(integer) is
  'Creates one appointment notification for the assigned clinician and one '
  'for the patient, for each scheduled or confirmed appointment falling '
  'within lead_hours. Returns the number of notifications created (two per '
  'appointment). Idempotent: appointment_reminder_sent_at keeps each '
  'appointment to a single reminder however often this runs.';

drop trigger if exists doctor_protect_reminder_preference on public.doctor;
drop function if exists public.doctor_guard_reminder_preference();

alter table public.doctor drop column doc_appointment_reminder_is_enabled;
