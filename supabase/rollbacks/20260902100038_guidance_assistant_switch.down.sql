-- ===========================================================================
-- Rollback of migration 38 (guidance_assistant_switch)
-- ===========================================================================
-- Removes both guidance assistant switches - the platform's table and its
-- functions, and the readers of the clinics' `chatbot.enabled` - and puts
-- back migration 33's audit classifier, returning the schema to exactly what
-- 37 left (tests/db/guidance-assistant-switch.test.ts). Applied as a new
-- migration, with approval. Roll this back before 37's.
--
-- Roll back `chatbot-reply` and the website first: from 38 on, the function
-- asks `guidance_assistant_on_for_doctor()` before every reply and refuses
-- when it cannot, and the website asks `guidance_assistant_available()`.
-- Once this has run the assistant answers in every clinic again.
--
-- Kept: each clinic's `chatbot.enabled` setting, which is data that nothing
-- reads once this has run - delete it separately if it should go too - and
-- every audit entry already written about the platform switch, which keeps
-- the scope it was given.
-- ===========================================================================

do $$
begin
  if to_regclass('app_private.platform_setting') is null then
    raise exception 'Migration 38 is not applied. Nothing was changed.';
  end if;
end
$$;

drop function public.super_admin_set_guidance_assistant(boolean);
drop function public.super_admin_get_guidance_assistant();
drop function public.guidance_assistant_on_for_doctor(uuid);
drop function public.guidance_assistant_available();
drop function app_private.guidance_assistant_on(uuid);

drop table app_private.platform_setting;

-- Migration 33's classifier, as it was.
create or replace function app_private.audit_scope_for(
  entity    text,
  entity_id uuid,
  details   jsonb
)
returns public.audit_scope
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when entity in ('clinic', 'super_admin', 'clinic_admin_account') then 'platform'::public.audit_scope
    -- A platform announcement: its author is a Super Admin. A deleted one
    -- carries its row; a new or edited one is still in the table.
    when entity = 'announcement'
         and coalesce(
               details #>> '{record,super_admin_id}',
               (select an.super_admin_id::text from public.announcement an
                 where an.announcement_id = entity_id)
             ) is not null then 'platform'
    when entity in ('doctor', 'doctor_account', 'doctor_patients', 'admin',
                    'announcement', 'system_setting', 'clinic_settings') then 'administration'
    when entity in ('user_account', 'account_password')
         and coalesce(
               details #>> '{record,user_role}',
               details #>> '{after,user_role}',
               details #>> '{before,user_role}',
               (select ua.user_role::text from public.user_account ua
                 where ua.user_id = entity_id)
             ) = 'super_admin' then 'platform'
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
$$;

comment on function app_private.audit_scope_for(text, uuid, jsonb) is
  'The scope of an audit entry, from its entity: clinics, Super Admins, '
  'Clinic Admin provisioning and platform announcements are platform; staff, '
  'clinic announcements and a clinic''s settings are administration; '
  'everything else, patients and patients'' accounts included, is clinical.';
