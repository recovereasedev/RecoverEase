-- ===========================================================================
-- RecoverEase — 26. The Super Admin: the platform, never patient care
-- ===========================================================================
-- Phase A, PR 4. The Super Admin runs RecoverEase itself - its clinics, their
-- Clinic Admins, platform announcements and the platform's own audit trail -
-- and sees nothing clinical. Everything here is additive:
--
--   * `super_admin`: a profile for an account whose role is `super_admin`
--     (migration 32). The role is given only by
--     `app_private.provision_super_admin`, which only the database owner can
--     run: no Data API caller, the service role included, can make one, and
--     a Super Admin's role can never be changed. No account is made one here.
--   * Every Super Admin operation asks `app_private.require_super_admin()`
--     first. It accepts a caller only when all of these hold, each read from
--     Supabase Auth's own records rather than from anything the caller says:
--       - the token's subject is a `super_admin` account with its profile;
--       - the sign-in exists, is not deleted and is not banned;
--       - the token's session is still live in `auth.sessions` - not signed
--         out, not past `not_after` - and is the caller's own;
--       - that session is `aal2`, and the token says `aal2` too;
--       - it was raised to `aal2` with an authenticator app (a `totp` claim
--         on the session in `auth.mfa_amr_claims`), using a verified TOTP
--         factor that belongs to the caller (`auth.sessions.factor_id`).
--   * Clinics: list, create (name and time zone validated, the clinic's own
--     default settings, all in one transaction) and set status, active or
--     inactive. No clinic is deleted. An inactive clinic takes no new Clinic
--     Admin; its people and records are untouched.
--   * Clinic Admins: `create-account` creates the sign-in with the service
--     key, then attaches it here, as the Super Admin, to a clinic that exists
--     and is active. The account is always a Clinic Admin's.
--   * Platform announcements: the announcement table's planned "no clinic"
--     row (migration 30), written by a Super Admin. Published ones reach every
--     signed-in user, as migration 30's policy already says; drafts reach no
--     one but the Super Admin. A Clinic Admin cannot touch them.
--   * The platform audit trail: the Super Admin reads `platform` entries -
--     clinics, platform announcements, Super Admin and Clinic Admin
--     provisioning - and no other. Clinic Admins still never read them.
--
-- What does not change: every existing policy, so a Super Admin, having no
-- admin, doctor or patient profile, reads no clinical row - no patient,
-- prescription, dose, plan, journal, appointment, chat or notification - and
-- no clinic setting. The single-clinic gate stays (migration 34 is separate).
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100033_super_admin_platform.down.sql, applied as
-- a new migration with approval, only while no Super Admin, platform
-- announcement or second clinic exists. tests/db/super-admin-rollback.test.ts
-- proves it returns the schema to exactly what migration 32 left.
-- ===========================================================================

-- Before anything is created: 31 and 32 must be in, 33 not yet, and nothing
-- may already hold the new role.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 33 needs migration 31 first. Nothing was applied.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_enum e
      join pg_catalog.pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role' and e.enumlabel = 'super_admin'
  ) then
    raise exception 'Migration 33 needs migration 32 first. Nothing was applied.';
  end if;

  if to_regclass('public.super_admin') is not null then
    raise exception 'Migration 33 has already been applied. Nothing was changed.';
  end if;

  if exists (select 1 from public.user_account where user_role::text = 'super_admin') then
    raise exception 'An account already has the super_admin role, outside the provisioning procedure. Nothing was applied.';
  end if;

  -- The announcement rules below hold for every row that exists.
  if exists (select 1 from public.announcement where admin_id is null or clinic_id is null) then
    raise exception 'An announcement has no author or no clinic. Nothing was applied.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The Super Admin profile
-- ---------------------------------------------------------------------------

create table public.super_admin (
  super_admin_id         uuid primary key default gen_random_uuid(),
  user_id                uuid not null unique
                           references public.user_account (user_id)
                           on delete cascade,
  super_admin_first_name text not null,
  super_admin_last_name  text not null,
  super_admin_created_at timestamptz not null default now(),

  constraint super_admin_first_name_not_blank check (btrim(super_admin_first_name) <> ''),
  constraint super_admin_last_name_not_blank  check (btrim(super_admin_last_name) <> ''),
  constraint super_admin_first_name_length    check (char_length(super_admin_first_name) <= 100),
  constraint super_admin_last_name_length     check (char_length(super_admin_last_name) <= 100)
);

comment on table public.super_admin is
  'The platform''s administrators. Created only by '
  'app_private.provision_super_admin; a Super Admin belongs to no clinic and '
  'has no access to clinical records.';

alter table public.super_admin enable row level security;

-- Written only by the provisioning procedure, which runs as the owner.
revoke insert, update, delete, truncate on public.super_admin
  from anon, authenticated, service_role;

-- A Super Admin reads their own profile, for their name on screen.
create policy super_admin_select_self
  on public.super_admin for select to authenticated
  using (user_id = (select auth.uid()));

-- The profile belongs to a super_admin account (migration 27's rule)...
create trigger super_admin_profile_matches_role
  before insert or update of user_id on public.super_admin
  for each row execute function public.profile_matches_account_role('super_admin');

-- ...is made only by the procedure, and stays with its sign-in.
create or replace function public.super_admin_guard_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     and coalesce(current_setting('app.provisioning', true), '') <> 'super_admin' then
    raise exception 'A Super Admin is created only through the provisioning procedure'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'The linked account of a Super Admin profile cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.super_admin_guard_writes() is
  'Refuses a Super Admin profile made outside app_private.provision_super_admin, '
  'and any change of its account. Run only by its trigger.';

revoke all on function public.super_admin_guard_writes() from public, anon, authenticated;

create trigger super_admin_guard_writes
  before insert or update on public.super_admin
  for each row execute function public.super_admin_guard_writes();

-- A Super Admin profile counts as a profile: once it exists, the account's
-- role is fixed (migration 28).
create or replace function app_private.account_has_profile(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.doctor d where d.user_id = target_user_id)
      or exists (select 1 from public.patient p where p.user_id = target_user_id)
      or exists (select 1 from public.admin a where a.user_id = target_user_id)
      or exists (select 1 from public.super_admin s where s.user_id = target_user_id);
$$;

comment on function app_private.account_has_profile(uuid) is
  'Whether a doctor, patient, admin or Super Admin profile belongs to the '
  'account. Used by the user_account guard; callable only by server roles.';

-- ---------------------------------------------------------------------------
-- The super_admin role: given by one procedure, never taken by anyone
-- ---------------------------------------------------------------------------
-- Migration 28's guard, with two rules added. The provisioning procedure
-- marks its own transaction; nothing else can, since no Data API caller can
-- set a database setting. So the service role - which can write any other
-- role while an account has no profile - cannot write this one.

create or replace function public.user_account_guard_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
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

  -- Only the provisioning procedure makes a Super Admin...
  if tg_op in ('INSERT', 'UPDATE')
     and new.user_role = 'super_admin'
     and (tg_op = 'INSERT' or old.user_role is distinct from 'super_admin')
     and coalesce(current_setting('app.provisioning', true), '') <> 'super_admin' then
    raise exception 'A Super Admin is created only through the provisioning procedure'
      using errcode = 'insufficient_privilege';
  end if;

  -- ...and a Super Admin is never turned into anything else.
  if tg_op = 'UPDATE'
     and old.user_role = 'super_admin'
     and new.user_role is distinct from old.user_role then
    raise exception 'The role of a Super Admin cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.user_account_guard_writes() is
  'Refuses every insert, update and delete of user_account by the anon or '
  'authenticated role, whatever the policies say; refuses a change of '
  'user_id by anyone; refuses a change of user_role, by anyone, once the '
  'account has a profile; refuses the super_admin role outside '
  'app_private.provision_super_admin; and never changes a Super Admin''s '
  'role. create-account writes as service_role. Run only by the '
  'user_account_guard_writes trigger.';

revoke all on function public.user_account_guard_writes()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Is the caller a Super Admin, here and now, verified with an authenticator?
-- ---------------------------------------------------------------------------

create or replace function app_private.assured_super_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller  uuid := auth.uid();
  claims  jsonb := auth.jwt();
  session_ref uuid;
begin
  if caller is null or claims is null then
    return null;
  end if;

  -- The token itself must say aal2 ...
  if claims ->> 'aal' is distinct from 'aal2' then
    return null;
  end if;

  begin
    session_ref := (claims ->> 'session_id')::uuid;
  exception
    when invalid_text_representation then
      return null;
  end;
  if session_ref is null then
    return null;
  end if;

  if not exists (
    select 1
      from public.user_account ua
      join public.super_admin sa on sa.user_id = ua.user_id
     where ua.user_id = caller
       and ua.user_role = 'super_admin'
  ) then
    return null;
  end if;

  if not exists (
    select 1 from auth.users u
     where u.id = caller
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  ) then
    return null;
  end if;

  -- ... and so must Supabase Auth: the caller's own session, still live,
  -- raised to aal2 with the caller's own verified TOTP factor ...
  if not exists (
    select 1
      from auth.sessions s
      join auth.mfa_factors f on f.id = s.factor_id
     where s.id = session_ref
       and s.user_id = caller
       and s.aal = 'aal2'
       and (s.not_after is null or s.not_after > now())
       and f.user_id = caller
       and f.factor_type = 'totp'
       and f.status = 'verified'
  ) then
    return null;
  end if;

  -- ... by an authenticator-app code in this very session.
  if not exists (
    select 1 from auth.mfa_amr_claims c
     where c.session_id = session_ref
       and c.authentication_method = 'totp'
  ) then
    return null;
  end if;

  return caller;
end;
$$;

comment on function app_private.assured_super_admin() is
  'The caller''s user id when they are a Super Admin whose current, live '
  'session was raised to aal2 with their own verified TOTP factor; NULL '
  'otherwise. Reads auth.sessions, auth.mfa_factors and auth.mfa_amr_claims, '
  'never trusting the token''s claims alone.';

create or replace function app_private.require_super_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := app_private.assured_super_admin();
begin
  if caller is null then
    raise exception 'Super Admin access requires a current session verified with an authenticator app'
      using errcode = 'insufficient_privilege';
  end if;
  return caller;
end;
$$;

comment on function app_private.require_super_admin() is
  'Raises insufficient_privilege unless app_private.assured_super_admin() '
  'accepts the caller; returns their user id. Every Super Admin operation '
  'calls it first.';

-- Called only from the owner's SECURITY DEFINER functions below.
revoke all on function app_private.assured_super_admin() from public, anon, authenticated, service_role;
revoke all on function app_private.require_super_admin() from public, anon, authenticated, service_role;

-- For the console to know whether to ask for an authenticator code. Says
-- nothing about anyone but the caller.
create or replace function public.super_admin_assured()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.assured_super_admin() is not null;
$$;

comment on function public.super_admin_assured() is
  'Whether the caller may use Super Admin operations right now: a Super '
  'Admin in a live session verified with their authenticator app.';

-- ---------------------------------------------------------------------------
-- Making and removing a Super Admin: the database owner only
-- ---------------------------------------------------------------------------
-- The first Super Admin is a deliberate, approved act: a sign-in is created
-- in Supabase Auth, then this is run once, as the owner, in the SQL editor
-- (docs/security.md). No API, Edge Function or role can call it.

create or replace function app_private.provision_super_admin(
  target_user_id uuid,
  first_name     text,
  last_name      text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  login_email text;
  new_id      uuid;
begin
  select lower(btrim(u.email)) into login_email
    from auth.users u
   where u.id = target_user_id
     and u.deleted_at is null;

  if login_email is null or login_email = '' then
    raise exception 'No sign-in with that id exists'
      using errcode = 'no_data_found';
  end if;

  -- Never an existing patient's, doctor's or Clinic Admin's account: their
  -- clinical or clinic access would come with it.
  if exists (select 1 from public.user_account ua where ua.user_id = target_user_id) then
    raise exception 'That sign-in already has a RecoverEase account; a Super Admin needs a sign-in of their own'
      using errcode = 'unique_violation';
  end if;

  if btrim(coalesce(first_name, '')) = '' or btrim(coalesce(last_name, '')) = '' then
    raise exception 'A Super Admin needs a first and last name'
      using errcode = 'check_violation';
  end if;

  perform set_config('app.provisioning', 'super_admin', true);

  insert into public.user_account (user_id, user_email, user_role)
  values (target_user_id, login_email, 'super_admin');

  insert into public.super_admin (user_id, super_admin_first_name, super_admin_last_name)
  values (target_user_id, btrim(first_name), btrim(last_name))
  returning super_admin_id into new_id;

  perform set_config('app.provisioning', '', true);

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details
  )
  values ((select auth.uid()), 'create', 'super_admin', new_id, '{}'::jsonb);

  return new_id;
end;
$$;

comment on function app_private.provision_super_admin(uuid, text, text) is
  'Makes an existing Supabase Auth sign-in with no RecoverEase account a '
  'Super Admin. Owner only; audited as a platform entry. The new Super Admin '
  'can do nothing until they enrol an authenticator app.';

create or replace function app_private.revoke_super_admin(target_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  removed uuid;
begin
  select sa.super_admin_id into removed
    from public.super_admin sa
   where sa.user_id = target_user_id;

  if removed is null then
    raise exception 'That user is not a Super Admin'
      using errcode = 'no_data_found';
  end if;

  if exists (select 1 from public.announcement an where an.super_admin_id = removed) then
    raise exception 'This Super Admin wrote platform announcements; they stay attributed, so the account is kept. Ban the sign-in in Supabase Auth instead.'
      using errcode = 'foreign_key_violation';
  end if;

  -- The profile goes with the account.
  delete from public.user_account where user_id = target_user_id;

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details
  )
  values ((select auth.uid()), 'delete', 'super_admin', removed, '{}'::jsonb);
end;
$$;

comment on function app_private.revoke_super_admin(uuid) is
  'Removes a Super Admin''s account and profile; their Supabase Auth sign-in '
  'is left for the owner to delete or ban. Owner only; audited.';

revoke all on function app_private.provision_super_admin(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.revoke_super_admin(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Clinics
-- ---------------------------------------------------------------------------

-- Bounded, like every other name the platform shows.
alter table public.clinic
  add constraint clinic_name_length check (char_length(clinic_name) <= 120);

-- The clinic fields a Super Admin manages, and how many Clinic Admins each
-- has. Nothing about its doctors' patients.
create or replace function public.super_admin_list_clinics()
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
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app_private.require_super_admin();

  return query
    select c.clinic_id, c.clinic_name, c.clinic_status, c.clinic_timezone,
           c.clinic_created_at, c.clinic_updated_at,
           (select count(*)::integer
              from public.admin a
              join public.user_account ua on ua.user_id = a.user_id
             where a.clinic_id = c.clinic_id
               and ua.user_role = 'admin')
      from public.clinic c
     order by lower(c.clinic_name), c.clinic_id;
end;
$$;

comment on function public.super_admin_list_clinics() is
  'Every clinic''s name, status, time zone and timestamps, with its number of '
  'Clinic Admins. Super Admin only.';

-- One transaction: the clinic and its own default settings, or nothing.
create or replace function public.super_admin_create_clinic(
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
  wanted_name text := btrim(new_clinic_name);
  wanted_zone text := btrim(new_clinic_timezone);
  created     uuid;
begin
  perform app_private.require_super_admin();

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
  if exists (select 1 from public.clinic c where lower(btrim(c.clinic_name)) = lower(wanted_name)) then
    raise exception 'A clinic with that name already exists'
      using errcode = 'unique_violation';
  end if;

  -- clinic_validate_timezone refuses a zone PostgreSQL does not know, and
  -- while the single-clinic gate stands, a second clinic is refused here.
  insert into public.clinic (clinic_name, clinic_timezone)
  values (wanted_name, wanted_zone)
  returning clinic.clinic_id into created;

  -- Its own settings: the platform's defaults, never another clinic's
  -- values. It has no chatbot guidance until its Clinic Admin writes some
  -- (the chatbot then uses the built-in guidance), and no app.timezone row:
  -- the clinic's zone is on the clinic.
  insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
  values (created, 'medication.reminder_grace_hours', '6');

  return query
    select c.clinic_id, c.clinic_name, c.clinic_status, c.clinic_timezone,
           c.clinic_created_at, c.clinic_updated_at, 0
      from public.clinic c
     where c.clinic_id = created;
end;
$$;

comment on function public.super_admin_create_clinic(text, text) is
  'Creates an active clinic with a validated name and time zone and its own '
  'default settings, in one transaction. Super Admin only; audited through '
  'the clinic''s own audit trigger.';

-- The status a clinic can move to from each status. Inactive keeps every
-- person and record; it only stops new Clinic Admins being added.
create or replace function public.super_admin_set_clinic_status(
  target_clinic_id uuid,
  new_status       text
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
  wanted  text := btrim(new_status);
  current_status text;
begin
  perform app_private.require_super_admin();

  select c.clinic_status::text into current_status
    from public.clinic c
   where c.clinic_id = target_clinic_id
   for update;

  if not found then
    raise exception 'That clinic could not be found'
      using errcode = 'no_data_found';
  end if;

  if wanted is null or wanted not in ('active', 'inactive') then
    raise exception 'A clinic''s status is active or inactive'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
      from (values ('active', 'inactive'), ('inactive', 'active')) as allowed(from_status, to_status)
     where allowed.from_status = current_status
       and allowed.to_status = wanted
  ) then
    raise exception 'The clinic is already %', wanted
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.clinic
     set clinic_status = wanted::public.clinic_status
   where clinic.clinic_id = target_clinic_id;

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

comment on function public.super_admin_set_clinic_status(uuid, text) is
  'Moves a clinic between active and inactive. Nothing is deleted or '
  'reassigned. Super Admin only; audited through the clinic''s own audit '
  'trigger.';

-- ---------------------------------------------------------------------------
-- Clinic Admins
-- ---------------------------------------------------------------------------
-- create-account (kind clinic_admin) runs these as the Super Admin, with
-- their own token, so the database decides - not the Edge Function alone:
--
--   1. super_admin_check_clinic_for_admin, before any sign-in exists;
--   2. the sign-in, created with the service key and marked in its
--      app_metadata (which only the service key can write) as made for this
--      clinic's administrator;
--   3. super_admin_attach_clinic_admin, which makes the account and profile
--      in one transaction. If it refuses, create-account deletes the sign-in.

create or replace function app_private.require_active_clinic(target_clinic_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  status public.clinic_status;
begin
  select c.clinic_status into status
    from public.clinic c
   where c.clinic_id = target_clinic_id;

  if not found then
    raise exception 'That clinic could not be found'
      using errcode = 'no_data_found';
  end if;
  if status <> 'active' then
    raise exception 'That clinic is inactive and cannot take a new Clinic Admin'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$$;

revoke all on function app_private.require_active_clinic(uuid) from public, anon, authenticated, service_role;

create or replace function public.super_admin_check_clinic_for_admin(target_clinic_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_super_admin();
  perform app_private.require_active_clinic(target_clinic_id);
  return true;
end;
$$;

comment on function public.super_admin_check_clinic_for_admin(uuid) is
  'Confirms, before any sign-in is created, that the caller may provision a '
  'Clinic Admin and that the clinic exists and is active. Super Admin only.';

create or replace function public.super_admin_attach_clinic_admin(
  target_user_id   uuid,
  target_clinic_id uuid,
  first_name       text,
  last_name        text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller      uuid := app_private.require_super_admin();
  login_email text;
  metadata    jsonb;
  new_admin   uuid;
begin
  -- Locked, so it cannot be made inactive between this check and the insert.
  perform 1 from public.clinic c where c.clinic_id = target_clinic_id for share;
  perform app_private.require_active_clinic(target_clinic_id);

  if btrim(coalesce(first_name, '')) = '' or btrim(coalesce(last_name, '')) = '' then
    raise exception 'A Clinic Admin needs a first and last name'
      using errcode = 'check_violation';
  end if;
  if char_length(btrim(first_name)) > 100 or char_length(btrim(last_name)) > 100 then
    raise exception 'A name can be at most 100 characters'
      using errcode = 'check_violation';
  end if;

  select lower(btrim(u.email)), u.raw_app_meta_data into login_email, metadata
    from auth.users u
   where u.id = target_user_id
     and u.deleted_at is null;

  if login_email is null then
    raise exception 'That sign-in could not be found'
      using errcode = 'no_data_found';
  end if;

  -- Made by create-account for this clinic's administrator, and nothing
  -- else: a sign-up, or a sign-in made for another clinic, is refused.
  if metadata ->> 'provisioned_as' is distinct from 'clinic_admin'
     or metadata ->> 'provisioned_clinic' is distinct from target_clinic_id::text then
    raise exception 'That sign-in was not created for this clinic''s administrator'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.user_account ua where ua.user_id = target_user_id) then
    raise exception 'That sign-in already has an account'
      using errcode = 'unique_violation';
  end if;

  -- Always a Clinic Admin: the role is not the caller's to choose.
  insert into public.user_account (user_id, user_email, user_role)
  values (target_user_id, login_email, 'admin');

  insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
  values (target_user_id, btrim(first_name), btrim(last_name), target_clinic_id)
  returning admin_id into new_admin;

  -- No name or email: the clinic and the new profile's id are enough.
  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
    audit_log_details, clinic_id
  )
  values (
    caller, 'create', 'clinic_admin_account', new_admin,
    jsonb_build_object('clinic_id', target_clinic_id), target_clinic_id
  );

  return new_admin;
end;
$$;

comment on function public.super_admin_attach_clinic_admin(uuid, uuid, text, text) is
  'Makes the Clinic Admin account and profile for a sign-in create-account '
  'made for that clinic, if the clinic exists and is active. Super Admin '
  'only; one transaction; audited as a platform entry.';

-- ---------------------------------------------------------------------------
-- Platform announcements
-- ---------------------------------------------------------------------------
-- Migration 30's "no clinic" announcement, written by a Super Admin. Exactly
-- one author, and the clinic follows from it: a Clinic Admin's announcement
-- is their clinic's, a Super Admin's belongs to none.

alter table public.announcement alter column admin_id drop not null;

alter table public.announcement
  add column super_admin_id uuid
    references public.super_admin (super_admin_id)
    on delete restrict;

alter table public.announcement
  add constraint announcement_one_author
    check (num_nonnulls(admin_id, super_admin_id) = 1);

alter table public.announcement
  add constraint announcement_clinic_follows_author
    check (
      (admin_id is not null and clinic_id is not null)
      or (super_admin_id is not null and clinic_id is null)
    );

create index announcement_super_admin_id_idx
  on public.announcement (super_admin_id)
  where super_admin_id is not null;

comment on column public.announcement.super_admin_id is
  'The Super Admin who wrote a platform announcement; empty for a clinic''s.';

create or replace function public.announcement_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.admin_id is null then
    -- A platform announcement belongs to no clinic.
    new.clinic_id := null;
  else
    new.clinic_id := (select a.clinic_id from public.admin a
                       where a.admin_id = new.admin_id);
  end if;
  return new;
end;
$$;

create or replace function public.announcement_guard_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.admin_id is distinct from old.admin_id
     or new.super_admin_id is distinct from old.super_admin_id
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'An announcement keeps the author and clinic it was written with'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.announcement_guard_author() is
  'Refuses any change to an announcement''s author or clinic, a platform '
  'announcement''s included. Run only by the announcement_author_is_fixed '
  'trigger.';

drop trigger if exists announcement_author_is_fixed on public.announcement;
create trigger announcement_author_is_fixed
  before update of admin_id, super_admin_id, clinic_id on public.announcement
  for each row execute function public.announcement_guard_author();

create or replace function app_private.validate_announcement_text(title text, content text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if btrim(coalesce(title, '')) = '' then
    raise exception 'Give the announcement a title.'
      using errcode = 'check_violation';
  end if;
  if char_length(btrim(title)) > 150 then
    raise exception 'A title can be at most 150 characters'
      using errcode = 'check_violation';
  end if;
  if btrim(coalesce(content, '')) = '' then
    raise exception 'Write the message.'
      using errcode = 'check_violation';
  end if;
  if char_length(btrim(content)) > 5000 then
    raise exception 'A message can be at most 5000 characters'
      using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function app_private.validate_announcement_text(text, text) from public, anon, authenticated, service_role;

-- A platform announcement, locked, or "not found" - never a clinic's.
create or replace function app_private.platform_announcement_for_update(target_announcement_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  published timestamptz;
begin
  select an.announcement_published_at into published
    from public.announcement an
   where an.announcement_id = target_announcement_id
     and an.super_admin_id is not null
   for update;

  if not found then
    raise exception 'That platform announcement could not be found'
      using errcode = 'no_data_found';
  end if;
  return published;
end;
$$;

revoke all on function app_private.platform_announcement_for_update(uuid) from public, anon, authenticated, service_role;

create or replace function public.super_admin_list_announcements()
returns table (
  announcement_id           uuid,
  announcement_title        text,
  announcement_content      text,
  announcement_published_at timestamptz,
  announcement_created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app_private.require_super_admin();

  return query
    select an.announcement_id, an.announcement_title, an.announcement_content,
           an.announcement_published_at, an.announcement_created_at
      from public.announcement an
     where an.super_admin_id is not null
     order by an.announcement_created_at desc, an.announcement_id;
end;
$$;

comment on function public.super_admin_list_announcements() is
  'Platform announcements, drafts included. Never a clinic''s. Super Admin '
  'only.';

create or replace function public.super_admin_create_announcement(
  title   text,
  content text,
  publish boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := app_private.require_super_admin();
  author uuid;
  new_id uuid;
begin
  perform app_private.validate_announcement_text(title, content);

  select sa.super_admin_id into author
    from public.super_admin sa
   where sa.user_id = caller;

  insert into public.announcement (
    super_admin_id, announcement_title, announcement_content, announcement_published_at
  )
  values (
    author, btrim(title), btrim(content),
    case when coalesce(publish, false) then now() end
  )
  returning announcement_id into new_id;

  return new_id;
end;
$$;

comment on function public.super_admin_create_announcement(text, text, boolean) is
  'Writes a platform announcement, as a draft unless publish is true. Super '
  'Admin only; audited as a platform entry.';

create or replace function public.super_admin_update_announcement(
  target_announcement_id uuid,
  title                  text,
  content                text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app_private.require_super_admin();
  perform app_private.validate_announcement_text(title, content);
  perform app_private.platform_announcement_for_update(target_announcement_id);

  update public.announcement
     set announcement_title = btrim(title),
         announcement_content = btrim(content)
   where announcement_id = target_announcement_id;
end;
$$;

comment on function public.super_admin_update_announcement(uuid, text, text) is
  'Edits a platform announcement''s title and message. Super Admin only; '
  'audited.';

create or replace function public.super_admin_set_announcement_published(
  target_announcement_id uuid,
  published              boolean
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_published timestamptz;
begin
  perform app_private.require_super_admin();

  if published is null then
    raise exception 'Say whether the announcement is published'
      using errcode = 'check_violation';
  end if;

  current_published := app_private.platform_announcement_for_update(target_announcement_id);

  -- Already as asked: nothing is written, and nothing is audited.
  if published = (current_published is not null) then
    return current_published;
  end if;

  update public.announcement
     set announcement_published_at = case when published then now() end
   where announcement_id = target_announcement_id;

  return case when published then now() end;
end;
$$;

comment on function public.super_admin_set_announcement_published(uuid, boolean) is
  'Publishes or withdraws a platform announcement. Super Admin only; audited.';

create or replace function public.super_admin_delete_announcement(target_announcement_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app_private.require_super_admin();
  perform app_private.platform_announcement_for_update(target_announcement_id);

  delete from public.announcement where announcement_id = target_announcement_id;
end;
$$;

comment on function public.super_admin_delete_announcement(uuid) is
  'Deletes a platform announcement. Super Admin only; its audit entry keeps '
  'what it said.';

-- ---------------------------------------------------------------------------
-- The audit trail: what is platform, and who reads it
-- ---------------------------------------------------------------------------
-- Migration 31's classifier, with the Super Admin's own entries added as
-- platform: a Super Admin's account, their provisioning of Clinic Admins, and
-- platform announcements. Nothing about a patient can become platform: the
-- scope still comes from the entity alone, and anything unrecognised is
-- clinical.

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

create or replace function app_private.audit_clinic_for(
  entity    text,
  entity_id uuid,
  actor     uuid,
  details   jsonb
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case entity
      when 'clinic' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_settings' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_admin_account' then
        coalesce((select a.clinic_id from public.admin a where a.admin_id = entity_id),
                 (details ->> 'clinic_id')::uuid)
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
$$;

comment on function app_private.audit_clinic_for(text, uuid, uuid, jsonb) is
  'The clinic an audit entry is about, from its entity and id, the recorded '
  'row for a deleted one, or else the actor''s clinic. NULL when none is '
  'known yet, and for the platform''s own entries.';

-- The platform entries, newest first, a page at a time. Never an
-- administration or clinical entry: the scope is filtered here, not by the
-- caller.
create or replace function public.super_admin_list_audit(
  page_size        integer default 50,
  before_timestamp timestamptz default null,
  before_id        uuid default null
)
returns table (
  audit_log_id        uuid,
  audit_log_timestamp timestamptz,
  audit_log_action    text,
  audit_log_entity    text,
  audit_log_entity_id uuid,
  clinic_id           uuid,
  actor_user_id       uuid,
  audit_log_details   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app_private.require_super_admin();

  if page_size is null or page_size < 1 or page_size > 200 then
    raise exception 'Ask for between 1 and 200 entries'
      using errcode = 'check_violation';
  end if;

  return query
    select l.audit_log_id, l.audit_log_timestamp, l.audit_log_action,
           l.audit_log_entity, l.audit_log_entity_id, l.clinic_id, l.user_id,
           l.audit_log_details
      from public.audit_log l
     where l.audit_scope = 'platform'
       and (
         before_timestamp is null
         or (l.audit_log_timestamp, l.audit_log_id)
            < (before_timestamp, coalesce(before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
       )
     order by l.audit_log_timestamp desc, l.audit_log_id desc
     limit page_size;
end;
$$;

comment on function public.super_admin_list_audit(integer, timestamptz, uuid) is
  'Platform audit entries only - clinics, Super Admins, Clinic Admin '
  'provisioning, platform announcements - newest first, keyset-paged by '
  'timestamp and id. Super Admin only.';

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
-- Over RPC, like the other administrator functions: refused to anon, and
-- each one checks its caller in its own body.

revoke all on function
  public.super_admin_assured(),
  public.super_admin_list_clinics(),
  public.super_admin_create_clinic(text, text),
  public.super_admin_set_clinic_status(uuid, text),
  public.super_admin_check_clinic_for_admin(uuid),
  public.super_admin_attach_clinic_admin(uuid, uuid, text, text),
  public.super_admin_list_announcements(),
  public.super_admin_create_announcement(text, text, boolean),
  public.super_admin_update_announcement(uuid, text, text),
  public.super_admin_set_announcement_published(uuid, boolean),
  public.super_admin_delete_announcement(uuid),
  public.super_admin_list_audit(integer, timestamptz, uuid)
  from public, anon;

grant execute on function
  public.super_admin_assured(),
  public.super_admin_list_clinics(),
  public.super_admin_create_clinic(text, text),
  public.super_admin_set_clinic_status(uuid, text),
  public.super_admin_check_clinic_for_admin(uuid),
  public.super_admin_attach_clinic_admin(uuid, uuid, text, text),
  public.super_admin_list_announcements(),
  public.super_admin_create_announcement(text, text, boolean),
  public.super_admin_update_announcement(uuid, text, text),
  public.super_admin_set_announcement_published(uuid, boolean),
  public.super_admin_delete_announcement(uuid),
  public.super_admin_list_audit(integer, timestamptz, uuid)
  to authenticated;
