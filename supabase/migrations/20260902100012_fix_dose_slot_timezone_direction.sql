-- ===========================================================================
-- RecoverEase — 13. Correct the direction of the dose-slot timezone conversion
-- ===========================================================================
-- Found by live verification against the deployed database, and NOT caught by
-- the PGlite suite — see the note at the end.
--
-- Symptom: a schedule of 08:00 and 20:00 with `app.timezone = Asia/Manila`
-- materialised doses at 00:00 and 12:00 Manila. Every dose was eight hours
-- out, which in a medication system means every reminder fires at the wrong
-- time and every adherence record is attributed to the wrong slot.
--
-- Cause: `generate_series(window_from, window_to, interval '1 day')` with
-- `date` bounds resolves to the **timestamptz** overload, because timestamptz
-- is the preferred type in the datetime category. So `day` was already
-- zone-aware, `day + dose_time` stayed timestamptz, and `AT TIME ZONE zone`
-- then converted OUT of the zone (timestamptz -> local timestamp) rather than
-- INTO it. Re-inserting that result into a timestamptz column reinterpreted
-- it in the server zone, applying the offset backwards.
--
-- Fix: cast the series value to `date`, so `date + time` yields a plain
-- `timestamp`, for which `AT TIME ZONE zone` means "this wall clock, in that
-- zone" — the intended direction. Everything else is unchanged.
--
-- Why the local suite missed it: `AT TIME ZONE` is only wrong when the two
-- conversions do not cancel, which requires the series to resolve to
-- timestamptz. PGlite resolved it differently, so the assertion passed there
-- and failed on real PostgreSQL. The lesson is not that the test was weak but
-- that overload resolution is an engine behaviour a compatibility layer can
-- differ on — which is exactly why live verification is a separate phase.
-- The test has since been strengthened to assert the full set of dose times
-- rather than only the earliest.
-- ===========================================================================

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

  -- Never backfill doses the patient had no opportunity to record.
  window_from := greatest(schedule.medication_schedule_start_date,
                          current_date);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    current_date + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  with slots as (
    -- `day::date` is load-bearing. Without it `day` is a timestamptz and the
    -- conversion below runs backwards. Do not remove it.
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

-- CREATE OR REPLACE resets grants to the default (EXECUTE to PUBLIC), so the
-- revoke has to be repeated here. This is the trap that migration 11 exists
-- to close, and replacing a function quietly reopens it.
revoke all on function public.generate_medication_log_slots(uuid, integer)
  from public, anon, authenticated;
