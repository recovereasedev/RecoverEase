-- ===========================================================================
-- RecoverEase — 67. The doctor switches a medicine's reminders on or off
-- ===========================================================================
-- Re-landed from pending migration 59 (merged in PR #89/#88, never applied to
-- production), renumbered after 61. Unchanged but for this note and its
-- numbers; "migration 59" below means this migration.
--
-- Every medicine a patient is prescribed is reminded about: a reminder before
-- each dose (migration 37) and a follow-up for a dose not recorded
-- (migration 8). Some medicines should not be - one taken only when needed,
-- for example. The patient's doctor can now switch reminders off for one
-- medicine, and on again:
--
--   medication_schedule.medication_schedule_reminders_is_enabled
--     boolean, not null, default true
--   medication_schedule.medication_schedule_reminders_enabled_at
--     timestamptz, null until reminders are switched back on
--
-- The default is the behaviour until now: every existing schedule, and every
-- new one, has reminders on unless the doctor switches them off. No row is
-- rewritten and nothing is set to false.
--
-- A reminder is sent only when BOTH hold: the doctor has reminders on for
-- that medicine, and the patient wants medication reminders
-- (`pat_reminder_is_enabled`, module 4.9). Neither overrides the other, and
-- the patient's choice is not touched.
--
-- What reads the switch - three functions, each exactly as migration 53 left
-- it but for the lines marked (59):
--
--   * public.dispatch_medication_pre_dose_reminders()  - the reminder before
--     a dose;
--   * public.dispatch_medication_reminders(integer)    - the follow-up;
--   * app_private.push_source_is_current(...)          - the check a phone
--     reminder already queued gets before it is delivered, so one waiting
--     when the doctor switches the medicine off is dropped, as one is when
--     the patient opts out.
--
-- Web Push has no writer of its own: it delivers the notifications the two
-- jobs write. The doctor's dose-conflict alerts (migration 48) go to the
-- doctor, not the patient, and are not reminders; they are unchanged.
--
-- Switching back on. The reminder before a dose resumes with the next dose
-- still ahead. The follow-up resumes with doses that come due from then on:
-- `medication_schedule_reminders_enabled_at` records the moment, and a dose
-- that came due before it is not chased, so switching reminders on never
-- sends a run of reminders about the hours they were off. The database
-- stamps it itself; a value sent by a writer is ignored. A reminder already
-- sent is never sent again: each job's own mark on the dose is unchanged.
--
-- What does not read it, and is unchanged: dose generation
-- (`generate_medication_log_slots`, `extend_all_medication_log_slots`), the
-- missed-dose job (`mark_overdue_medication_logs`), adherence, the patient's
-- checklist, every job's schedule, the clinic's lead time and grace period,
-- and appointment reminders. A dose of a medicine with reminders off is
-- still generated, still recordable, and still becomes missed.
--
-- Who may change it is the row's existing rule (migration 6): only the
-- patient's own doctor updates a schedule; the patient reads it and has no
-- update policy. No policy or grant changes.
--
-- Rollback: supabase/rollbacks/20260902100067_medication_schedule_reminder_control.down.sql
-- ===========================================================================

-- Adding the columns and the trigger locks `medication_schedule`, which the
-- reminder jobs read - the pre-dose job every minute. Waiting at most 3
-- seconds for that lock, the migration fails rather than holding the website
-- up behind it (docs/deployment.md, "Migration timing and run history"). A
-- plain SET, not SET LOCAL, so it holds whether or not the runner wraps this
-- file in one transaction; it is reset at the end.
set lock_timeout = '3s';

-- One statement, so the table is locked once. A constant default is not a
-- rewrite: every existing row reads true without being touched.
alter table public.medication_schedule
  add column if not exists medication_schedule_reminders_is_enabled boolean not null default true,
  add column if not exists medication_schedule_reminders_enabled_at timestamptz;

comment on column public.medication_schedule.medication_schedule_reminders_is_enabled is
  'Whether RecoverEase reminds the patient about this medicine. Set by the '
  'patient''s doctor; on unless switched off. A reminder also needs the '
  'patient''s own pat_reminder_is_enabled. Doses are generated and become '
  'missed regardless.';

comment on column public.medication_schedule.medication_schedule_reminders_enabled_at is
  'When reminders were last switched back on, or null if never switched '
  'off and on. Follow-ups are sent only for doses due from then. Stamped by '
  'the database; a value sent by a writer is ignored.';

-- ---------------------------------------------------------------------------
-- The moment reminders come back on is the database's to record
-- ---------------------------------------------------------------------------

create or replace function public.medication_schedule_stamp_reminders()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.medication_schedule_reminders_enabled_at := null;
  elsif new.medication_schedule_reminders_is_enabled
        and not old.medication_schedule_reminders_is_enabled then
    new.medication_schedule_reminders_enabled_at := now();
  else
    new.medication_schedule_reminders_enabled_at := old.medication_schedule_reminders_enabled_at;
  end if;
  return new;
end;
$$;

comment on function public.medication_schedule_stamp_reminders() is
  'Records when a medicine''s reminders are switched back on, and ignores '
  'any value a writer sends for that moment. Run only by its trigger.';

revoke all on function public.medication_schedule_stamp_reminders() from public, anon, authenticated;

drop trigger if exists medication_schedule_stamp_reminders on public.medication_schedule;
create trigger medication_schedule_stamp_reminders
  before insert or update on public.medication_schedule
  for each row
  execute function public.medication_schedule_stamp_reminders();

-- ---------------------------------------------------------------------------
-- The three readers, as migration 53 left them; only the lines marked (59)
-- are new. CREATE OR REPLACE keeps each one's owner, grants and comment.
-- ---------------------------------------------------------------------------

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
       -- (59) The doctor has reminders on for this medicine ...
       and ms.medication_schedule_reminders_is_enabled
       -- (59) ... and the dose came due after they were last switched back on,
       -- (59) so switching them on does not chase what came due while they were off.
       and (ms.medication_schedule_reminders_enabled_at is null
            or ml.medication_log_scheduled_at >= ms.medication_schedule_reminders_enabled_at)
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
       -- (59) The doctor has reminders on for this medicine.
       and ms.medication_schedule_reminders_is_enabled
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
         -- (59) ... and the doctor has reminders on for this medicine.
         and ms.medication_schedule_reminders_is_enabled
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

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
