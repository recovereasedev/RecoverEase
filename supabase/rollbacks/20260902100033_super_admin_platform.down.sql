-- ===========================================================================
-- Rollback of migration 33 (super_admin_platform)
-- ===========================================================================
-- Returns the schema to exactly what migration 32 left, catalog entry by
-- catalog entry (tests/db/super-admin-rollback.test.ts). Applied as a new
-- migration, with approval, and only once migrations 38 and 34 have been
-- rolled back.
--
-- It refuses, changing nothing, while any of these exists - each would be
-- left without the rules that make it safe:
--   * a Super Admin: remove each with app_private.revoke_super_admin first
--     (and delete their platform announcements before that);
--   * a platform announcement: it has no clinic to go back to.
--
-- What stays: every Clinic Admin a Super Admin provisioned (an ordinary
-- Clinic Admin account and profile), every clinic and its status, and every
-- audit entry with the scope it was written with. Migration 32's
-- `super_admin` enum value stays too, unused: PostgreSQL cannot remove an
-- enum value without recreating the type.
-- ===========================================================================

do $$
begin
  if to_regclass('public.super_admin') is null then
    raise exception 'Migration 33 is not applied. Nothing was changed.';
  end if;

  -- Migration 38's switch is changed only through the Super Admin's checks
  -- removed below; left installed, its functions would be broken, not gone.
  if to_regclass('app_private.platform_setting') is not null then
    raise exception 'Roll back migration 38 first: its guidance assistant switch relies on the Super Admin checks this removes. Nothing was changed.';
  end if;

  if to_regclass('public.clinic_single_clinic_gate') is null then
    raise exception 'Roll back migration 34 first: the single-clinic gate must be back before the Super Admin goes. Nothing was changed.';
  end if;

  if exists (select 1 from public.user_account where user_role::text = 'super_admin') then
    raise exception 'A Super Admin exists. Remove each with app_private.revoke_super_admin first. Nothing was changed.';
  end if;

  if exists (select 1 from public.announcement where super_admin_id is not null) then
    raise exception 'Platform announcements exist, and they have no clinic to go back to. Nothing was changed.';
  end if;
end
$$;

-- The Super Admin's functions.
drop function public.super_admin_list_audit(integer, timestamptz, uuid);
drop function public.super_admin_delete_announcement(uuid);
drop function public.super_admin_set_announcement_published(uuid, boolean);
drop function public.super_admin_update_announcement(uuid, text, text);
drop function public.super_admin_create_announcement(text, text, boolean);
drop function public.super_admin_list_announcements();
drop function app_private.platform_announcement_for_update(uuid);
drop function app_private.validate_announcement_text(text, text);
drop function public.super_admin_attach_clinic_admin(uuid, uuid, text, text);
drop function public.super_admin_check_clinic_for_admin(uuid);
drop function app_private.require_active_clinic(uuid);
drop function public.super_admin_set_clinic_status(uuid, text);
drop function public.super_admin_create_clinic(text, text);
drop function public.super_admin_list_clinics();
drop function app_private.revoke_super_admin(uuid);
drop function app_private.provision_super_admin(uuid, text, text);
drop function public.super_admin_assured();
drop function app_private.require_super_admin();
drop function app_private.assured_super_admin();

-- The audit classifier and clinic resolver, as migration 31 left them.
CREATE OR REPLACE FUNCTION app_private.audit_scope_for(entity text, entity_id uuid, details jsonb)
 RETURNS audit_scope
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when entity = 'clinic' then 'platform'::public.audit_scope
    when entity in ('doctor', 'doctor_account', 'doctor_patients', 'admin',
                    'announcement', 'system_setting', 'clinic_settings') then 'administration'
    when entity in ('user_account', 'account_password')
         and coalesce(
               details #>> '{record,user_role}',
               details #>> '{after,user_role}',
               details #>> '{before,user_role}',
               (select ua.user_role::text from public.user_account ua
                 where ua.user_id = entity_id)
             ) in ('admin', 'doctor') then 'administration'
    else 'clinical'
  end;
$function$;

comment on function app_private.audit_scope_for(text, uuid, jsonb) is
  'The scope of an audit entry, from its entity: clinic is platform; staff, announcements and a clinic''s settings are administration; everything else, patients and patients'' accounts included, is clinical.';

CREATE OR REPLACE FUNCTION app_private.audit_clinic_for(entity text, entity_id uuid, actor uuid, details jsonb)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    case entity
      when 'clinic' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_settings' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
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
      when 'user_account' then app_private.clinic_of_user(entity_id)
      when 'account_password' then app_private.clinic_of_user(entity_id)
    end,
    app_private.clinic_of_user(actor)
  );
$function$;

comment on function app_private.audit_clinic_for(text, uuid, uuid, jsonb) is
  'The clinic an audit entry is about, from its entity and id, the recorded row for a deleted one, or else the actor''s clinic. NULL when none is known yet.';

-- Announcements: one author, a Clinic Admin, as migrations 30 and 31 left them.
drop trigger announcement_author_is_fixed on public.announcement;

CREATE OR REPLACE FUNCTION public.announcement_guard_author()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.admin_id is distinct from old.admin_id
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'An announcement keeps the author and clinic it was written with'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

comment on function public.announcement_guard_author() is
  'Refuses any change to an announcement''s author or clinic. Run only by the announcement_author_is_fixed trigger.';

create trigger announcement_author_is_fixed
  before update of admin_id, clinic_id on public.announcement
  for each row execute function public.announcement_guard_author();

CREATE OR REPLACE FUNCTION public.announcement_assign_clinic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.clinic_id := (select a.clinic_id from public.admin a
                     where a.admin_id = new.admin_id);
  return new;
end;
$function$;

comment on function public.announcement_assign_clinic() is
  'Gives a new announcement its author''s clinic. Run only by the announcement_assign_clinic trigger.';

drop index public.announcement_super_admin_id_idx;
alter table public.announcement drop constraint announcement_clinic_follows_author;
alter table public.announcement drop constraint announcement_one_author;
alter table public.announcement drop column super_admin_id;
alter table public.announcement alter column admin_id set not null;

alter table public.clinic drop constraint clinic_name_length;

-- The account guard and profile check, as migration 28 left them.
CREATE OR REPLACE FUNCTION public.user_account_guard_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- The Data API's end-user roles. create-account writes as service_role.
  if current_user in ('anon', 'authenticated') then
    raise exception 'Accounts are created and changed only by the server'
      using errcode = 'insufficient_privilege';
  end if;

  -- Re-pointing an account at a different login would hand its role, and
  -- every record that hangs off it, to someone else.
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'The login linked to an account cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE'
     and new.user_role is distinct from old.user_role
     and app_private.account_has_profile(old.user_id) then
    raise exception 'The role of an account with a profile cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce(new, old);
end;
$function$;

comment on function public.user_account_guard_writes() is
  'Refuses every insert, update and delete of user_account by the anon or authenticated role, whatever the policies say; refuses a change of user_id by anyone; and refuses a change of user_role, by anyone, once the account has a doctor, patient or admin profile. create-account writes as service_role and is unaffected. Run only by the user_account_guard_writes trigger.';

CREATE OR REPLACE FUNCTION app_private.account_has_profile(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.doctor d where d.user_id = target_user_id)
      or exists (select 1 from public.patient p where p.user_id = target_user_id)
      or exists (select 1 from public.admin a where a.user_id = target_user_id);
$function$;

comment on function app_private.account_has_profile(uuid) is
  'Whether a doctor, patient or admin profile belongs to the account. Used by the user_account guard; callable only by server roles.';

-- The profile table, with its triggers and policy.
drop table public.super_admin;
drop function public.super_admin_guard_writes();
