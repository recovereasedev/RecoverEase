-- ===========================================================================
-- RecoverEase — 38. The guidance assistant can be turned off
-- ===========================================================================
-- The adviser's "AI Chatbot On/Off": two switches, both enforced by the
-- server, and the assistant answers only when both are on.
--
--   * The platform's, for every clinic at once - maintenance, an incident, a
--     provider outage. `app_private.platform_setting` - a schema the Data
--     API does not expose, so nobody reaches the table except through the
--     functions below - key
--     'guidance_assistant.enabled'. Only a Super Admin changes it, through
--     `super_admin_set_guidance_assistant(boolean)`, behind the same check
--     every Super Admin operation makes (migration 33), and each change is a
--     platform audit entry.
--   * Each clinic's, set by its Clinic Admin: the `system_setting` key
--     'chatbot.enabled', written like every other clinic setting (migration
--     31's policies: an administrator writes only their own clinic's), and
--     audited as every setting is.
--
-- A switch never set is on, so nothing changes until someone turns one off.
-- A value other than 'true' is off: a switch that exists to stop the
-- assistant fails closed, never open.
--
-- `chatbot-reply` asks `guidance_assistant_on_for_doctor()` - the service
-- role's alone - once the conversation is proved the caller's and before it
-- reads any of it or calls the provider, so a switched-off assistant is
-- refused before a Gemini request. `guidance_assistant_available()` tells a
-- signed-in user whether it is on for them, so the patient's screen can say
-- so instead of offering a composer that would be refused. Chat history is
-- untouched either way.
--
-- Plan-based gating - which plans include the assistant - is not part of
-- this; it waits for the subscription model to be decided.
--
-- Independent of migration 34 (tests/db/guidance-assistant-switch.test.ts
-- applies it after 37 without 34, as production has them).
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100038_guidance_assistant_switch.down.sql,
-- applied as a new migration with approval.
-- ===========================================================================

-- Migration 33's Super Admin and migration 31's clinic settings must be
-- there, and this not yet.
do $$
begin
  if to_regprocedure('app_private.require_super_admin()') is null then
    raise exception 'Migration 38 needs migration 33 first. Nothing was applied.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 38 needs migration 31 first. Nothing was applied.';
  end if;

  if to_regclass('app_private.platform_setting') is not null then
    raise exception 'Migration 38 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The platform's switch
-- ---------------------------------------------------------------------------

create table app_private.platform_setting (
  platform_setting_id         uuid primary key default gen_random_uuid(),
  platform_setting_key        text not null unique
    -- Declared keys only: nothing reads a key this does not name.
    check (platform_setting_key in ('guidance_assistant.enabled')),
  platform_setting_value      text not null
    check (platform_setting_value in ('true', 'false')),
  platform_setting_updated_by uuid references public.user_account (user_id) on delete set null,
  platform_setting_updated_at timestamptz not null default now()
);

comment on table app_private.platform_setting is
  'Settings for the whole platform, written only by a Super Admin through '
  'its own functions. Holds no patient or clinic data.';

-- Outside the API's schemas, with no grant to its roles and row level
-- security on with no policy: nobody reads or writes the table directly. The
-- functions below are the way in.
alter table app_private.platform_setting enable row level security;
revoke all on table app_private.platform_setting from public, anon, authenticated;

-- An account removed is unlinked from the switch it last changed.
create index platform_setting_updated_by_idx
  on app_private.platform_setting (platform_setting_updated_by);

create trigger platform_setting_set_updated_at
  before update on app_private.platform_setting
  for each row execute function public.set_updated_at('platform_setting_updated_at');

-- Values in full, as a clinic's are: the row holds no personal data.
create trigger platform_setting_audit
  after insert or update or delete on app_private.platform_setting
  for each row execute function
    public.audit_row_change('platform_setting', 'platform_setting_id', 'values');

-- Migration 33's classifier, with the platform's own settings added as
-- platform entries. Without this they would be classified clinical - the
-- classifier's default for anything it does not recognise - and hidden from
-- the Super Admin's audit trail.
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
    when entity in ('clinic', 'super_admin', 'clinic_admin_account', 'platform_setting') then 'platform'::public.audit_scope
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
  'Clinic Admin provisioning, platform settings and platform announcements '
  'are platform; staff, clinic announcements and a clinic''s settings are '
  'administration; everything else, patients and patients'' accounts '
  'included, is clinical.';

-- ---------------------------------------------------------------------------
-- Whether the assistant is on
-- ---------------------------------------------------------------------------

-- The one rule, used by every reader: the platform's switch and the clinic's
-- switch both on, a switch never set counting as on and any value but
-- 'true' as off. A NULL clinic - a Super Admin, or a caller with none - is
-- answered by the platform's switch alone.
create or replace function app_private.guidance_assistant_on(target_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
           (select ps.platform_setting_value = 'true'
              from app_private.platform_setting ps
             where ps.platform_setting_key = 'guidance_assistant.enabled'),
           true)
     and coalesce(
           (select lower(btrim(s.system_setting_value)) = 'true'
              from public.system_setting s
             where s.clinic_id = target_clinic_id
               and s.system_setting_key = 'chatbot.enabled'),
           true);
$$;

comment on function app_private.guidance_assistant_on(uuid) is
  'Whether the guidance assistant is on for a clinic: the platform switch and '
  'the clinic''s chatbot.enabled setting both on. Unset is on; any value but '
  '''true'' is off.';

revoke all on function app_private.guidance_assistant_on(uuid) from public, anon, authenticated;

-- For the signed-in user's own clinic: two switches' worth of information,
-- and nothing else.
create or replace function public.guidance_assistant_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.guidance_assistant_on(
    app_private.clinic_of_user((select auth.uid()))
  );
$$;

comment on function public.guidance_assistant_available() is
  'Whether the guidance assistant is on for the signed-in user''s clinic, so '
  'a patient''s screen can say it is off instead of offering a message box '
  'chatbot-reply would refuse. Returns nothing else.';

revoke all on function public.guidance_assistant_available() from public, anon, authenticated;
grant execute on function public.guidance_assistant_available() to authenticated;

-- For chatbot-reply, about the patient whose conversation it is answering:
-- their clinic is their assigned doctor's.
create or replace function public.guidance_assistant_on_for_doctor(target_doc_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.guidance_assistant_on(app_private.clinic_of_doctor(target_doc_id));
$$;

comment on function public.guidance_assistant_on_for_doctor(uuid) is
  'Whether the guidance assistant is on for a doctor''s clinic. Called by '
  'chatbot-reply with the service role before it reads a conversation or '
  'calls the provider; never from a browser.';

revoke all on function public.guidance_assistant_on_for_doctor(uuid) from public, anon, authenticated;
grant execute on function public.guidance_assistant_on_for_doctor(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The Super Admin's controls
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_get_guidance_assistant()
returns table (
  enabled    boolean,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_super_admin();

  return query
    select coalesce(
             (select ps.platform_setting_value = 'true'
                from app_private.platform_setting ps
               where ps.platform_setting_key = 'guidance_assistant.enabled'),
             true),
           (select ps.platform_setting_updated_at
              from app_private.platform_setting ps
             where ps.platform_setting_key = 'guidance_assistant.enabled');
end;
$$;

comment on function public.super_admin_get_guidance_assistant() is
  'The platform''s guidance assistant switch, and when it last changed. '
  'Super Admin only.';

create or replace function public.super_admin_set_guidance_assistant(enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := app_private.require_super_admin();
begin
  if enabled is null then
    raise exception 'Say whether the guidance assistant is on or off'
      using errcode = 'check_violation';
  end if;

  -- Writing the value it already has changes nothing and is not audited.
  insert into app_private.platform_setting as ps (
    platform_setting_key, platform_setting_value, platform_setting_updated_by
  )
  values (
    'guidance_assistant.enabled',
    case when enabled then 'true' else 'false' end,
    caller
  )
  on conflict (platform_setting_key) do update
     set platform_setting_value = excluded.platform_setting_value,
         platform_setting_updated_by = excluded.platform_setting_updated_by
   where ps.platform_setting_value is distinct from excluded.platform_setting_value;

  return enabled;
end;
$$;

comment on function public.super_admin_set_guidance_assistant(boolean) is
  'Turns the guidance assistant on or off for every clinic. Super Admin only; '
  'audited as a platform entry.';

-- As every Super Admin operation: callable by a signed-in user, refused
-- inside to anyone but an assured Super Admin.
revoke all on function public.super_admin_get_guidance_assistant() from public, anon, authenticated;
revoke all on function public.super_admin_set_guidance_assistant(boolean) from public, anon, authenticated;
grant execute on function public.super_admin_get_guidance_assistant() to authenticated;
grant execute on function public.super_admin_set_guidance_assistant(boolean) to authenticated;
