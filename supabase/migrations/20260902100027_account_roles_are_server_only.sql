-- ===========================================================================
-- RecoverEase — 20. Who an account is, and what it may do, is the server's
-- ===========================================================================
-- `user_account.user_role` is the single source of every privilege check:
-- `app_private.is_admin()` and the role guards read it and nothing else. Four
-- paths let a signed-in Data API caller change who an account is or attach
-- an identity to it, none of them used by any screen:
--
--   * `user_account_update_admin` let any administrator UPDATE any account
--     row, every column included, and `authenticated` held the UPDATE
--     privilege on `user_role`. One request turned a patient or a doctor into
--     an administrator, who could then do the same for anyone else - and,
--     once a platform role exists, could have minted that too.
--   * The same policy let an administrator rewrite another account's
--     `user_email`, the copy of the sign-in address the app shows and audits.
--   * `doctor_insert_admin` let an administrator INSERT a doctor profile for
--     any existing account - a patient's included - without going through
--     `create-account`, which is the only path that creates a doctor.
--   * The patient guard (migration 08) stops a patient moving themselves to
--     another doctor, but let their assigned doctor hand them to any doctor
--     row at all, a deactivated one included, where no active clinician can
--     see them.
--
-- Accounts are created by `create-account` with the service role, and no
-- screen or function changes an account after that: roles are fixed when
-- an account is created. So this removes the browser's write access to
-- `user_account` outright rather than narrowing it:
--
--   * No UPDATE policy on `user_account`, and no INSERT, UPDATE, DELETE or
--     TRUNCATE privilege on it for `anon` or `authenticated`.
--   * A guard trigger refuses any write to `user_account` from those roles
--     regardless, so a policy or grant added later cannot quietly reopen it,
--     and `user_id` cannot be changed by anyone.
--   * No INSERT policy or privilege on `doctor` for those roles.
--   * A doctor or patient profile can only be created for an account that
--     already has that role - for every writer, service role included.
--   * A patient can only be reassigned to an active doctor whose account is
--     a doctor's.
--
-- Unchanged: `create-account` (service role) creates accounts and profiles
-- exactly as before; administrators still list, edit, deactivate and
-- reactivate doctors; doctors and patients still edit their own profiles;
-- every existing row, audit trigger and read policy stays as it is.
--
-- The guards use current_user, and the account guard is not SECURITY
-- DEFINER, for the reason migration 22 gives: it is what tells a direct
-- client write apart from one the server makes. The other two are SECURITY
-- DEFINER because they must read rows the caller's own policies hide (a
-- doctor cannot read another doctor's row).
--
-- Every statement can be run again safely: policies are dropped `if exists`,
-- revokes and `create or replace` are repeatable, and each trigger is
-- dropped `if exists` before it is created. Nothing here reads or rewrites a
-- row, so existing accounts, profiles and records are untouched.
--
-- Rollback, should it be needed (restores the previous behaviour exactly,
-- including the weaknesses above):
--   drop trigger patient_reassignment_requires_active_doctor on public.patient;
--   drop function public.patient_guard_reassignment();
--   drop trigger patient_profile_matches_role on public.patient;
--   drop trigger doctor_profile_matches_role on public.doctor;
--   drop function public.profile_matches_account_role();
--   drop trigger user_account_guard_writes on public.user_account;
--   drop function public.user_account_guard_writes();
--   grant insert on public.doctor to anon, authenticated;
--   create policy doctor_insert_admin on public.doctor for insert
--     to authenticated with check ((select app_private.is_admin()));
--   grant insert, update, delete, truncate on public.user_account
--     to anon, authenticated;
--   create policy user_account_update_admin on public.user_account
--     for update to authenticated
--     using ((select app_private.is_admin()))
--     with check ((select app_private.is_admin()));
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- user_account: written only by the server
-- ---------------------------------------------------------------------------

drop policy if exists user_account_update_admin on public.user_account;

revoke insert, update, delete, truncate on public.user_account
  from anon, authenticated;

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

  return coalesce(new, old);
end;
$$;

comment on function public.user_account_guard_writes() is
  'Refuses every insert, update and delete of user_account by the anon or '
  'authenticated role, whatever the policies say, and refuses a change of '
  'user_id by anyone. create-account writes as service_role and is '
  'unaffected. Run only by the user_account_guard_writes trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.user_account_guard_writes()
  from public, anon, authenticated;

drop trigger if exists user_account_guard_writes on public.user_account;
create trigger user_account_guard_writes
  before insert or update or delete on public.user_account
  for each row execute function public.user_account_guard_writes();

comment on trigger user_account_guard_writes on public.user_account is
  'Keeps roles and sign-in identities out of reach of direct client writes.';

-- ---------------------------------------------------------------------------
-- doctor: created only through create-account
-- ---------------------------------------------------------------------------

drop policy if exists doctor_insert_admin on public.doctor;

revoke insert on public.doctor from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A profile belongs to an account of the same role
-- ---------------------------------------------------------------------------
-- Checked for every writer. create-account inserts the account with its role
-- first and the profile second, so it already satisfies this; what it stops
-- is a doctor profile on a patient's account, or a patient profile on an
-- administrator's.

create or replace function public.profile_matches_account_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected public.user_role := tg_argv[0]::public.user_role;
begin
  if not exists (
    select 1
      from public.user_account ua
     where ua.user_id = new.user_id
       and ua.user_role = expected
  ) then
    raise exception 'A % profile can only belong to a % account',
      expected, expected
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.profile_matches_account_role() is
  'Refuses a doctor or patient profile for an account whose role is not '
  'doctor or patient respectively. Argument: the role the profile requires. '
  'Run only by the doctor_profile_matches_role and '
  'patient_profile_matches_role triggers.';

revoke all on function public.profile_matches_account_role()
  from public, anon, authenticated;

drop trigger if exists doctor_profile_matches_role on public.doctor;
create trigger doctor_profile_matches_role
  before insert on public.doctor
  for each row execute function public.profile_matches_account_role('doctor');

drop trigger if exists patient_profile_matches_role on public.patient;
create trigger patient_profile_matches_role
  before insert on public.patient
  for each row execute function public.profile_matches_account_role('patient');

-- ---------------------------------------------------------------------------
-- patient: reassigned only to an active doctor
-- ---------------------------------------------------------------------------
-- The assigned doctor may still reassign their patient (migration 08 keeps
-- that with them), but only to a doctor who can actually see the record:
-- active, and holding a doctor's account. A deactivated doctor sees nothing
-- (app_private.is_my_patient requires doc_is_active), so handing a patient to
-- one would leave them with no clinician at all.

create or replace function public.patient_guard_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.doc_id is distinct from old.doc_id
     and not exists (
       select 1
         from public.doctor d
         join public.user_account ua on ua.user_id = d.user_id
        where d.doc_id = new.doc_id
          and d.doc_is_active
          and ua.user_role = 'doctor'
     ) then
    raise exception 'A patient can only be assigned to an active doctor'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.patient_guard_reassignment() is
  'Refuses a change of patient.doc_id to a doctor that is deactivated or '
  'whose account is not a doctor''s. Run only by the '
  'patient_reassignment_requires_active_doctor trigger.';

revoke all on function public.patient_guard_reassignment()
  from public, anon, authenticated;

drop trigger if exists patient_reassignment_requires_active_doctor on public.patient;
create trigger patient_reassignment_requires_active_doctor
  before update of doc_id on public.patient
  for each row execute function public.patient_guard_reassignment();
