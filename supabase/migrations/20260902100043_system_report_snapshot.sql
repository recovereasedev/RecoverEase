-- ===========================================================================
-- RecoverEase — 43. A system-wide report keeps the figures it was generated with
-- ===========================================================================
-- Module 9.5 "View Recently Generated Reports", as the adviser asked for it:
-- the recently generated reports, "including the report name, generation
-- date, and download option". Until now a report row recorded only that a
-- report was generated, by whom and when; its figures were not kept, so an
-- earlier report could not be downloaded again - only a new one, with
-- today's figures, which is not the report that was generated.
--
-- A system-wide report's figures are a handful of clinic-wide counts
-- (`admin_dashboard_stats()`: patients, doctors, accounts by role, upcoming
-- appointments). This keeps them on the report row, so the report can be
-- downloaded again exactly as it was generated:
--
--   * `report.report_snapshot` (jsonb): the figures, as the database
--     computed them at that moment. Only a system-wide report has one - a
--     doctor's recovery report holds a patient's clinical record, and a copy
--     of that is not kept - and one generated before this migration has
--     none, which the page says rather than inventing them.
--   * `admin_record_system_report()`: the one way a snapshot is written. It
--     computes the figures with `admin_dashboard_stats()` - which refuses
--     anyone but a Clinic Admin and counts only their clinic - and records
--     the report and its figures in one statement, so the figures are the
--     database's, never what a browser sent.
--   * `report_protect_snapshot`: a signed-in user cannot write or change a
--     snapshot directly - not even a Clinic Admin, whose own insert policy
--     still allows a report row without one - so a kept report cannot be
--     altered after the fact.
--
-- Who may read a kept report is unchanged: `report_select` already limits a
-- system-wide report to its author and the Clinic Admins of its clinic. No
-- file is stored; the PDF and the Excel workbook are built again in the
-- browser from the kept figures. Nothing is removed: report rows are never
-- purged, and a snapshot is a few hundred bytes.
--
-- Rollback: supabase/rollbacks/20260902100043_system_report_snapshot.down.sql
-- ===========================================================================

-- The column and the trigger lock `report`. Waiting at most 3 seconds for
-- that lock, the migration fails rather than holding the website up behind
-- it (docs/deployment.md, "Migration timing and run history"). A plain SET,
-- not SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction; it is reset at the end.
set lock_timeout = '3s';

alter table public.report
  add column if not exists report_snapshot jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'report_snapshot_system_wide_only'
       and conrelid = 'public.report'::regclass
  ) then
    alter table public.report
      add constraint report_snapshot_system_wide_only
      check (report_snapshot is null or report_type = 'system_wide');
  end if;
end
$$;

comment on column public.report.report_snapshot is
  'Module 9.5: the figures a system-wide report was generated with, as '
  'admin_dashboard_stats() returned them, written only by '
  'admin_record_system_report() (migration 43). Null for a recovery report '
  'and for a report generated before migration 43.';

-- ---------------------------------------------------------------------------
-- Only the database writes a snapshot
-- ---------------------------------------------------------------------------
-- A statement run as a signed-in user or a visitor may neither set nor
-- change it. `admin_record_system_report()` runs as its owner, and the
-- service role is the server's own, so neither is refused.

create or replace function public.report_guard_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.report_snapshot is not null)
     or (tg_op = 'UPDATE' and new.report_snapshot is distinct from old.report_snapshot) then
    if current_user in ('authenticated', 'anon') then
      raise exception 'A report''s figures are recorded by the database, not sent with it'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- Not callable through the Data API; firing a trigger needs no EXECUTE
-- (migration 10).
revoke all on function public.report_guard_snapshot() from public, anon, authenticated;

drop trigger if exists report_protect_snapshot on public.report;
create trigger report_protect_snapshot
  before insert or update of report_snapshot on public.report
  for each row
  execute function public.report_guard_snapshot();

-- ---------------------------------------------------------------------------
-- Generate a system-wide report, keeping its figures
-- ---------------------------------------------------------------------------

create or replace function public.admin_record_system_report()
returns public.report
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Refuses anyone but a Clinic Admin, and counts only their clinic.
  figures  jsonb := public.admin_dashboard_stats();
  recorded public.report;
begin
  insert into public.report (user_id, report_type, report_snapshot)
  values ((select auth.uid()), 'system_wide', figures)
  returning * into recorded;
  return recorded;
end;
$$;

revoke all on function public.admin_record_system_report() from public, anon;
grant execute on function public.admin_record_system_report() to authenticated;

comment on function public.admin_record_system_report() is
  'Module 9.3 and 9.5: records a system-wide report for the calling Clinic '
  'Admin''s clinic with the figures admin_dashboard_stats() returns now, so '
  'it can be downloaded again as generated (migration 43).';

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
