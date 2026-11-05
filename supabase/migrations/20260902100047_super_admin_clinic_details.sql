-- ===========================================================================
-- RecoverEase — 47. Clinic details: a clinic's Clinic Admins, and editing
-- its name and time zone
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
--   * super_admin_update_clinic(clinic, name, time zone) - renames a clinic
--     and/or changes its time zone. Its id and status never change. The
--     name follows the same rules as super_admin_create_clinic: trimmed, not
--     blank, at most 120 characters, no other clinic with the same name in
--     any case. The time zone is trimmed and must be one PostgreSQL knows
--     (the clinic_validate_timezone trigger, migration 28).
--
--     In the same transaction the legacy `app.timezone` setting of that
--     clinic, where it still exists (migration 31 keeps it as an alias), is
--     brought to the same zone, exactly as admin_set_clinic_timezone does
--     for a Clinic Admin. Its own trigger then finds the clinic already in
--     that zone and changes nothing more.
--
--     Audited by the clinic row's own trigger (migration 28,
--     `audit_row_change('clinic', ..., 'values')`): the changed columns with
--     their before and after values, under the Super Admin's user id, and
--     classified `platform` by app_private.audit_scope_for. The alias, when
--     it changes, is audited by its own trigger as a `system_setting`
--     (administration) entry, so the clinic's own Clinic Admin sees that the
--     zone was changed. Nothing changed, nothing written, nothing audited.
--
-- What a time zone change does to medication doses and reminders:
--
--   * Nothing to any dose that is already scheduled. Each one is stored as
--     an exact moment (`medication_log.medication_log_scheduled_at`,
--     timestamptz), and this function never touches medication_log,
--     medication_schedule, prescriptions or appointments. Reminders for
--     those doses are sent at those same moments.
--   * Dose times generated from now on - a new or edited schedule, and the
--     nightly job that keeps 30 days ahead - read the schedule's times
--     (such as 08:00) as wall-clock times in the new zone. So do "today",
--     appointment-reminder days and every other date the clinic's zone is
--     used for (app_private.clinic_timezone, migration 31).
--   * It does not regenerate or move existing doses. That is deliberate:
--     no medication record is changed without someone choosing to.
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
-- Editing a clinic's name and time zone
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_update_clinic(
  target_clinic_id    uuid,
  new_clinic_name     text,
  new_clinic_timezone text
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
  wanted_zone   text := btrim(new_clinic_timezone);
  previous_name text;
  previous_zone text;
begin
  perform app_private.require_super_admin();

  -- Locked, so a second edit, or a Clinic Admin's own time zone change,
  -- waits for this one rather than overwrite it.
  select c.clinic_name, c.clinic_timezone into previous_name, previous_zone
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
  if wanted_zone is null or wanted_zone = '' then
    raise exception 'Enter the clinic''s time zone, such as Asia/Manila'
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

  if wanted_name is distinct from previous_name
     or wanted_zone is distinct from previous_zone then
    -- clinic_validate_timezone refuses a zone PostgreSQL does not know;
    -- clinic_audit records the change; clinic_set_updated_at stamps it.
    update public.clinic
       set clinic_name = wanted_name,
           clinic_timezone = wanted_zone
     where clinic.clinic_id = target_clinic_id;
  end if;

  -- The legacy alias, in this same transaction: kept in step - or brought
  -- back into it - whether or not the zone changed, as
  -- admin_set_clinic_timezone does. Its author is left as it was.
  update public.system_setting
     set system_setting_value = wanted_zone
   where system_setting.clinic_id = target_clinic_id
     and system_setting_key = 'app.timezone'
     and system_setting_value is distinct from wanted_zone;

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

comment on function public.super_admin_update_clinic(uuid, text, text) is
  'Renames a clinic and/or changes its time zone, validated, keeping its id '
  'and status and its legacy app.timezone setting in step. Existing doses are '
  'not moved. Super Admin only; audited through the clinic''s own trigger.';

revoke all on function public.super_admin_update_clinic(uuid, text, text) from public, anon;
grant execute on function public.super_admin_update_clinic(uuid, text, text) to authenticated;

reset lock_timeout;
