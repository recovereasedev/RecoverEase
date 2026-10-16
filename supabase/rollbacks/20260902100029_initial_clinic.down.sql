-- ===========================================================================
-- Rollback of migration 29 (initial_clinic)
-- ===========================================================================
-- Not a migration: nothing applies this automatically. Should 29 ever need
-- undoing, this is applied as a new migration with apply_migration, after
-- review and approval - never by repairing or deleting history. Only after
-- migration 30's rollback, which builds on this. It returns the schema to
-- exactly what migration 28 left, which tests/db/clinic-rollback.test.ts
-- checks catalog entry by catalog entry.
--
-- No clinical row is touched; every id and link stays. The clinic is
-- removed, and so is every profile's place in it. The audit entries written
-- by 29 stay, as history.
-- ===========================================================================

drop trigger if exists doctor_assign_single_clinic on public.doctor;
drop trigger if exists doctor_clinic_is_fixed on public.doctor;
drop trigger if exists admin_guard_clinic on public.admin;
drop trigger if exists patient_reassignment_stays_in_clinic on public.patient;
drop function if exists public.doctor_assign_single_clinic();
drop function if exists public.profile_clinic_is_fixed();
drop function if exists public.admin_guard_clinic();
drop function if exists public.patient_guard_clinic();

-- The helpers answer "none" again: migration 28's text.

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

drop function if exists app_private.admin_clinic_id();
drop function if exists app_private.clinic_of_user(uuid);

alter table public.doctor drop column if exists clinic_id;
alter table public.admin drop column if exists clinic_id;

delete from public.clinic;
