-- ===========================================================================
-- RecoverEase — 40. A doctor can turn their own appointment reminders off
-- ===========================================================================
-- Module 7.3 "Configure Reminder Settings", the doctor's own: whether *they*
-- are sent the reminder `dispatch_appointment_reminders` writes the day
-- before each of their appointments (migration 18). Until now every doctor
-- got one, with no way to stop it.
--
-- One setting, on the doctor's own row, and nothing else:
--
--   * `doctor.doc_appointment_reminder_is_enabled`, on by default - every
--     doctor who exists, and every doctor added, keeps today's behaviour
--     until they turn it off themselves;
--   * only the doctor may change it. Their clinic's administrator may still
--     update the rest of the row (module 11.3), but not this: it is the
--     doctor's preference, not an account setting. The trigger asks only
--     when the value actually changes, so an administrator's edit to
--     anything else is unaffected;
--   * `dispatch_appointment_reminders` leaves the doctor out of an
--     appointment's reminder when it is off. The patient's reminder is sent
--     exactly as before, the appointment is stamped exactly as before - so
--     turning it back on never sends a reminder for an appointment already
--     reminded - and the count returned is the notifications actually
--     written. The function is migration 31's, word for word, but for that.
--
-- No clinic-wide setting is touched: `system_setting`, the clinic's time
-- zone and missed-dose grace period, the 24-hour lead time the scheduled job
-- passes, and the patients' own reminder preferences are all as they were.
-- There is no personal lead time.
--
-- Rollback: supabase/rollbacks/20260902100040_doctor_appointment_reminder_setting.down.sql
-- ===========================================================================

alter table public.doctor
  add column if not exists doc_appointment_reminder_is_enabled boolean not null default true;

comment on column public.doctor.doc_appointment_reminder_is_enabled is
  'Module 7.3: whether this doctor is sent the reminder the day before each '
  'of their appointments. Changed only by the doctor (migration 40).';

-- ---------------------------------------------------------------------------
-- Only the doctor changes it
-- ---------------------------------------------------------------------------
-- A signed-in user other than the doctor is refused. The service role and
-- the database's own jobs carry no user and are not; nothing of theirs
-- writes it.

create or replace function public.doctor_guard_reminder_preference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and (select auth.uid()) is distinct from old.user_id then
    raise exception 'Only the doctor can change their own reminder settings'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- Not callable through the Data API; firing a trigger needs no EXECUTE
-- (migration 10).
revoke all on function public.doctor_guard_reminder_preference() from public, anon, authenticated;

drop trigger if exists doctor_protect_reminder_preference on public.doctor;
create trigger doctor_protect_reminder_preference
  before update of doc_appointment_reminder_is_enabled on public.doctor
  for each row
  when (old.doc_appointment_reminder_is_enabled is distinct from new.doc_appointment_reminder_is_enabled)
  execute function public.doctor_guard_reminder_preference();

-- ---------------------------------------------------------------------------
-- The reminder job honours it
-- ---------------------------------------------------------------------------

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

-- Migration 18's description, but for the count: two per appointment, or one
-- where the doctor has turned theirs off.
comment on function public.dispatch_appointment_reminders(integer) is
  'Creates one appointment notification for the assigned clinician, unless '
  'they have turned their appointment reminders off (migration 40), and one '
  'for the patient, for each scheduled or confirmed appointment falling '
  'within lead_hours. Returns the number of notifications created. '
  'Idempotent: appointment_reminder_sent_at keeps each appointment to a '
  'single reminder however often this runs.';
