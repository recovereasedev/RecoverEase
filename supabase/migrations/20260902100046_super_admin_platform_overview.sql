-- ===========================================================================
-- RecoverEase — 46. The platform overview: platform totals, never who
-- ===========================================================================
-- The Super Admin console's first page. Until now the console opened on the
-- clinic list, and the only figure it could show was each clinic's number of
-- Clinic Admins (`super_admin_list_clinics`, migration 33). This adds one
-- function that counts the platform as a whole:
--
--   * clinics: all, active, inactive;
--   * Clinic Admins;
--   * doctors: all, active;
--   * patients: all, active;
--   * platform announcements: published, drafts;
--   * when it counted.
--
-- Platform totals only. Nothing is broken down by clinic: no clinic's id,
-- name or status, and no clinic's own figures. No person's name, email, id
-- or account is returned, nor any clinical record: the function never
-- returns a row of `clinic`, `patient`, `doctor`, `admin` or anything
-- clinical, only `count(*)` over them. Active patients are those whose
-- `pat_status` is `active`, and active doctors those with `doc_is_active`,
-- as `admin_dashboard_stats()` (migration 30) counts a Clinic Admin's own.
--
-- Who may call it: an assured Super Admin only. Like every Super Admin
-- function it is SECURITY DEFINER - a Super Admin has no profile in any
-- clinic, so RLS would show them none of the rows it counts - with an empty
-- search_path, and its first statement is `app_private.require_super_admin()`
-- (migration 33): a live session raised to aal2 with the caller's own
-- verified authenticator, read from Supabase Auth's tables, never the token
-- alone. Refused to `anon`; granted to `authenticated` and checked inside.
-- It writes nothing, so it is `stable` and records no audit entry, as the
-- other Super Admin list functions do not.
--
-- Needs migration 33 and refuses to run without it. Independent of 34: with
-- one clinic or many it counts what is there.
--
-- Rollback: supabase/rollbacks/20260902100046_super_admin_platform_overview.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.super_admin') is null
     or to_regprocedure('app_private.require_super_admin()') is null then
    raise exception 'Migration 46 needs migration 33 first. Nothing was applied.';
  end if;
end
$$;

-- Creating a function locks no table, but every migration from 41 waits at
-- most 3 seconds for a lock rather than hold the website up behind one
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction; it is reset at the end.
set lock_timeout = '3s';

create or replace function public.super_admin_platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_super_admin();

  return jsonb_build_object(
    'clinics', jsonb_build_object(
      'total',    (select count(*) from public.clinic),
      'active',   (select count(*) from public.clinic where clinic_status = 'active'),
      'inactive', (select count(*) from public.clinic where clinic_status = 'inactive')
    ),
    'clinic_admins', (
      select count(*)
        from public.admin a
        join public.user_account ua on ua.user_id = a.user_id
       where ua.user_role = 'admin'
    ),
    'doctors', jsonb_build_object(
      'total',  (select count(*) from public.doctor),
      'active', (select count(*) from public.doctor where doc_is_active)
    ),
    'patients', jsonb_build_object(
      'total',  (select count(*) from public.patient),
      'active', (select count(*) from public.patient where pat_status = 'active')
    ),
    'announcements', jsonb_build_object(
      'published', (select count(*) from public.announcement
                     where super_admin_id is not null
                       and announcement_published_at is not null),
      'drafts',    (select count(*) from public.announcement
                     where super_admin_id is not null
                       and announcement_published_at is null)
    ),
    'generated_at', now()
  );
end;
$$;

comment on function public.super_admin_platform_overview() is
  'The Super Admin console''s overview: platform-wide counts of clinics, '
  'Clinic Admins, doctors, patients and platform announcements. Totals only - '
  'no clinic broken out, no person and no clinical record. Super Admin only '
  '(migration 46).';

revoke all on function public.super_admin_platform_overview() from public, anon;
grant execute on function public.super_admin_platform_overview() to authenticated;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
