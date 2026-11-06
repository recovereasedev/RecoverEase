-- ===========================================================================
-- RecoverEase — 47. Clinic details: a clinic's Clinic Admins, and renaming
-- a clinic
-- ===========================================================================
-- The Super Admin console's clinic details page (Phase 2). Two functions:
--
--   * super_admin_list_clinic_admins(clinic) - who administers one clinic:
--     each Clinic Admin's first and last name, when the account was made,
--     and whether (and when) it has ever signed in. No email, no sign-in id,
--     no profile id, nothing from Supabase Auth's sessions, factors or
--     tokens, and nothing about any patient.
--
--     "Has signed in" is the only account-setup fact the database records
--     reliably. A Clinic Admin sets their password through Supabase Auth's
--     own password-recovery email (create-account), and that is not
--     recorded anywhere RecoverEase can read; opening the email's link
--     already counts as a sign-in. So this returns `last_sign_in_at` as it
--     is and never claims that setup is "complete". There is no Clinic Admin
--     active/inactive flag either (only doctors have one), so none is
--     returned.
--
--   * super_admin_rename_clinic(clinic, name) - renames a clinic, and does
--     nothing else. Its id, status and time zone never change. The name
--     follows the same rules as super_admin_create_clinic: trimmed, not
--     blank, at most 120 characters, no other clinic with the same name in
--     any case.
--
--     Audited by the clinic row's own trigger (migration 28,
--     `audit_row_change('clinic', ..., 'values')`): the changed name with its
--     before and after values, under the Super Admin's user id, and
--     classified `platform` by app_private.audit_scope_for. The same name
--     again writes nothing and audits nothing.
--
-- Why there is no time zone edit here: a clinic's time zone is read-only in
-- the Super Admin console. When a clinic's zone moves to one with a
-- different UTC offset, the nightly extend_all_medication_log_slots job
-- adds the next 30 days' doses at the new local times next to the doses
-- already scheduled, because a dose slot is only skipped at an identical
-- moment. That duplicates doses and reminders. The Clinic Admin's own time
-- zone setting (admin_set_clinic_timezone, migration 31) has the same
-- limitation; fixing the scheduler is separate work with its own migration.
-- Until then this function takes no time zone and never writes
-- clinic_timezone, the legacy `app.timezone` setting, or any medication
-- schedule, dose, prescription or appointment.
--
-- Who may call them: an assured Super Admin only. SECURITY DEFINER - a Super
-- Admin has no profile in any clinic, so RLS would show them nothing - with
-- an empty search_path; the first statement of each is
-- `app_private.require_super_admin()` (migration 33). Refused to `anon` and
-- `public`; granted to `authenticated` and checked inside. No dynamic SQL.
--
-- Needs migration 33 and refuses to run without it. Independent of 34: it
-- creates no clinic and changes nothing about the single-clinic gate.
--
-- Rollback: supabase/rollbacks/20260902100047_super_admin_clinic_details.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.super_admin') is null
     or to_regprocedure('app_private.require_super_admin()') is null
     or to_regprocedure('public.super_admin_list_clinics()') is null then
    raise exception 'Migration 47 needs migration 33 first. Nothing was applied.';
  end if;
end
$$;

-- Creating a function locks no table, but every migration from 41 waits at
-- most 3 seconds for a lock rather than hold the website up behind one
-- (docs/deployment.md, "Migration timing and run history"). Reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- A clinic's Clinic Admins
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_list_clinic_admins(target_clinic_id uuid)
returns table (
  admin_first_name   text,
  admin_last_name    text,
  admin_created_at   timestamptz,
  has_signed_in      boolean,
  last_signed_in_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app_private.require_super_admin();

  if target_clinic_id is null
     or not exists (select 1 from public.clinic c where c.clinic_id = target_clinic_id) then
    raise exception 'That clinic could not be found'
      using errcode = 'no_data_found';
  end if;

  -- Only this clinic's profiles, and only accounts whose role is Clinic
  -- Admin - the same rule super_admin_list_clinics counts by.
  return query
    select a.admin_first_name, a.admin_last_name, a.admin_created_at,
           u.last_sign_in_at is not null,
           u.last_sign_in_at
      from public.admin a
      join public.user_account ua on ua.user_id = a.user_id
      left join auth.users u on u.id = a.user_id
     where a.clinic_id = target_clinic_id
       and ua.user_role = 'admin'
     order by lower(a.admin_last_name), lower(a.admin_first_name), a.admin_created_at, a.admin_id;
end;
$$;

comment on function public.super_admin_list_clinic_admins(uuid) is
  'One clinic''s Clinic Admins: names, when the account was made and whether '
  'it has ever signed in. No email, id or Auth secret; nothing clinical. '
  'Super Admin only.';

revoke all on function public.super_admin_list_clinic_admins(uuid) from public, anon;
grant execute on function public.super_admin_list_clinic_admins(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Renaming a clinic
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_rename_clinic(
  target_clinic_id uuid,
  new_clinic_name  text
)
returns table (
  clinic_id          uuid,
  clinic_name        text,
  clinic_status      public.clinic_status,
  clinic_timezone    text,
  clinic_created_at  timestamptz,
  clinic_updated_at  timestamptz,
  clinic_admin_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  wanted_name   text := btrim(new_clinic_name);
  previous_name text;
begin
  perform app_private.require_super_admin();

  -- Locked, so a second rename waits for this one rather than overwrite it.
  select c.clinic_name into previous_name
    from public.clinic c
   where c.clinic_id = target_clinic_id
   for update;

  if not found then
    raise exception 'That clinic could not be found'
      using errcode = 'no_data_found';
  end if;

  if wanted_name is null or wanted_name = '' then
    raise exception 'Enter the clinic''s name'
      using errcode = 'check_violation';
  end if;
  if char_length(wanted_name) > 120 then
    raise exception 'A clinic''s name can be at most 120 characters'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.clinic c
     where lower(btrim(c.clinic_name)) = lower(wanted_name)
       and c.clinic_id <> target_clinic_id
  ) then
    raise exception 'A clinic with that name already exists'
      using errcode = 'unique_violation';
  end if;

  -- The name, and only the name. clinic_audit records it;
  -- clinic_set_updated_at stamps it.
  if wanted_name is distinct from previous_name then
    update public.clinic
       set clinic_name = wanted_name
     where clinic.clinic_id = target_clinic_id;
  end if;

  return query
    select c.clinic_id, c.clinic_name, c.clinic_status, c.clinic_timezone,
           c.clinic_created_at, c.clinic_updated_at,
           (select count(*)::integer
              from public.admin a
              join public.user_account ua on ua.user_id = a.user_id
             where a.clinic_id = c.clinic_id
               and ua.user_role = 'admin')
      from public.clinic c
     where c.clinic_id = target_clinic_id;
end;
$$;

comment on function public.super_admin_rename_clinic(uuid, text) is
  'Renames a clinic, validated, keeping its id, status and time zone. Never '
  'changes a time zone or any medication record. Super Admin only; audited '
  'through the clinic''s own trigger.';

revoke all on function public.super_admin_rename_clinic(uuid, text) from public, anon;
grant execute on function public.super_admin_rename_clinic(uuid, text) to authenticated;

reset lock_timeout;
