-- ===========================================================================
-- RecoverEase — 22. The initial clinic, and every doctor and admin in it
-- ===========================================================================
-- Phase A, step 2. Migration 28 laid out an empty clinic table. This adds the
-- clinic RecoverEase already serves, Harborview Recovery Clinic, and puts
-- every existing doctor and administrator in it:
--
--   * The clinic, in the Asia/Manila time zone the application already uses.
--     If the application's time zone setting says anything else, nothing is
--     created: a clinic that disagreed with it would be wrong from day one.
--   * `doctor.clinic_id`, required, and `admin.clinic_id`, required of a
--     Clinic Admin (migration 33 lets a Super Admin have none).
--   * The clinic helpers' real bodies. Until now they answered "none".
--   * Guards: a profile's clinic cannot change once set, an administrator
--     must have one, and a patient can only move to a doctor in the same
--     clinic.
--   * Until migration 31, a doctor created without a clinic is put in the
--     only clinic there is, so the deployed create-account keeps working
--     until its clinic-aware version replaces it. With no clinic, or two, the
--     insert is refused rather than guessed.
--
-- Patients have no clinic column: a patient belongs to their doctor's clinic.
-- No policy changes here. Migration 30 limits Clinic Admins to their clinic.
--
-- The data step is one block. It checks the data, snapshots every id and
-- link, backfills, and compares. An inconsistency - a profile on an account
-- of another role, an account without its profile or with two, a patient
-- without a doctor - or any change it did not intend stops it, and nothing at
-- all is applied. It runs once: it refuses to start if a clinic exists.
--
-- Rollback, should it be needed - and only before migration 30, which builds
-- on this. No clinical row is touched either way:
--   drop trigger doctor_assign_single_clinic on public.doctor;
--   drop trigger doctor_clinic_is_fixed on public.doctor;
--   drop trigger admin_guard_clinic on public.admin;
--   drop trigger patient_reassignment_stays_in_clinic on public.patient;
--   drop function public.doctor_assign_single_clinic();
--   drop function public.profile_clinic_is_fixed();
--   drop function public.admin_guard_clinic();
--   drop function public.patient_guard_clinic();
--   drop function app_private.admin_clinic_id();
--   drop function app_private.clinic_of_user(uuid);
--   alter table public.doctor drop column clinic_id;
--   alter table public.admin drop column clinic_id;
--   delete from public.clinic;
--   then re-run migration 28's "Which clinic" section, which restores the
--   helpers' "none" bodies. The audit entries this wrote stay.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Snapshots for the data step
-- ---------------------------------------------------------------------------
-- Temporary: they exist for this session only. Each is defined once and read
-- before and after, so the two sides of every comparison cannot drift apart.

-- Every id and link the migration must leave exactly as it found it.
create function pg_temp.initial_clinic_identities()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'accounts', (select coalesce(jsonb_agg(jsonb_build_array(
                          ua.user_id, ua.user_role, ua.user_email)
                        order by ua.user_id), '[]'::jsonb)
                   from public.user_account ua),
    'doctors',  (select coalesce(jsonb_agg(jsonb_build_array(
                          d.doc_id, d.user_id, d.doc_is_active, d.doc_license_no)
                        order by d.doc_id), '[]'::jsonb)
                   from public.doctor d),
    'admins',   (select coalesce(jsonb_agg(jsonb_build_array(
                          a.admin_id, a.user_id)
                        order by a.admin_id), '[]'::jsonb)
                   from public.admin a),
    'patients', (select coalesce(jsonb_agg(jsonb_build_array(
                          p.pat_id, p.user_id, p.doc_id, p.pat_status)
                        order by p.pat_id), '[]'::jsonb)
                   from public.patient p)
  );
$$;

-- The row count of every public table.
create function pg_temp.initial_clinic_row_counts()
returns jsonb
language plpgsql
stable
as $$
declare
  counts jsonb := '{}'::jsonb;
  tbl    text;
  n      bigint;
begin
  for tbl in
    select c.relname
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
     order by c.relname
  loop
    execute format('select count(*) from public.%I', tbl) into n;
    counts := counts || jsonb_build_object(tbl, n);
  end loop;
  return counts;
end;
$$;

-- ---------------------------------------------------------------------------
-- The data step: the clinic, the profile columns, the backfill
-- ---------------------------------------------------------------------------

do $$
declare
  initial_name        constant text := 'Harborview Recovery Clinic';
  initial_timezone    constant text := 'Asia/Manila';
  configured_timezone text;
  problems            text;
  identities_before   jsonb;
  counts_before       jsonb;
  counts_after        jsonb;
  initial_clinic      uuid;
  doctors_assigned    bigint;
begin
  -- Nothing may change these between the checks below and the commit. The
  -- profiles are altered, so they are locked outright; the rest only read.
  lock table public.doctor, public.admin in access exclusive mode;
  lock table public.user_account, public.patient, public.clinic,
             public.system_setting in share row exclusive mode;

  if exists (select 1 from public.clinic) then
    raise exception 'Migration 29 creates the first clinic, but % already exist',
      (select count(*) from public.clinic);
  end if;

  select s.system_setting_value into configured_timezone
    from public.system_setting s
   where s.system_setting_key = 'app.timezone';

  if configured_timezone is not null
     and configured_timezone <> initial_timezone then
    raise exception
      'The application time zone is %, not %. Migration 29 changed nothing.',
      configured_timezone, initial_timezone;
  end if;

  -- Records that would put someone in the wrong clinic, or in none. Reported
  -- by id only, never by name or email.
  select string_agg(issue, '; ' order by issue) into problems
    from (
      select format('doctor %s is on a %s account', d.doc_id,
                    coalesce(ua.user_role::text, 'missing')) as issue
        from public.doctor d
        left join public.user_account ua on ua.user_id = d.user_id
       where ua.user_role is distinct from 'doctor'
      union all
      select format('admin %s is on a %s account', a.admin_id,
                    coalesce(ua.user_role::text, 'missing'))
        from public.admin a
        left join public.user_account ua on ua.user_id = a.user_id
       where ua.user_role is distinct from 'admin'
      union all
      select format('patient %s is on a %s account', p.pat_id,
                    coalesce(ua.user_role::text, 'missing'))
        from public.patient p
        left join public.user_account ua on ua.user_id = p.user_id
       where ua.user_role is distinct from 'patient'
      union all
      select format('patient %s has no doctor', p.pat_id)
        from public.patient p
        left join public.doctor d on d.doc_id = p.doc_id
       where d.doc_id is null
      union all
      select format('account %s has %s profiles', counted.user_id, counted.profiles)
        from (
          select ua.user_id,
                 (select count(*) from public.doctor d where d.user_id = ua.user_id)
               + (select count(*) from public.admin a where a.user_id = ua.user_id)
               + (select count(*) from public.patient p where p.user_id = ua.user_id)
                   as profiles
            from public.user_account ua
        ) counted
       where counted.profiles <> 1
    ) issues;

  if problems is not null then
    raise exception 'Migration 29 found inconsistent records and changed nothing: %',
      problems;
  end if;

  identities_before := pg_temp.initial_clinic_identities();
  counts_before := pg_temp.initial_clinic_row_counts();

  insert into public.clinic (clinic_name, clinic_timezone)
  values (initial_name, initial_timezone)
  returning clinic_id into initial_clinic;

  alter table public.doctor
    add column clinic_id uuid references public.clinic (clinic_id) on delete restrict;
  alter table public.admin
    add column clinic_id uuid references public.clinic (clinic_id) on delete restrict;

  -- Each doctor's change is audited by the existing doctor trigger, so the
  -- trail shows when every clinician joined the clinic.
  update public.doctor set clinic_id = initial_clinic where clinic_id is null;
  get diagnostics doctors_assigned = row_count;

  update public.admin set clinic_id = initial_clinic where clinic_id is null;

  if pg_temp.initial_clinic_identities() <> identities_before then
    raise exception 'Migration 29 would have changed an existing id or link. Nothing was applied.';
  end if;

  if exists (select 1 from public.doctor where clinic_id is distinct from initial_clinic)
     or exists (select 1 from public.admin where clinic_id is distinct from initial_clinic) then
    raise exception 'Migration 29 left a doctor or admin outside the clinic. Nothing was applied.';
  end if;

  -- Only two tables may have grown: one clinic, and the audit trail by that
  -- clinic's entry plus one entry per doctor assigned.
  counts_after := pg_temp.initial_clinic_row_counts();
  if counts_after <> (counts_before || jsonb_build_object(
       'clinic',    (counts_before ->> 'clinic')::bigint + 1,
       'audit_log', (counts_before ->> 'audit_log')::bigint + 1 + doctors_assigned
     )) then
    raise exception 'Migration 29 changed row counts it should not have: before %, after %. Nothing was applied.',
      counts_before, counts_after;
  end if;

  alter table public.doctor alter column clinic_id set not null;
end;
$$;

drop function pg_temp.initial_clinic_identities();
drop function pg_temp.initial_clinic_row_counts();

create index if not exists doctor_clinic_id_idx on public.doctor (clinic_id);
create index if not exists admin_clinic_id_idx on public.admin (clinic_id);

comment on column public.doctor.clinic_id is
  'The clinic the doctor works in. Fixed once set. A patient belongs to their '
  'doctor''s clinic.';
comment on column public.admin.clinic_id is
  'The clinic a Clinic Admin manages. Fixed once set; required of every '
  'Clinic Admin.';

-- ---------------------------------------------------------------------------
-- Which clinic
-- ---------------------------------------------------------------------------
-- The bodies migration 28 left as "none". Same shape and grants, so every
-- caller of the old versions keeps working.

-- The clinic of any account: an administrator's own, a doctor's own, or a
-- patient's doctor's. NULL for an account without a profile.
create or replace function app_private.clinic_of_user(target_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.clinic_id from public.admin a where a.user_id = target_user_id),
    (select d.clinic_id from public.doctor d where d.user_id = target_user_id),
    (select d.clinic_id
       from public.patient p
       join public.doctor d on d.doc_id = p.doc_id
      where p.user_id = target_user_id)
  );
$$;

-- The caller's clinic. A deactivated doctor is still a member - membership
-- is not access: every clinical policy separately asks for an active doctor.
create or replace function app_private.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.clinic_of_user((select auth.uid()));
$$;

-- The caller's clinic if the caller is a Clinic Admin, otherwise NULL. Every
-- Clinic Admin policy and function compares against this, so a doctor or
-- patient matches none of them.
create or replace function app_private.admin_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.clinic_id
    from public.admin a
    join public.user_account ua on ua.user_id = a.user_id
   where a.user_id = (select auth.uid())
     and ua.user_role = 'admin';
$$;

create or replace function app_private.clinic_of_doctor(target_doc_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.clinic_id from public.doctor d where d.doc_id = target_doc_id;
$$;

-- A patient's clinic is their doctor's.
create or replace function app_private.clinic_of_patient(target_pat_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.clinic_id
    from public.patient p
    join public.doctor d on d.doc_id = p.doc_id
   where p.pat_id = target_pat_id;
$$;

comment on function app_private.current_clinic_id() is
  'The caller''s clinic: their admin or doctor profile''s, or their doctor''s '
  'for a patient.';
comment on function app_private.admin_clinic_id() is
  'The caller''s clinic when the caller is a Clinic Admin; NULL for anyone '
  'else.';
comment on function app_private.clinic_of_user(uuid) is
  'The clinic of any account, through its profile. NULL without one.';

revoke all on function app_private.clinic_of_user(uuid) from public;
revoke all on function app_private.admin_clinic_id() from public;
grant execute on function app_private.clinic_of_user(uuid)
  to authenticated, service_role;
grant execute on function app_private.admin_clinic_id()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A new doctor joins the only clinic, until migration 31
-- ---------------------------------------------------------------------------
-- The create-account deployed today inserts doctors with no clinic. While the
-- single-clinic gate holds there is exactly one clinic they can belong to, so
-- that one is filled in. With none, or two, the insert is refused: guessing
-- would put a clinician, and every patient they register, in the wrong
-- clinic. Migration 31 lifts the gate and replaces this with "the clinic must
-- be given".

create or replace function public.doctor_assign_single_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  clinic_count bigint;
begin
  if new.clinic_id is null then
    select count(*) into clinic_count from public.clinic;

    if clinic_count <> 1 then
      raise exception
        'A new doctor needs a clinic, and with % clinics none can be assumed',
        clinic_count
        using errcode = 'not_null_violation';
    end if;

    select c.clinic_id into new.clinic_id from public.clinic c;
  end if;

  return new;
end;
$$;

comment on function public.doctor_assign_single_clinic() is
  'Puts a doctor inserted without a clinic in the only clinic there is, and '
  'refuses the insert when there is not exactly one. Until migration 31. Run '
  'only by the doctor_assign_single_clinic trigger.';

drop trigger if exists doctor_assign_single_clinic on public.doctor;
create trigger doctor_assign_single_clinic
  before insert on public.doctor
  for each row execute function public.doctor_assign_single_clinic();

-- ---------------------------------------------------------------------------
-- A profile's clinic is fixed, and an administrator has one
-- ---------------------------------------------------------------------------
-- For every writer, the service role included. Moving a doctor would carry
-- their whole caseload into another clinic; moving an administrator would
-- hand them another clinic's accounts. Neither has a legitimate path.

create or replace function public.profile_clinic_is_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'A % cannot be moved to another clinic', tg_argv[0]
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.profile_clinic_is_fixed() is
  'Refuses any change of a profile''s clinic_id. Argument: the profile kind, '
  'for the message. Run only by the doctor_clinic_is_fixed trigger.';

drop trigger if exists doctor_clinic_is_fixed on public.doctor;
create trigger doctor_clinic_is_fixed
  before update of clinic_id on public.doctor
  for each row execute function public.profile_clinic_is_fixed('doctor');

-- Administrators are provisioned out of band, so this is the only place
-- their clinic is required. Migration 33 lets a Super Admin's be empty.
create or replace function public.admin_guard_clinic()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.clinic_id is null then
      raise exception 'A Clinic Admin must belong to a clinic'
        using errcode = 'not_null_violation';
    end if;
  else
    if new.user_id is distinct from old.user_id then
      raise exception 'The linked account of an admin profile cannot be changed'
        using errcode = 'insufficient_privilege';
    end if;

    if new.clinic_id is distinct from old.clinic_id then
      raise exception 'An admin cannot be moved to another clinic'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.admin_guard_clinic() is
  'Requires a clinic of every new Clinic Admin, and refuses any later change '
  'of an admin profile''s account or clinic. Run only by the '
  'admin_guard_clinic trigger.';

drop trigger if exists admin_guard_clinic on public.admin;
create trigger admin_guard_clinic
  before insert or update on public.admin
  for each row execute function public.admin_guard_clinic();

-- ---------------------------------------------------------------------------
-- A patient moves only within their clinic
-- ---------------------------------------------------------------------------
-- Migration 27 already requires the new doctor to be active. This adds that
-- they work in the same clinic: a patient handed to another clinic's doctor
-- would take their whole record across with them.

create or replace function public.patient_guard_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.doc_id is distinct from old.doc_id
     and app_private.clinic_of_doctor(new.doc_id)
         is distinct from app_private.clinic_of_doctor(old.doc_id) then
    raise exception 'A patient can only be moved to a doctor in the same clinic'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.patient_guard_clinic() is
  'Refuses a change of patient.doc_id to a doctor in another clinic. Run '
  'only by the patient_reassignment_stays_in_clinic trigger.';

drop trigger if exists patient_reassignment_stays_in_clinic on public.patient;
create trigger patient_reassignment_stays_in_clinic
  before update of doc_id on public.patient
  for each row execute function public.patient_guard_clinic();

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.doctor_assign_single_clinic() from public, anon, authenticated;
revoke all on function public.profile_clinic_is_fixed() from public, anon, authenticated;
revoke all on function public.admin_guard_clinic() from public, anon, authenticated;
revoke all on function public.patient_guard_clinic() from public, anon, authenticated;
