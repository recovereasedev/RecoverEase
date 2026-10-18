-- ===========================================================================
-- RecoverEase — 30. A reminder before each dose is due
-- ===========================================================================
-- The 2nd-half plan, section 5: for a dose due at 08:00, a reminder at 07:50
-- - ten minutes before, unless the clinic sets another lead time - and none
-- once the dose is marked taken. Until now the only medication reminder was
-- the follow-up (migration 09), sent 30 minutes after a dose still
-- unrecorded. That stays exactly as it is; this adds the reminder before.
--
--   * `medication_log.medication_log_pre_dose_sent_at`: stamped when a dose's
--     reminder has been sent, so it is sent once however often the job runs -
--     the follow-up's guard, beside it, and independent of it. Only the
--     reminder job writes it: a direct client write is refused, as migration
--     22 refuses one of the appointment reminder's mark.
--   * The lead time is each clinic's: its `medication.reminder_lead_minutes`
--     setting, written by its Clinic Admin, when that is 5, 10, 15 or 30;
--     ten minutes otherwise, including when it was never set.
--   * Sent only for a dose still pending and not yet due, within the lead
--     time of being due, to a patient who has reminders on, once their
--     preferred time of day has been reached - the follow-up's own rule, the
--     earliest they want to be contacted - and never for a dose after its
--     course's end date. A dose marked taken, or missed, gets nothing.
--   * Not sent late. A dose already due when the job runs - the job did not
--     run between the lead time and the due time - is the follow-up's to
--     chase, not this reminder's.
--   * `dispatch_medication_pre_dose_reminders()` runs every minute from
--     pg_cron, so a ten-minute reminder goes out within a minute of 07:50. A
--     coarser cadence could not keep to the lead time: the follow-up's 15
--     minutes would send a 10-minute reminder anywhere from 10 minutes before
--     the dose to 5 after it.
--
-- Independent of migration 34: it touches nothing 34 does
-- (tests/db/medication-pre-dose-reminders.test.ts applies it after 33, 35
-- and 36 without 34, as production has them).
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql,
-- applied as a new migration with approval.
-- ===========================================================================

-- Migration 31's clinic settings must be there, and this not yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 37 needs migration 31 first. Nothing was applied.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'medication_log'
       and column_name = 'medication_log_pre_dose_sent_at'
  ) then
    raise exception 'Migration 37 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The reminder's own record
-- ---------------------------------------------------------------------------

alter table public.medication_log
  add column medication_log_pre_dose_sent_at timestamptz;

comment on column public.medication_log.medication_log_pre_dose_sent_at is
  'When the reminder before this dose was due went out; empty until then. '
  'Written only by dispatch_medication_pre_dose_reminders.';

-- Migration 22's rule for the appointment reminder's mark, for this one. The
-- reminder job runs as its owner and the cron job as postgres; only the Data
-- API's end-user roles are refused. Not SECURITY DEFINER, for migration 22's
-- reason: it would then always see its own owner as current_user.
create or replace function public.medication_log_guard_pre_dose_mark()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  changed boolean;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      changed := new.medication_log_pre_dose_sent_at is not null;
    else
      changed := new.medication_log_pre_dose_sent_at
                 is distinct from old.medication_log_pre_dose_sent_at;
    end if;

    if changed then
      raise exception
        'medication_log_pre_dose_sent_at is managed by the system and cannot be changed directly'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.medication_log_guard_pre_dose_mark() is
  'Refuses a direct client write of medication_log_pre_dose_sent_at: an '
  'insert with the mark set, or an update that changes it, by the anon or '
  'authenticated role. The reminder job writes it as its owner and is '
  'unaffected. Run only by the medication_log_guard_pre_dose_mark trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.medication_log_guard_pre_dose_mark()
  from public, anon, authenticated;

create trigger medication_log_guard_pre_dose_mark
  before insert or update of medication_log_pre_dose_sent_at on public.medication_log
  for each row
  execute function public.medication_log_guard_pre_dose_mark();

comment on trigger medication_log_guard_pre_dose_mark on public.medication_log is
  'Keeps medication_log_pre_dose_sent_at out of reach of direct client writes.';

-- ---------------------------------------------------------------------------
-- The reminder
-- ---------------------------------------------------------------------------

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
            or (ml.medication_log_scheduled_at at time zone r.zone)::date
               <= ms.medication_schedule_end_date)
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

comment on function public.dispatch_medication_pre_dose_reminders() is
  'Plan section 5. Sends one reminder per pending dose before it is due, '
  'within its clinic''s medication.reminder_lead_minutes (5, 10, 15 or 30; '
  'otherwise 10), stamping medication_log_pre_dose_sent_at in the same '
  'statement so it is idempotent and safe to run on a schedule. Honours the '
  'patient''s reminder opt-out and preferred time of day and the course''s '
  'end date.';

-- Runs as a scheduled job with elevated privilege, never from a browser.
revoke all on function public.dispatch_medication_pre_dose_reminders()
  from public, anon, authenticated;

grant execute on function public.dispatch_medication_pre_dose_reminders()
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
-- Guarded exactly as migrations 09 and 18 are: PGlite has no pg_cron, and a
-- deployment without it should skip and log rather than abort.
do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; the pre-dose medication reminder job was NOT '
      'scheduled. Call dispatch_medication_pre_dose_reminders() every minute '
      'from an external scheduler instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Every minute: the lead time is counted in minutes, and the duplicate
  -- guard is per dose, so the run that first finds a dose inside its lead
  -- time sends the reminder and every later run finds nothing to do.
  perform cron.schedule(
    'recoverease-medication-pre-dose-reminders',
    '* * * * *',
    $job$ select public.dispatch_medication_pre_dose_reminders() $job$
  );

  raise notice 'RecoverEase pre-dose medication reminder job scheduled via pg_cron.';
end
$$;
