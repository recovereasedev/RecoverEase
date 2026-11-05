-- ===========================================================================
-- RecoverEase — 46. The platform overview: how many, never who
-- ===========================================================================
-- The Super Admin console's first page. Until now the console opened on the
-- clinic list, and the only figure it could show was each clinic's number of
-- Clinic Admins (`super_admin_list_clinics`, migration 33). This adds one
-- function that counts the rest:
--
--   * clinics: all, active, inactive;
--   * Clinic Admins, doctors (all, active) and patients (all, active),
--     platform-wide;
--   * platform announcements: published, drafts;
--   * for each clinic: its id, name and status, and its number of Clinic
--     Admins, active doctors and active patients.
--
-- Counts only. No person's name, email, id or account is returned, nor any
-- clinical record: the function never returns a row of `patient`, `doctor`,
-- `admin` or anything clinical, only `count(*)` over them. A clinic's id and
-- name are already the Super Admin's (`super_admin_list_clinics`). Patients
-- are counted through their doctor's clinic, as `admin_dashboard_stats()`
-- (migration 30) counts a Clinic Admin's own, so a clinic's figures here are
-- the ones its own Clinic Admin already sees.
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
declare
  result jsonb;
begin
  perform app_private.require_super_admin();

  with clinic_counts as (
    select c.clinic_id,
           c.clinic_name,
           c.clinic_status,
           (select count(*)
              from public.admin a
              join public.user_account ua on ua.user_id = a.user_id
             where a.clinic_id = c.clinic_id
               and ua.user_role = 'admin') as clinic_admins,
           (select count(*)
              from public.doctor d
             where d.clinic_id = c.clinic_id
               and d.doc_is_active) as active_doctors,
           (select count(*)
              from public.patient p
              join public.doctor d on d.doc_id = p.doc_id
             where d.clinic_id = c.clinic_id
               and p.pat_status = 'active') as active_patients
      from public.clinic c
  )
  select jsonb_build_object(
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
    'by_clinic', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'clinic_id',       cc.clinic_id,
                 'clinic_name',     cc.clinic_name,
                 'clinic_status',   cc.clinic_status,
                 'clinic_admins',   cc.clinic_admins,
                 'active_doctors',  cc.active_doctors,
                 'active_patients', cc.active_patients
               )
               order by lower(cc.clinic_name), cc.clinic_id
             )
        from clinic_counts cc
    ), '[]'::jsonb),
    'generated_at', now()
  ) into result;

  return result;
end;
$$;

comment on function public.super_admin_platform_overview() is
  'The Super Admin console''s overview: counts of clinics, Clinic Admins, '
  'doctors, patients and platform announcements, platform-wide and per '
  'clinic. Counts only - no person and no clinical record. Super Admin only '
  '(migration 46).';

revoke all on function public.super_admin_platform_overview() from public, anon;
grant execute on function public.super_admin_platform_overview() to authenticated;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
