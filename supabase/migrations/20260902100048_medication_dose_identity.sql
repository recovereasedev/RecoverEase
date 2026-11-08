-- ===========================================================================
-- RecoverEase — 48. Medication dose identity, and clock-change conflicts
-- ===========================================================================
-- Until now a dose was recognised only by its exact moment: the unique index
-- medication_log_slot_key on (schedule, medication_log_scheduled_at). That
-- is not enough to know whether a dose already exists:
--
--   * After a clinic's time zone changes to one with a different UTC
--     offset, the nightly extend_all_medication_log_slots works out new
--     moments for days that are already scheduled, and adds a second dose
--     beside each existing one for up to 30 days.
--   * Where clocks spring forward, a dose time that does not exist that day
--     (02:30 when 02:00 jumps to 03:00) resolves to the same moment as a
--     real one (03:30), and the index silently drops one of them.
--   * Where clocks go back, a dose time that happens twice (01:30) is
--     resolved, without anyone deciding, to its second occurrence.
--   * A schedule's times or start date edited through the Data API leave its
--     old pending doses behind beside the new ones.
--
-- This migration:
--
--   1. Gives every dose its identity: the clinic-local date and the
--      wall-clock time it was created for (medication_log_dose_date and
--      medication_log_dose_time), unique per schedule and never changed.
--      Existing rows are given theirs from their moment in their clinic's
--      time zone. No scheduled moment, status, taken_at or reminder stamp
--      changes.
--
--   2. Records every occurrence the scheduler will not turn into a dose as
--      a medication_dose_conflict, for the treating doctor to review:
--        - a time that does not exist that day (nonexistent_local_time),
--        - a time that happens twice that day (ambiguous_local_time),
--        - a time whose moment is already another dose of the schedule
--          (same_moment_collision, after a time zone change).
--      A conflict gets no reminder, is never marked missed, and is never
--      counted as taken. Nothing is dropped and nothing is moved.
--
--      The first two are held for review because no clinical rule for them
--      has been approved. app_private.medication_clock_policy() says so in
--      one place, and only a reviewed migration can change it. The adviser
--      decisions are recorded, PENDING, in
--      docs/medication-clock-change-decisions.md.
--
--   3. Lets the treating doctor resolve a conflict, and nobody else:
--      doctor_resolve_medication_conflict() either sets a time for the dose
--      (on the same clinic-local date, in the future, at no other dose's
--      moment), which then becomes an ordinary dose, or records that it is
--      not given separately. A reason is required for both. Nothing is
--      suggested.
--
--   4. Alerts the treating doctor once when a conflict is found, and once
--      more 24 hours before it if it is still unresolved
--      (dispatch_medication_conflict_alerts, every 15 minutes), deduplicated
--      by a stamp on the conflict itself.
--
--   5. Keeps a schedule's shape fixed: its times, frequency, start date and
--      prescription cannot be edited (end it and add a new one, as the
--      website already does), and a time cannot be listed twice. Ending a
--      schedule closes its unresolved conflicts after the end date as
--      course_ended, recorded and never deleted.
--
--   6. Makes the end-date checks in the follow-up reminder, the pre-dose
--      reminder and the overdue job compare each dose's own date. For every
--      dose in production today that is the same date as before.
--
-- Every path that writes doses or conflicts for a schedule - the generator
-- (from the schedule trigger and the nightly job), the resolution and the
-- end-of-course trigger - first takes one transaction lock per schedule, so
-- none of them can interleave.
--
-- Needs migrations 33 and 37 and refuses to run without them. Independent of
-- 34 (it touches nothing 34 does) and of 47.
--
-- Rollback: supabase/rollbacks/20260902100048_medication_dose_identity.down.sql
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'medication_log'
       and column_name = 'medication_log_pre_dose_sent_at'
  ) or to_regprocedure('app_private.audit_clinic_for(text, uuid, uuid, jsonb)') is null
    or to_regprocedure('app_private.require_super_admin()') is null then
    raise exception 'Migration 48 needs migrations 33 and 37 first. Nothing was applied.';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'medication_log'
       and column_name = 'medication_log_dose_date'
  ) then
    raise exception 'Migration 48 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- medication_log is written every minute by the pre-dose reminder job. Wait
-- at most 3 seconds for any lock rather than hold the website up behind one
-- (docs/deployment.md, "Migration timing and run history"). Reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. A dose's identity
-- ---------------------------------------------------------------------------

alter table public.medication_log
  add column medication_log_dose_date date,
  add column medication_log_dose_time time;

comment on column public.medication_log.medication_log_dose_date is
  'The clinic-local date this dose was created for. With the dose time, the '
  'dose''s identity in its schedule: unique, and never changed.';
comment on column public.medication_log.medication_log_dose_time is
  'The wall-clock time this dose was created for, as the schedule lists it. '
  'Its moment (medication_log_scheduled_at) can read differently after a '
  'time zone change; this does not.';

-- Each existing dose, from its moment in its clinic's time zone - the zone
-- it was created in, as no clinic's time zone has ever changed (checked
-- before applying: every dose's local time is one of its schedule's times).
update public.medication_log ml
   set medication_log_dose_date = (ml.medication_log_scheduled_at at time zone z.zone)::date,
       medication_log_dose_time = (ml.medication_log_scheduled_at at time zone z.zone)::time
  from (
    select ms.medication_schedule_id,
           app_private.clinic_timezone(
             app_private.clinic_of_patient(
               app_private.patient_of_prescription(ms.prescription_id))) as zone
      from public.medication_schedule ms
  ) z
 where z.medication_schedule_id = ml.medication_schedule_id;

alter table public.medication_log
  alter column medication_log_dose_date set not null,
  alter column medication_log_dose_time set not null;

create unique index medication_log_occurrence_key
  on public.medication_log
     (medication_schedule_id, medication_log_dose_date, medication_log_dose_time);

-- An identity is filled in on insert when the writer left it out (a direct
-- insert, as some tests make), and can never change afterwards.
create or replace function public.medication_log_guard_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  if tg_op = 'INSERT' then
    if new.medication_log_dose_date is null or new.medication_log_dose_time is null then
      zone := app_private.clinic_timezone(
        app_private.clinic_of_patient(
          app_private.patient_of_medication_schedule(new.medication_schedule_id)));
      new.medication_log_dose_date := coalesce(
        new.medication_log_dose_date, (new.medication_log_scheduled_at at time zone zone)::date);
      new.medication_log_dose_time := coalesce(
        new.medication_log_dose_time, (new.medication_log_scheduled_at at time zone zone)::time);
    end if;
  elsif new.medication_log_dose_date is distinct from old.medication_log_dose_date
     or new.medication_log_dose_time is distinct from old.medication_log_dose_time then
    raise exception 'A dose''s date and time cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.medication_log_guard_occurrence() is
  'Fills in a dose''s identity on insert when it was left out, from its '
  'moment in its clinic''s time zone, and refuses any change to it after. '
  'Run only by the medication_log_guard_occurrence trigger.';

revoke all on function public.medication_log_guard_occurrence() from public, anon, authenticated;

create trigger medication_log_guard_occurrence
  before insert or update on public.medication_log
  for each row
  execute function public.medication_log_guard_occurrence();

-- ---------------------------------------------------------------------------
-- 2. Conflicts
-- ---------------------------------------------------------------------------

create type public.medication_conflict_reason as enum (
  'nonexistent_local_time',
  'ambiguous_local_time',
  'same_moment_collision'
);

create type public.medication_conflict_resolution as enum (
  'rescheduled',
  'not_given_separately',
  'course_ended'
);

create table public.medication_dose_conflict (
  medication_dose_conflict_id     uuid primary key default gen_random_uuid(),
  medication_schedule_id          uuid not null
                                    references public.medication_schedule
                                      (medication_schedule_id)
                                    on delete cascade,
  -- The occurrence: the same identity a dose has.
  conflict_dose_date              date not null,
  conflict_dose_time              time not null,
  conflict_reason                 public.medication_conflict_reason not null,
  -- The moment PostgreSQL works the time out to. For information only: it
  -- is not when anything is due.
  conflict_at                     timestamptz not null,
  -- The dose already at that moment, for a same_moment_collision.
  conflicting_log_id              uuid
                                    references public.medication_log (medication_log_id)
                                    on delete set null,
  conflict_detected_at            timestamptz not null default now(),
  conflict_resolution             public.medication_conflict_resolution,
  -- The dose a doctor's chosen time created (rescheduled).
  resolved_log_id                 uuid
                                    references public.medication_log (medication_log_id)
                                    on delete set null,
  resolved_by_doc_id              uuid references public.doctor (doc_id),
  conflict_resolved_at            timestamptz,
  conflict_resolution_note        text,
  -- One alert when found, one 24 hours before: each sent once.
  conflict_doctor_alerted_at      timestamptz,
  conflict_doctor_final_alert_at  timestamptz,

  constraint medication_dose_conflict_occurrence_key
    unique (medication_schedule_id, conflict_dose_date, conflict_dose_time),
  constraint medication_dose_conflict_resolution_complete
    check (
      (conflict_resolution is null
         and conflict_resolved_at is null and resolved_by_doc_id is null
         and conflict_resolution_note is null and resolved_log_id is null)
      or (conflict_resolution = 'rescheduled'
         and conflict_resolved_at is not null and resolved_by_doc_id is not null
         and conflict_resolution_note is not null)
      or (conflict_resolution = 'not_given_separately'
         and conflict_resolved_at is not null and resolved_by_doc_id is not null
         and conflict_resolution_note is not null and resolved_log_id is null)
      or (conflict_resolution = 'course_ended'
         and conflict_resolved_at is not null and resolved_by_doc_id is null
         and conflict_resolution_note is null and resolved_log_id is null)
    ),
  constraint medication_dose_conflict_note_length
    check (conflict_resolution_note is null
           or char_length(btrim(conflict_resolution_note)) between 1 and 1000)
);

create index medication_dose_conflict_open_idx
  on public.medication_dose_conflict (conflict_at)
  where conflict_resolution is null;

-- Every foreign key whose parent can be deleted is indexed, as elsewhere.
create index medication_dose_conflict_conflicting_log_id_idx
  on public.medication_dose_conflict (conflicting_log_id);
create index medication_dose_conflict_resolved_log_id_idx
  on public.medication_dose_conflict (resolved_log_id);
create index medication_dose_conflict_resolved_by_doc_id_idx
  on public.medication_dose_conflict (resolved_by_doc_id);

comment on table public.medication_dose_conflict is
  'A dose occurrence the scheduler did not turn into a dose - a time that '
  'does not exist or happens twice that day, or one whose moment is already '
  'another dose of the schedule - held for the treating doctor. Never '
  'reminded, never marked missed, never deleted by a resolution.';

alter table public.medication_dose_conflict enable row level security;

-- Read: whoever may read the patient's doses (the patient, their treating
-- doctor, their clinic's Clinic Admin). Written only by the functions below.
create policy medication_dose_conflict_select
  on public.medication_dose_conflict for select to authenticated
  using (
    (select app_private.can_access_patient(
      (select app_private.patient_of_medication_schedule(medication_schedule_id))
    ))
  );

revoke all on public.medication_dose_conflict from public, anon, authenticated;
grant select on public.medication_dose_conflict to authenticated;

-- Audited as a clinical entry of the patient's clinic: found (insert) and
-- resolved or closed (update). The doctor's note is clinical text, so only
-- the fact that it changed is recorded, never its words.
create trigger medication_dose_conflict_audit
  after insert or update or delete on public.medication_dose_conflict
  for each row
  execute function public.audit_row_change(
    'medication_dose_conflict', 'medication_dose_conflict_id', 'values',
    'conflict_resolution_note');

-- The clinic an audit entry is about: migration 33's, with conflicts.
create or replace function app_private.audit_clinic_for(
  entity    text,
  entity_id uuid,
  actor     uuid,
  details   jsonb
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case entity
      when 'clinic' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_settings' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_admin_account' then
        coalesce((select a.clinic_id from public.admin a where a.admin_id = entity_id),
                 (details ->> 'clinic_id')::uuid)
      when 'doctor' then
        coalesce(app_private.clinic_of_doctor(entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'doctor_account' then app_private.clinic_of_doctor(entity_id)
      when 'doctor_patients' then app_private.clinic_of_doctor(entity_id)
      when 'patient' then app_private.clinic_of_patient(entity_id)
      when 'patient_account' then app_private.clinic_of_patient(entity_id)
      when 'prescription' then
        app_private.clinic_of_patient(app_private.patient_of_prescription(entity_id))
      when 'treatment_plan' then
        app_private.clinic_of_patient(app_private.patient_of_treatment_plan(entity_id))
      when 'appointment' then
        app_private.clinic_of_patient(app_private.patient_of_appointment(entity_id))
      when 'announcement' then
        coalesce((select an.clinic_id from public.announcement an
                   where an.announcement_id = entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'system_setting' then
        coalesce((select s.clinic_id from public.system_setting s
                   where s.system_setting_id = entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'medication_dose_conflict' then
        app_private.clinic_of_patient(app_private.patient_of_medication_schedule(
          coalesce((select mc.medication_schedule_id from public.medication_dose_conflict mc
                     where mc.medication_dose_conflict_id = entity_id),
                   (details #>> '{record,medication_schedule_id}')::uuid)))
      when 'user_account' then app_private.clinic_of_user(entity_id)
      when 'account_password' then app_private.clinic_of_user(entity_id)
    end,
    app_private.clinic_of_user(actor)
  );
$$;

-- ---------------------------------------------------------------------------
-- The clinical rule for clock changes, in one place
-- ---------------------------------------------------------------------------
-- What to do with a dose time that does not exist, or happens twice, on a
-- clock-change day. Both are held for the treating doctor: no other rule has
-- clinical approval (docs/medication-clock-change-decisions.md, A and B,
-- PENDING). Changing this needs a reviewed migration of its own.
create or replace function app_private.medication_clock_policy(occurrence_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case occurrence_kind
    when 'nonexistent_local_time' then 'hold_for_review'
    when 'ambiguous_local_time' then 'hold_for_review'
  end;
$$;

comment on function app_private.medication_clock_policy(text) is
  'The approved handling of a clock-change dose time: hold_for_review for '
  'both kinds until the clinical adviser approves another rule.';

revoke all on function app_private.medication_clock_policy(text) from public, anon, authenticated;

-- One transaction lock per schedule: the generator, a doctor's resolution
-- and the end-of-course trigger take it before writing a schedule's doses or
-- conflicts, so they run one after another.
create or replace function app_private.lock_medication_schedule(target_schedule_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('recoverease.medication_schedule:' || target_schedule_id::text, 0));
$$;

comment on function app_private.lock_medication_schedule(uuid) is
  'Takes the transaction lock that serialises every write of one '
  'schedule''s doses and conflicts.';

revoke all on function app_private.lock_medication_schedule(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The generator
-- ---------------------------------------------------------------------------
-- Same signature, privileges and window as migration 31's. For each day and
-- each distinct time in the window:
--
--   * an occurrence that is already a dose or a conflict is left alone -
--     whatever moment the dose has, and whatever the time zone is now;
--   * a time that does not exist that day, or happens twice, is held as a
--     conflict (the clock policy above);
--   * a time whose moment is already another dose of this schedule is held
--     as a same_moment_collision;
--   * everything else becomes a dose at its moment, with its identity.
--
-- It returns the number of doses created, as before.
create or replace function public.generate_medication_log_slots(
  target_schedule_id uuid,
  horizon_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule    public.medication_schedule%rowtype;
  zone        text;
  today       date;
  window_from date;
  window_to   date;
  occurrence  record;
  local_ts    timestamp;
  moment      timestamptz;
  kind        text;
  existing_id uuid;
  inserted    integer := 0;
  added       integer;
begin
  perform app_private.lock_medication_schedule(target_schedule_id);

  select * into schedule
    from public.medication_schedule
   where medication_schedule_id = target_schedule_id;

  if not found then
    return 0;
  end if;

  -- A dose time is a wall-clock time in the patient's clinic.
  zone := app_private.clinic_timezone(
    app_private.clinic_of_patient(
      app_private.patient_of_prescription(schedule.prescription_id)));

  today := (now() at time zone zone)::date;

  window_from := greatest(schedule.medication_schedule_start_date, today);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    today + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  for occurrence in
    select day::date as dose_date, dose_time
      from generate_series(window_from, window_to, interval '1 day') as day
      cross join (
        select distinct t as dose_time
          from unnest(schedule.medication_schedule_times) as t
      ) as times
     where not exists (
             select 1 from public.medication_log ml
              where ml.medication_schedule_id = target_schedule_id
                and ml.medication_log_dose_date = day::date
                and ml.medication_log_dose_time = times.dose_time)
       and not exists (
             select 1 from public.medication_dose_conflict mc
              where mc.medication_schedule_id = target_schedule_id
                and mc.conflict_dose_date = day::date
                and mc.conflict_dose_time = times.dose_time)
     order by 1, 2
  loop
    local_ts := occurrence.dose_date + occurrence.dose_time;
    moment := local_ts at time zone zone;
    kind := null;
    existing_id := null;

    if (moment at time zone zone) <> local_ts then
      -- Clocks jumped over it: PostgreSQL would move it forward.
      kind := 'nonexistent_local_time';
    elsif exists (
      select 1
        from unnest(array[interval '30 minutes', interval '1 hour', interval '2 hours']) as shift
       where ((moment - shift) at time zone zone) = local_ts
          or ((moment + shift) at time zone zone) = local_ts
    ) then
      -- Clocks went back over it: it happens twice.
      kind := 'ambiguous_local_time';
    end if;

    if kind is not null
       and app_private.medication_clock_policy(kind) is distinct from 'hold_for_review' then
      raise exception 'No approved handling for a % dose time', kind
        using errcode = 'feature_not_supported';
    end if;

    if kind is null then
      select ml.medication_log_id into existing_id
        from public.medication_log ml
       where ml.medication_schedule_id = target_schedule_id
         and ml.medication_log_scheduled_at = moment;
      if found then
        kind := 'same_moment_collision';
      end if;
    end if;

    if kind is null then
      insert into public.medication_log (
        medication_schedule_id, medication_log_scheduled_at,
        medication_log_dose_date, medication_log_dose_time
      )
      values (target_schedule_id, moment, occurrence.dose_date, occurrence.dose_time)
      on conflict do nothing;
      get diagnostics added = row_count;
      inserted := inserted + added;

      -- Not written: something already holds that moment or that identity.
      -- Under the schedule's lock that cannot happen, but if it ever did the
      -- occurrence is recorded for the doctor, never skipped in silence.
      if added = 0 and not exists (
        select 1 from public.medication_log ml
         where ml.medication_schedule_id = target_schedule_id
           and ml.medication_log_dose_date = occurrence.dose_date
           and ml.medication_log_dose_time = occurrence.dose_time
      ) then
        select ml.medication_log_id into existing_id
          from public.medication_log ml
         where ml.medication_schedule_id = target_schedule_id
           and ml.medication_log_scheduled_at = moment;
        insert into public.medication_dose_conflict (
          medication_schedule_id, conflict_dose_date, conflict_dose_time,
          conflict_reason, conflict_at, conflicting_log_id
        )
        values (
          target_schedule_id, occurrence.dose_date, occurrence.dose_time,
          'same_moment_collision', moment, existing_id
        )
        on conflict do nothing;
      end if;
    else
      insert into public.medication_dose_conflict (
        medication_schedule_id, conflict_dose_date, conflict_dose_time,
        conflict_reason, conflict_at, conflicting_log_id
      )
      values (
        target_schedule_id, occurrence.dose_date, occurrence.dose_time,
        kind::public.medication_conflict_reason, moment, existing_id
      )
      on conflict do nothing;
    end if;
  end loop;

  return inserted;
end;
$$;

comment on function public.generate_medication_log_slots(uuid, integer) is
  'Creates one dose per occurrence (schedule, clinic-local date, wall-clock '
  'time) within the horizon that is not already a dose or a conflict, and '
  'holds a time that does not exist, happens twice, or falls on another '
  'dose''s moment as a conflict for the treating doctor. Idempotent, and '
  'serialised per schedule.';

-- ---------------------------------------------------------------------------
-- A schedule's shape is fixed
-- ---------------------------------------------------------------------------

create or replace function public.medication_schedule_guard_shape()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if cardinality(new.medication_schedule_times)
     <> (select count(distinct t) from unnest(new.medication_schedule_times) as t) then
    raise exception 'A schedule cannot list the same time twice'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and (
       new.medication_schedule_times is distinct from old.medication_schedule_times
    or new.medication_schedule_frequency is distinct from old.medication_schedule_frequency
    or new.medication_schedule_start_date is distinct from old.medication_schedule_start_date
    or new.prescription_id is distinct from old.prescription_id
  ) then
    raise exception 'A schedule''s times, frequency, start date and prescription cannot be changed. End it and add a new schedule instead.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.medication_schedule_guard_shape() is
  'Refuses a schedule that lists a time twice, and any change to a '
  'schedule''s times, frequency, start date or prescription, which would '
  'leave its existing doses behind. Run only by its trigger.';

revoke all on function public.medication_schedule_guard_shape() from public, anon, authenticated;

create trigger medication_schedule_guard_shape
  before insert or update on public.medication_schedule
  for each row
  execute function public.medication_schedule_guard_shape();

-- Ending a schedule: migration 31's, comparing each dose's own date, and
-- closing - never deleting - the unresolved conflicts after the end date.
create or replace function public.medication_schedule_close_ended_doses()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.lock_medication_schedule(new.medication_schedule_id);

  -- Only doses still waiting to come due: pending, and in the future, dated
  -- after the end date.
  delete from public.medication_log
   where medication_schedule_id = new.medication_schedule_id
     and medication_log_status = 'pending'
     and medication_log_scheduled_at > now()
     and medication_log_dose_date > new.medication_schedule_end_date;

  update public.medication_dose_conflict
     set conflict_resolution = 'course_ended',
         conflict_resolved_at = now()
   where medication_schedule_id = new.medication_schedule_id
     and conflict_resolution is null
     and conflict_dose_date > new.medication_schedule_end_date;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The end-date checks compare each dose's own date
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

create or replace function public.mark_overdue_medication_logs(
  grace_hours integer default 6
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated integer;
begin
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_grace_hours'),
             grace_hours
           ) as grace
      from public.clinic c
  )
  update public.medication_log ml
     set medication_log_status = 'missed'
    from public.medication_schedule ms
    join public.prescription pr on pr.prescription_id = ms.prescription_id
    join public.patient p on p.pat_id = pr.pat_id
    join public.doctor d on d.doc_id = p.doc_id
    join clinic_rule r on r.clinic_id = d.clinic_id
   where ms.medication_schedule_id = ml.medication_schedule_id
     and ml.medication_log_status = 'pending'
     and ml.medication_log_scheduled_at
         < now() - make_interval(hours => r.grace)
     -- Nothing after the course's end date is written off (QA-01).
     and (ms.medication_schedule_end_date is null
          or ml.medication_log_dose_date <= ms.medication_schedule_end_date);

  get diagnostics updated = row_count;
  return updated;
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

-- ---------------------------------------------------------------------------
-- 3. The treating doctor resolves a conflict
-- ---------------------------------------------------------------------------

create or replace function public.doctor_resolve_medication_conflict(
  target_conflict_id uuid,
  resolution         text,
  new_scheduled_at   timestamptz,
  resolution_note    text
)
returns setof public.medication_dose_conflict
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  this_doctor uuid := app_private.current_doctor_id();
  conflict    public.medication_dose_conflict%rowtype;
  schedule_id uuid;
  zone        text;
  note        text := btrim(resolution_note);
  new_log_id  uuid;
begin
  -- An active doctor's account, before anything about the conflict.
  if this_doctor is null then
    raise exception 'Only a patient''s treating doctor can resolve a dose conflict'
      using errcode = 'insufficient_privilege';
  end if;

  select mc.medication_schedule_id into schedule_id
    from public.medication_dose_conflict mc
   where mc.medication_dose_conflict_id = target_conflict_id;

  -- Another doctor's patient is reported exactly as a conflict that does
  -- not exist: nothing about it is revealed.
  if not found
     or not app_private.is_my_patient(app_private.patient_of_medication_schedule(schedule_id)) then
    raise exception 'That dose conflict could not be found'
      using errcode = 'no_data_found';
  end if;

  perform app_private.lock_medication_schedule(schedule_id);

  select * into conflict
    from public.medication_dose_conflict mc
   where mc.medication_dose_conflict_id = target_conflict_id
   for update;

  if conflict.conflict_resolution is not null then
    raise exception 'This dose conflict has already been resolved'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if note is null or note = '' then
    raise exception 'Enter the reason for this decision'
      using errcode = 'check_violation';
  end if;
  if char_length(note) > 1000 then
    raise exception 'The reason can be at most 1,000 characters'
      using errcode = 'check_violation';
  end if;

  if resolution = 'rescheduled' then
    if new_scheduled_at is null then
      raise exception 'Choose the time for this dose'
        using errcode = 'check_violation';
    end if;

    zone := app_private.clinic_timezone(
      app_private.clinic_of_patient(app_private.patient_of_medication_schedule(schedule_id)));

    if (new_scheduled_at at time zone zone)::date <> conflict.conflict_dose_date then
      raise exception 'The time must be on % in the clinic''s time zone',
        to_char(conflict.conflict_dose_date, 'FMDD Month YYYY')
        using errcode = 'check_violation';
    end if;
    if new_scheduled_at <= now() then
      raise exception 'The time must be in the future'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.medication_log ml
       where ml.medication_schedule_id = schedule_id
         and ml.medication_log_scheduled_at = new_scheduled_at
    ) then
      raise exception 'Another dose of this medicine is already due at that moment'
        using errcode = 'unique_violation';
    end if;

    insert into public.medication_log (
      medication_schedule_id, medication_log_scheduled_at,
      medication_log_dose_date, medication_log_dose_time
    )
    values (schedule_id, new_scheduled_at, conflict.conflict_dose_date, conflict.conflict_dose_time)
    returning medication_log_id into new_log_id;

    update public.medication_dose_conflict
       set conflict_resolution = 'rescheduled',
           resolved_log_id = new_log_id,
           resolved_by_doc_id = this_doctor,
           conflict_resolved_at = now(),
           conflict_resolution_note = note
     where medication_dose_conflict_id = target_conflict_id;

  elsif resolution = 'not_given_separately' then
    if new_scheduled_at is not null then
      raise exception 'A time is only chosen when the dose is given at another time'
        using errcode = 'invalid_parameter_value';
    end if;

    update public.medication_dose_conflict
       set conflict_resolution = 'not_given_separately',
           resolved_by_doc_id = this_doctor,
           conflict_resolved_at = now(),
           conflict_resolution_note = note
     where medication_dose_conflict_id = target_conflict_id;

  else
    raise exception 'Choose either a time for this dose or no separate dose'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    select * from public.medication_dose_conflict mc
     where mc.medication_dose_conflict_id = target_conflict_id;
end;
$$;

comment on function public.doctor_resolve_medication_conflict(uuid, text, timestamptz, text) is
  'The treating doctor''s decision on a dose conflict, with a required '
  'reason: rescheduled (a future moment on the same clinic-local date, at no '
  'other dose''s moment, which becomes an ordinary dose) or '
  'not_given_separately. Final once made. Audited.';

revoke all on function public.doctor_resolve_medication_conflict(uuid, text, timestamptz, text)
  from public, anon;
grant execute on function public.doctor_resolve_medication_conflict(uuid, text, timestamptz, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Alerting the treating doctor
-- ---------------------------------------------------------------------------
-- Once when a conflict is found, and once more 24 hours before it when it is
-- still unresolved - only to the patient's treating doctor, only while their
-- account is active, and nobody else. Each is stamped in the statement that
-- sends it, re-checked at update time, so overlapping runs cannot send it
-- twice (the reminder jobs' own guard).
create or replace function public.dispatch_medication_conflict_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_sent integer;
  final_sent integer;
begin
  with due as (
    select mc.medication_dose_conflict_id,
           d.user_id,
           ms.medication_schedule_name,
           p.pat_first_name,
           p.pat_last_name,
           mc.conflict_dose_date,
           mc.conflict_dose_time
      from public.medication_dose_conflict mc
      join public.medication_schedule ms on ms.medication_schedule_id = mc.medication_schedule_id
      join public.prescription pr on pr.prescription_id = ms.prescription_id
      join public.patient p on p.pat_id = pr.pat_id
      join public.doctor d on d.doc_id = p.doc_id
     where mc.conflict_resolution is null
       and mc.conflict_doctor_alerted_at is null
       and d.doc_is_active
  ),
  stamped as (
    update public.medication_dose_conflict mc
       set conflict_doctor_alerted_at = now()
      from due
     where mc.medication_dose_conflict_id = due.medication_dose_conflict_id
       and mc.conflict_doctor_alerted_at is null
       and mc.conflict_resolution is null
    returning mc.medication_dose_conflict_id
  )
  insert into public.notification (user_id, notification_type, notification_message)
  select due.user_id,
         'medication',
         format(
           'A %s dose time for %s %s on %s at %s needs your review because of a clock change.',
           due.medication_schedule_name, due.pat_first_name, due.pat_last_name,
           to_char(due.conflict_dose_date, 'FMDD Month YYYY'),
           to_char(due.conflict_dose_time, 'HH24:MI')
         )
    from due
    join stamped on stamped.medication_dose_conflict_id = due.medication_dose_conflict_id;
  get diagnostics first_sent = row_count;

  -- The second alert only when the first went out before the last 24 hours:
  -- a conflict found inside them has just had its first.
  with due as (
    select mc.medication_dose_conflict_id,
           d.user_id,
           ms.medication_schedule_name,
           p.pat_first_name,
           p.pat_last_name,
           mc.conflict_dose_date,
           mc.conflict_dose_time
      from public.medication_dose_conflict mc
      join public.medication_schedule ms on ms.medication_schedule_id = mc.medication_schedule_id
      join public.prescription pr on pr.prescription_id = ms.prescription_id
      join public.patient p on p.pat_id = pr.pat_id
      join public.doctor d on d.doc_id = p.doc_id
     where mc.conflict_resolution is null
       and mc.conflict_doctor_final_alert_at is null
       and mc.conflict_doctor_alerted_at < mc.conflict_at - interval '24 hours'
       and now() >= mc.conflict_at - interval '24 hours'
       and now() < mc.conflict_at
       and d.doc_is_active
  ),
  stamped as (
    update public.medication_dose_conflict mc
       set conflict_doctor_final_alert_at = now()
      from due
     where mc.medication_dose_conflict_id = due.medication_dose_conflict_id
       and mc.conflict_doctor_final_alert_at is null
       and mc.conflict_resolution is null
    returning mc.medication_dose_conflict_id
  )
  insert into public.notification (user_id, notification_type, notification_message)
  select due.user_id,
         'medication',
         format(
           'Still awaiting your review: a %s dose time for %s %s on %s at %s (clock change).',
           due.medication_schedule_name, due.pat_first_name, due.pat_last_name,
           to_char(due.conflict_dose_date, 'FMDD Month YYYY'),
           to_char(due.conflict_dose_time, 'HH24:MI')
         )
    from due
    join stamped on stamped.medication_dose_conflict_id = due.medication_dose_conflict_id;
  get diagnostics final_sent = row_count;

  return first_sent + final_sent;
end;
$$;

comment on function public.dispatch_medication_conflict_alerts() is
  'Alerts each unresolved dose conflict''s treating doctor once when found '
  'and once 24 hours before it, while their account is active; nobody '
  'else. Idempotent: each alert is stamped in the statement that sends it.';

revoke all on function public.dispatch_medication_conflict_alerts() from public, anon, authenticated;
grant execute on function public.dispatch_medication_conflict_alerts() to service_role;

-- Guarded as migrations 09, 18 and 37 are: PGlite has no pg_cron.
do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; the medication conflict alert job was NOT '
      'scheduled. Call dispatch_medication_conflict_alerts() every 15 minutes '
      'from an external scheduler instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule(
    'recoverease-medication-conflict-alerts',
    '*/15 * * * *',
    $job$ select public.dispatch_medication_conflict_alerts() $job$
  );

  raise notice 'RecoverEase medication conflict alert job scheduled via pg_cron.';
end
$$;

reset lock_timeout;
