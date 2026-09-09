-- ===========================================================================
-- RecoverEase — 11. Upcoming appointment reminders
-- ===========================================================================
-- Module 6.5 "Receive Appointment Reminders".
--
-- Every part of this already existed except the part that creates the
-- reminder: `notification_type` has carried 'appointment' since migration 03,
-- the notifications page renders that type with a calendar icon, and its
-- empty state has been telling people "Reminders about medication and
-- appointments will appear here" — a promise nothing kept. Production has
-- 14 medication notifications, 2 chat_critical, and zero appointment ones,
-- ever. This closes that gap and nothing else.
--
-- Shaped after `dispatch_medication_reminders` deliberately, because a second
-- notification mechanism is the thing most worth avoiding here:
--
--   * one nullable timestamp on the row being chased is the duplicate guard;
--   * the stamping UPDATE re-checks that guard so two concurrent runs cannot
--     both notify;
--   * the INSERT joins the stamped set, so a notification exists only for a
--     row this statement actually claimed;
--   * `security definer` with an empty search_path, revoked from everyone
--     and granted to service_role alone.
--
-- Both sides are told, because both can act on it: the clinician arranges
-- their day around it and the patient has to travel to it.
--
-- What the message says is deliberately thin. The clinician's names the
-- patient, which they already see on every screen listing that appointment.
-- The patient's names nobody and nothing clinical — it is a time and a date,
-- because a notification is the least private surface in the product and
-- carries no access control of its own beyond who it belongs to.
--
-- On not saying "tomorrow": with a 24-hour lead an appointment can still fall
-- on the same calendar day — 01:00 now, 23:00 tonight is 22 hours away — so
-- the word would sometimes be wrong. The real date and time is always right,
-- and it matches how the medication reminder states its due time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The duplicate guard
-- ---------------------------------------------------------------------------
-- Mirrors `medication_log_follow_up_sent_at`: it hangs off the single row
-- being chased and records that this appointment's reminder has gone out.
-- Nullable with no default, so every appointment that already exists is
-- correctly "not yet reminded" and the backfill is nothing.
alter table public.appointment
  add column if not exists appointment_reminder_sent_at timestamptz;

comment on column public.appointment.appointment_reminder_sent_at is
  'When the upcoming-appointment reminder was dispatched for this '
  'appointment. NULL means it has not been sent. Written only by '
  'dispatch_appointment_reminders, which uses it as its duplicate guard.';

-- ---------------------------------------------------------------------------
-- The dispatcher
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
    select a.appointment_id,
           a.appointment_date,
           d.user_id as doctor_user_id,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
     -- Only an appointment that is still going to happen. A cancelled,
     -- completed or no_show appointment is settled, and reminding anyone
     -- about it would be worse than saying nothing.
     where a.appointment_status in ('scheduled', 'confirmed')
       -- Already reminded. This is the duplicate guard.
       and a.appointment_reminder_sent_at is null
       -- Still ahead of us: never chase an appointment that has passed,
       -- however it got left behind.
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- against the just-updated row and skips it, so two schedulers firing
       -- at once cannot double-notify.
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from due
    -- Only notify for appointments this statement actually stamped.
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message);

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

comment on function public.dispatch_appointment_reminders(integer) is
  'Creates one appointment notification for the assigned clinician and one '
  'for the patient, for each scheduled or confirmed appointment falling '
  'within lead_hours. Returns the number of notifications created (two per '
  'appointment). Idempotent: appointment_reminder_sent_at keeps each '
  'appointment to a single reminder however often this runs.';

-- Runs as a scheduled job with elevated privilege, never from a browser.
revoke all on function public.dispatch_appointment_reminders(integer)
  from public, anon, authenticated;

grant execute on function public.dispatch_appointment_reminders(integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
-- Guarded exactly as migration 10 is: PGlite has no pg_cron and an unguarded
-- CREATE EXTENSION would fail the whole test suite, and a self-hosted
-- deployment without it should skip and log rather than abort.
do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; the appointment reminder job was NOT '
      'scheduled. Call dispatch_appointment_reminders() hourly from an '
      'external scheduler instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Hourly. The lead time is 24 hours and the guard is per appointment, so
  -- the first run after an appointment comes inside that window sends the
  -- pair and stamps it; every later run that hour finds nothing to do.
  -- Hourly rather than daily because a daily pass would put the reminder
  -- anywhere from 24 to 48 hours out depending on when the appointment was
  -- booked, which is not a reminder about tomorrow.
  perform cron.schedule(
    'recoverease-appointment-reminders',
    '0 * * * *',
    $job$ select public.dispatch_appointment_reminders(24) $job$
  );

  raise notice 'RecoverEase appointment reminder job scheduled via pg_cron.';
end
$$;
