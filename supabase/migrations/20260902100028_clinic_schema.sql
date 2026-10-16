-- ===========================================================================
-- RecoverEase — 21. Clinics: the schema, before any clinic exists
-- ===========================================================================
-- Phase A, step 1 of the multi-clinic work. Every account will belong to a
-- clinic - doctors and Clinic Admins directly, patients through their
-- doctor - but this migration only lays the ground. It adds no clinic row,
-- no clinic name and no clinic column on any profile, so nothing anyone can
-- see or do changes:
--
--   * `clinic`: a name (unique ignoring case and surrounding spaces), a
--     status, a time zone that must be a real one, and timestamps. Written
--     only by the server; RLS lets a member read their own clinic, and until
--     migration 29 gives profiles a clinic nobody is a member of one.
--   * A gate allowing at most one clinic row. Settings and every reminder
--     function still assume a single clinic; the gate comes down only once
--     they no longer do (migration 31).
--   * Helpers saying which clinic the caller, a doctor or a patient belongs
--     to. With no profile clinic column yet, the honest answer is "none":
--     they return NULL for everyone, which every policy reads as "no
--     access". Migration 29 adds the columns and replaces these bodies.
--   * An admin profile can only belong to an account whose role is admin,
--     as migration 27 already requires of doctor and patient profiles.
--   * Once an account has a profile its role is fixed, for every writer,
--     the service role included. Nothing in the application changes a role -
--     roles are fixed when an account is created - so this only refuses what
--     was already never done, and would otherwise leave a profile attached to
--     an account of the wrong role.
--
-- Unchanged: creating accounts and profiles in the existing order
-- (create-account: the account, then its profile), every profile and
-- account edit the application makes, and every existing row, policy and
-- audit trigger.
--
-- Every statement can be run again safely, and nothing here reads or
-- rewrites an existing row.
--
-- Rollback, should it be needed (no data is lost; the table is empty until
-- migration 29):
--   drop trigger admin_profile_matches_role on public.admin;
--   then re-run the "user_account: written only by the server" section of
--   migration 27, which restores user_account_guard_writes without the role
--   freeze;
--   drop table public.clinic;
--   drop function public.clinic_validate_timezone();
--   drop type public.clinic_status;
--   drop function app_private.current_clinic_id();
--   drop function app_private.clinic_of_doctor(uuid);
--   drop function app_private.clinic_of_patient(uuid);
--   drop function app_private.account_has_profile(uuid);
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- clinic
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.clinic_status as enum ('active', 'inactive');
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.clinic (
  clinic_id         uuid primary key default gen_random_uuid(),
  clinic_name       text not null,
  clinic_status     public.clinic_status not null default 'active',
  -- The wall-clock zone medication times and calendar dates are read in.
  clinic_timezone   text not null default 'Asia/Manila',
  clinic_created_at timestamptz not null default now(),
  clinic_updated_at timestamptz not null default now(),

  constraint clinic_name_not_blank check (btrim(clinic_name) <> '')
);

comment on table public.clinic is
  'A clinic using RecoverEase. Doctors and Clinic Admins belong to one '
  'directly (migration 29); patients through their assigned doctor. Written '
  'only by the server.';

-- A name in another case, or with stray spaces around it, is the same clinic.
create unique index if not exists clinic_name_key
  on public.clinic (lower(btrim(clinic_name)));

-- At most one clinic until settings, reminders and the chatbot read their
-- values per clinic. Migration 31 drops this index.
create unique index if not exists clinic_single_clinic_gate
  on public.clinic ((true));

comment on index public.clinic_single_clinic_gate is
  'Allows at most one clinic row until every settings reader is clinic-aware '
  '(migration 31 drops it).';

-- A time zone PostgreSQL cannot resolve would make every dose time and
-- calendar date of the clinic wrong. A trigger rather than a CHECK because
-- pg_timezone_names is not immutable.
create or replace function public.clinic_validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names tz
     where tz.name = new.clinic_timezone
  ) then
    raise exception 'Unknown time zone: %', new.clinic_timezone
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.clinic_validate_timezone() is
  'Refuses a clinic time zone PostgreSQL does not know, such as a typo. Run '
  'only by the clinic_validate_timezone trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.clinic_validate_timezone()
  from public, anon, authenticated;

drop trigger if exists clinic_validate_timezone on public.clinic;
create trigger clinic_validate_timezone
  before insert or update of clinic_timezone on public.clinic
  for each row execute function public.clinic_validate_timezone();

drop trigger if exists clinic_set_updated_at on public.clinic;
create trigger clinic_set_updated_at
  before update on public.clinic
  for each row execute function public.set_updated_at('clinic_updated_at');

-- A clinic holds no patient data, so its values are recorded in full.
drop trigger if exists clinic_audit on public.clinic;
create trigger clinic_audit
  after insert or update or delete on public.clinic
  for each row execute function
    public.audit_row_change('clinic', 'clinic_id', 'values');

alter table public.clinic enable row level security;

-- Written only by the server, like user_account (migration 27).
revoke insert, update, delete, truncate on public.clinic
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Which clinic: safe before any profile has one
-- ---------------------------------------------------------------------------
-- The final bodies need doctor.clinic_id and admin.clinic_id, which migration
-- 29 adds. Until then no account belongs to any clinic, and these say so
-- rather than fail. Same shape as the other app_private helpers (migration
-- 06), so migration 29 can replace the bodies in place.

create or replace function app_private.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- No profile has a clinic before migration 29.
  select null::uuid;
$$;

create or replace function app_private.clinic_of_doctor(target_doc_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- No doctor has a clinic before migration 29.
  select null::uuid;
$$;

create or replace function app_private.clinic_of_patient(target_pat_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- A patient's clinic is their doctor's, and no doctor has one before
  -- migration 29.
  select null::uuid;
$$;

comment on function app_private.current_clinic_id() is
  'The caller''s clinic. NULL for everyone until migration 29 gives profiles '
  'a clinic.';

revoke all on function app_private.current_clinic_id() from public;
revoke all on function app_private.clinic_of_doctor(uuid) from public;
revoke all on function app_private.clinic_of_patient(uuid) from public;
grant execute on function app_private.current_clinic_id()
  to authenticated, service_role;
grant execute on function app_private.clinic_of_doctor(uuid)
  to authenticated, service_role;
grant execute on function app_private.clinic_of_patient(uuid)
  to authenticated, service_role;

-- A member reads their own clinic. Nobody is a member of one before
-- migration 29, so this grants nothing yet.
drop policy if exists clinic_select_member on public.clinic;
create policy clinic_select_member
  on public.clinic for select to authenticated
  using (clinic_id = (select app_private.current_clinic_id()));

-- ---------------------------------------------------------------------------
-- An admin profile belongs to an admin account
-- ---------------------------------------------------------------------------
-- The same rule migration 27 applies to doctor and patient profiles, through
-- the same function, and for every writer. Checked again if a profile's
-- account is ever changed, so it cannot be moved onto a doctor's or a
-- patient's account. The clinic an admin belongs to is required from
-- migration 29, once the column exists.

drop trigger if exists admin_profile_matches_role on public.admin;
create trigger admin_profile_matches_role
  before insert or update of user_id on public.admin
  for each row execute function public.profile_matches_account_role('admin');

-- ---------------------------------------------------------------------------
-- An account's role is fixed once it has a profile
-- ---------------------------------------------------------------------------
-- Migration 27's guard, with one rule added: a role cannot change while a
-- doctor, patient or admin profile hangs off the account. Not even the
-- service role can do it, so no server code path can leave a profile on an
-- account of the wrong role. Before a profile exists - an account created a
-- moment ago - the server may still correct it.
--
-- Still not SECURITY DEFINER: current_user is what tells a direct client
-- write from a server one (migration 27). Whether a profile exists is asked
-- of a SECURITY DEFINER helper instead, so the answer never depends on what
-- the writer's own policies let it see.

create or replace function app_private.account_has_profile(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.doctor d where d.user_id = target_user_id)
      or exists (select 1 from public.patient p where p.user_id = target_user_id)
      or exists (select 1 from public.admin a where a.user_id = target_user_id);
$$;

comment on function app_private.account_has_profile(uuid) is
  'Whether a doctor, patient or admin profile belongs to the account. Used by '
  'the user_account guard; callable only by server roles.';

-- Takes any account id, so no session may call it: browser roles are
-- refused by the guard before it is ever reached.
revoke all on function app_private.account_has_profile(uuid) from public;
grant execute on function app_private.account_has_profile(uuid) to service_role;

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

  return coalesce(new, old);
end;
$$;

comment on function public.user_account_guard_writes() is
  'Refuses every insert, update and delete of user_account by the anon or '
  'authenticated role, whatever the policies say; refuses a change of '
  'user_id by anyone; and refuses a change of user_role, by anyone, once the '
  'account has a doctor, patient or admin profile. create-account writes as '
  'service_role and is unaffected. Run only by the user_account_guard_writes '
  'trigger.';

revoke all on function public.user_account_guard_writes()
  from public, anon, authenticated;
