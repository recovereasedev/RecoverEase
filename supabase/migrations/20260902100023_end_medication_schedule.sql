-- ===========================================================================
-- RecoverEase — 16. Ending a medication ends its doses
-- ===========================================================================
-- QA-01. A doctor had no way to end a medication, and a course written with
-- no end date ran forever: the daily job kept its doses thirty days ahead,
-- the reminder job chased every one the patient did not record, and the
-- overdue job wrote each of those off as missed.
--
-- QA-02. Setting an end date directly did not help either. Doses are
-- generated ahead of time and nothing ever removed them, and the reminder
-- and overdue jobs look only at each dose row, never at its schedule — so a
-- schedule could say it had ended while a month of its doses stayed live.
--
-- "End medication" is the end date set to the clinic's today. The course
-- keeps today — an end date is the last day of the course, as it has always
-- been read here (migration 13) — and stops after it. This migration makes
-- that end date mean what it says, however it is set:
--
--   * When a schedule's end date is set or brought earlier, the doses it no
--     longer covers are removed — but only the ones still waiting: pending
--     and not yet due. Those rows are placeholders the generator wrote ahead
--     of time; nobody has acted on them and nothing refers to them. There is
--     no "cancelled" dose status to mark them with instead, and inventing one
--     would ripple through every screen that reads a dose.
--   * Nothing recorded is touched. A dose taken, missed or skipped stays,
--     whatever its date — including one the patient marked ahead of time —
--     and so does a pending dose that has already come due, with its
--     reminder stamp.
--   * The reminder job and the overdue job now skip any dose dated after its
--     schedule's end date. That covers what the removal deliberately leaves:
--     a dose already due when an end date is set in the past is neither
--     chased nor written off as missed.
--   * Generation is unchanged. It already stops at the end date, so a
--     shortened course does not grow back, and the daily extension never
--     runs one past its end.
--
-- Only the end date is handled here. Changing a schedule's times has the
-- same shape of problem (QA-02) and is left for the ticket that adds time
-- editing; nothing in the app changes times today.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Removing the doses an end date no longer covers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the doctor who ends a course may not delete doses
-- themselves — dose rows belong to the patient's record and have no delete
-- policy at all. The trigger decides exactly which rows go; the caller does
-- not.

create or replace function public.medication_schedule_close_ended_doses()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  -- Only doses still waiting to come due: pending, and in the future. The end
  -- date is a clinic-local date, so each dose is compared in clinic time.
  delete from public.medication_log
   where medication_schedule_id = new.medication_schedule_id
     and medication_log_status = 'pending'
     and medication_log_scheduled_at > now()
     and (medication_log_scheduled_at at time zone zone)::date
         > new.medication_schedule_end_date;

  return null;
end;
$$;

comment on function public.medication_schedule_close_ended_doses() is
  'QA-01/QA-02. When a schedule''s end date is set or brought earlier, removes '
  'its doses that are still pending, not yet due, and dated after the end '
  'date. Recorded doses and doses already due are never touched. Run only by '
  'the medication_schedule_close_ended_doses trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.medication_schedule_close_ended_doses()
  from public, anon, authenticated;

-- AFTER triggers fire in name order, so this runs before
-- medication_schedule_fill_slots; the generator then stops at the new end date
-- and puts nothing back.
create trigger medication_schedule_close_ended_doses
  after update of medication_schedule_end_date on public.medication_schedule
  for each row
  when (
    new.medication_schedule_end_date is not null
    and new.medication_schedule_end_date
        is distinct from old.medication_schedule_end_date
  )
  execute function public.medication_schedule_close_ended_doses();

comment on trigger medication_schedule_close_ended_doses on public.medication_schedule is
  'Fires when an end date is set or changed; see the function comment.';

-- ---------------------------------------------------------------------------
-- The reminder job skips doses after the end date
-- ---------------------------------------------------------------------------
-- Migration 09's function, unchanged except for the one condition marked
-- below.

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
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or (ml.medication_log_scheduled_at at time zone zone)::date
               <= ms.medication_schedule_end_date)
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
  'reminder opt-out and preferred time of day, and never chases a dose dated '
  'after its schedule''s end date.';

-- ---------------------------------------------------------------------------
-- The overdue job skips doses after the end date
-- ---------------------------------------------------------------------------
-- Migration 08's function, with the schedule joined in so the same condition
-- can apply.

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
  updated integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  update public.medication_log ml
     set medication_log_status = 'missed'
    from public.medication_schedule ms
   where ms.medication_schedule_id = ml.medication_schedule_id
     and ml.medication_log_status = 'pending'
     and ml.medication_log_scheduled_at
         < now() - make_interval(hours => grace_hours)
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
  'dated after their schedule''s end date.';

-- ---------------------------------------------------------------------------
-- Grants, restated
-- ---------------------------------------------------------------------------
-- As migrations 11 and 13 note, every migration that replaces a function
-- restates its grants: these run as scheduled jobs, never from a browser.

revoke all on function public.dispatch_medication_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.dispatch_medication_reminders(integer)
  to service_role;

revoke all on function public.mark_overdue_medication_logs(integer)
  from public, anon, authenticated;
grant execute on function public.mark_overdue_medication_logs(integer)
  to service_role;
