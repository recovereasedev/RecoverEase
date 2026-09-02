-- ===========================================================================
-- RecoverEase — 14. Resolve every calendar date in the application timezone
-- ===========================================================================
-- Found by production smoke testing, and missed by both the PGlite suite and
-- the browser suite. See the note at the end for why.
--
-- Symptom: signed in as a patient in Manila at 00:30 local, saving the daily
-- recovery entry failed with HTTP 400 / SQLSTATE 23514, "A recovery log
-- cannot be dated in the future".
--
-- Cause: the database runs in UTC, so `current_date` is the UTC date. The
-- browser sends the patient's *local* date, deliberately — `toDateKey()`
-- formats from local parts precisely so a patient logging at 07:00 in UTC+8
-- files the entry against the day they are actually living. Between 00:00 and
-- 08:00 Manila the two disagree by one day, the guard read the patient's own
-- today as tomorrow, and rejected it.
--
-- That is not a narrow edge case: it broke the single most important daily
-- action in the product, for the first eight hours of every day — including
-- the morning, which is when a recovery app is most used.
--
-- The same mistake is present anywhere a `date` is derived from the server
-- clock, so this migration fixes the whole class rather than the one symptom:
--
--   * the recovery-log future-date guard      (blocked the write outright)
--   * the patient birth-date guard            (rejected a birth date of today)
--   * four `default current_date` columns     (dated rows to the previous day)
--   * the dose-slot generation window         (skipped the current local day)
--   * the live-schedule filter                (expired a schedule 8h early)
--
-- `dispatch_medication_reminders` is untouched: it already resolves the
-- clinic-local time from `app.timezone`, which is the pattern generalised
-- here.
--
-- Timestamps are not affected. `timestamptz` is an absolute instant and
-- `now()` is correct regardless of the server zone; only `date`, which has no
-- zone of its own, has to be told which clock it belongs to.
-- ===========================================================================

-- The one source of truth for "what day is it in the clinic's terms".
--
-- SECURITY DEFINER is required rather than convenient: `system_setting` is
-- readable only by administrators (system_setting_select_admin), so under
-- invoker rights a patient would match no row, silently fall back to 'UTC',
-- and reintroduce exactly the bug this migration removes.
--
-- The exposure this creates is bounded: no arguments, no table data in the
-- result, and the only thing it discloses is the server's current date, which
-- every HTTP `Date` response header already carries. EXECUTE is withheld from
-- PUBLIC and `anon` regardless, so it is not reachable unauthenticated.
create or replace function public.app_today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (
    now() at time zone coalesce(
      (select system_setting_value
         from public.system_setting
        where system_setting_key = 'app.timezone'),
      'UTC'
    )
  )::date;
$$;

comment on function public.app_today() is
  'Current date in the clinic timezone (system_setting app.timezone). Use '
  'this instead of current_date for any user-facing calendar date: the '
  'database runs in UTC and the client sends local dates.';

revoke all on function public.app_today() from public, anon;
-- `authenticated` needs EXECUTE because column DEFAULT expressions below are
-- evaluated with the privileges of the inserting role, not the table owner.
grant execute on function public.app_today() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create or replace function public.recovery_log_validate_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recovery_log_date > public.app_today() then
    raise exception 'A recovery log cannot be dated in the future'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.patient_validate_birth_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pat_birth_date is null then
    return new;
  end if;

  if new.pat_birth_date > public.app_today() then
    raise exception 'Date of birth cannot be in the future'
      using errcode = 'check_violation';
  end if;

  if new.pat_birth_date <= public.app_today() - interval '130 years' then
    raise exception 'Date of birth is implausibly early'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Defaults
-- ---------------------------------------------------------------------------
-- A doctor writing a plan at 00:30 local otherwise gets yesterday's date on
-- it, and a prescription issued overnight is dated before the consultation
-- that produced it.

alter table public.treatment_plan
  alter column treatment_plan_start_date set default public.app_today();

alter table public.prescription
  alter column prescription_issued_date set default public.app_today();

alter table public.medication_schedule
  alter column medication_schedule_start_date set default public.app_today();

alter table public.recovery_log
  alter column recovery_log_date set default public.app_today();

-- ---------------------------------------------------------------------------
-- Dose slot generation
-- ---------------------------------------------------------------------------
-- Replaced in full rather than patched, so the `day::date` fix from migration
-- 13 stays visible next to the change that depends on it.

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
  inserted    integer;
begin
  select * into schedule
    from public.medication_schedule
   where medication_schedule_id = target_schedule_id;

  if not found then
    return 0;
  end if;

  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  today := public.app_today();

  -- Never backfill doses the patient had no opportunity to record. "Today"
  -- has to be the clinic's today: on the UTC date the patient's current
  -- morning doses would fall before the window and never be created.
  window_from := greatest(schedule.medication_schedule_start_date, today);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    today + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  with slots as (
    -- `day::date` is load-bearing. Without it `day` is a timestamptz and the
    -- conversion below runs backwards. Do not remove it. (Migration 13.)
    select ((day::date + dose_time) at time zone zone) as scheduled_at
      from generate_series(window_from, window_to, interval '1 day') as day
      cross join unnest(schedule.medication_schedule_times) as dose_time
  )
  insert into public.medication_log (
    medication_schedule_id, medication_log_scheduled_at
  )
  select target_schedule_id, scheduled_at
    from slots
  on conflict (medication_schedule_id, medication_log_scheduled_at)
    do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function public.extend_all_medication_log_slots(
  horizon_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule_id uuid;
  total       integer := 0;
begin
  for schedule_id in
    select ms.medication_schedule_id
      from public.medication_schedule ms
     where ms.medication_schedule_end_date is null
       -- A course ending today is still live for the whole of today, in the
       -- patient's day rather than the server's.
        or ms.medication_schedule_end_date >= public.app_today()
  loop
    total := total
      + public.generate_medication_log_slots(schedule_id, horizon_days);
  end loop;

  return total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-close what CREATE OR REPLACE reopened
-- ---------------------------------------------------------------------------
-- Replacing a function resets its grants to the default of EXECUTE to PUBLIC,
-- which would republish these as /rest/v1/rpc endpoints. Migration 11 exists
-- to close that hole and migration 13 had to repeat the revoke for the same
-- reason; every migration that replaces a function has to repeat it too.

revoke all on function public.recovery_log_validate_date() from public, anon, authenticated;
revoke all on function public.patient_validate_birth_date() from public, anon, authenticated;
revoke all on function public.generate_medication_log_slots(uuid, integer) from public, anon, authenticated;
revoke all on function public.extend_all_medication_log_slots(integer) from public, anon, authenticated;

-- ===========================================================================
-- Why neither existing suite caught this
--
-- The PGlite suite runs the database and the assertions in one process on one
-- clock, and the fixtures build dates with `current_date`. Server and client
-- therefore always agreed, which is precisely the condition under which this
-- bug does not exist. It could only appear where the two clocks are different
-- machines in different zones.
--
-- The browser suite ran against a stubbed PostgREST, which has no triggers to
-- violate, so the write it exercised could not fail this way.
--
-- Both suites gain a case in this commit: the schema tests assert the guards
-- accept the application-timezone today while the server is in UTC, and the
-- reminder tests pin the dose window to the same clock.
-- ===========================================================================
