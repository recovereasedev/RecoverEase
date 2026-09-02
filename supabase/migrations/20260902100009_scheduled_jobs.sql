-- ===========================================================================
-- RecoverEase — 10. Scheduled jobs
-- ===========================================================================
-- Wires the medication functions to a scheduler. Without this the functions
-- exist but nothing calls them, which is the state modules 4.2 and 4.7 were
-- left in before.
--
-- The whole block is guarded on pg_cron being available, for two reasons:
--
--   * the test harness runs these migrations against PGlite, which has no
--     pg_cron — an unguarded CREATE EXTENSION would fail the entire suite;
--   * a self-hosted deployment may not have it either, and the correct
--     behaviour there is to skip and log, not to abort the migration.
--
-- Where pg_cron is unavailable, run the same three statements from any
-- external scheduler using the service role. They are the whole contract.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; medication reminder jobs were NOT scheduled. '
      'Call dispatch_medication_reminders(), extend_all_medication_log_slots() '
      'and mark_overdue_medication_logs() from an external scheduler instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  -- cron.schedule(name, schedule, command) replaces a job of the same name,
  -- so re-running this migration does not accumulate duplicate jobs.

  -- Extend dose slots for every live schedule. Idempotent: the unique index
  -- on (schedule, scheduled_at) makes re-generation a no-op.
  perform cron.schedule(
    'recoverease-extend-medication-slots',
    '0 1 * * *',
    $job$ select public.extend_all_medication_log_slots(30) $job$
  );

  -- Chase unrecorded doses. Runs every 15 minutes so a follow-up lands close
  -- to the patient's preferred time rather than up to an hour after it;
  -- medication_log_follow_up_sent_at keeps each dose to a single reminder no
  -- matter how often this fires.
  perform cron.schedule(
    'recoverease-medication-reminders',
    '*/15 * * * *',
    $job$ select public.dispatch_medication_reminders(30) $job$
  );

  -- Doses that came and went unrecorded become 'missed' rather than staying
  -- 'pending' forever, which is what keeps adherence meaningful. Runs after
  -- the reminder cadence so a dose is always chased before it is written off.
  perform cron.schedule(
    'recoverease-mark-overdue-doses',
    '5 * * * *',
    $job$ select public.mark_overdue_medication_logs(6) $job$
  );

  raise notice 'RecoverEase medication jobs scheduled via pg_cron.';
end
$$;
