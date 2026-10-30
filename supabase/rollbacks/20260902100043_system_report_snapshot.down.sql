-- ===========================================================================
-- Rollback of migration 43 (system_report_snapshot)
-- ===========================================================================
-- Removes the kept figures and the function that keeps them: every report
-- row stays, with who generated it and when, but no report can be
-- downloaded again after this - the figures each kept are gone for good.
-- Applied as a new migration, with approval
-- (tests/db/report-snapshot.test.ts).
--
-- Roll the website back first: from migration 43 the Clinic Admin's
-- Generate report calls `admin_record_system_report()`, and the history's
-- Download reads `report_snapshot`; without them the first fails and the
-- second has nothing to read.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'report'
       and column_name = 'report_snapshot'
  ) then
    raise exception 'Migration 43 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the column locks `report`. Waiting at most 3 seconds for that
-- lock, the rollback fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction. It comes after the check, so a refusal changes no setting,
-- and it is reset at the end.
set lock_timeout = '3s';

drop function if exists public.admin_record_system_report();
drop trigger if exists report_protect_snapshot on public.report;
drop function if exists public.report_guard_snapshot();
alter table public.report drop constraint if exists report_snapshot_system_wide_only;
alter table public.report drop column report_snapshot;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
