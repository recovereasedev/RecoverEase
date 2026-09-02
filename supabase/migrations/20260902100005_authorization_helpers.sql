-- ===========================================================================
-- RecoverEase — 06. Authorization helpers
-- ===========================================================================
-- Row Level Security policies need to answer questions like "is the caller a
-- doctor, and is this patient assigned to them?". Asking that directly inside
-- a policy on `patient` would recurse: evaluating the policy requires reading
-- the table the policy protects.
--
-- The standard resolution is a SECURITY DEFINER helper, which runs with the
-- definer's privileges and therefore bypasses RLS for the lookup. That is a
-- sharp tool, so every one of these functions is constrained:
--
--   * They live in `app_private`, a schema that is NOT exposed through the
--     Data API, so none of them is reachable as a REST endpoint.
--   * EXECUTE is revoked from PUBLIC and granted only to `authenticated`.
--     PostgreSQL grants EXECUTE to PUBLIC by default on every new function,
--     which would otherwise make each of these callable by `anon`.
--   * `search_path` is pinned to empty and every reference is schema
--     qualified, so a caller cannot shadow `public` and redirect a lookup.
--   * Each one is keyed on `auth.uid()`. None accepts a caller-supplied
--     identity, so none can be asked about somebody else's permissions.
--   * All are STABLE, letting PostgreSQL evaluate them once per statement
--     rather than once per row.
-- ===========================================================================

create schema if not exists app_private;

revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

comment on schema app_private is
  'Authorization helpers for RLS policies. Deliberately excluded from the '
  'Data API exposed schemas: nothing here is a public endpoint.';

-- ---------------------------------------------------------------------------
-- Role of the current caller
-- ---------------------------------------------------------------------------
-- Authorization reads from `public.user_account`, never from JWT
-- `user_metadata`. In Supabase, `raw_user_meta_data` is writable by the user
-- it belongs to and surfaces in `auth.jwt()`, so trusting it for a role check
-- would let any patient promote themselves to admin.

create or replace function app_private.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select ua.user_role
    from public.user_account ua
   where ua.user_id = (select auth.uid());
$$;

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.user_account ua
     where ua.user_id = (select auth.uid())
       and ua.user_role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Identity of the current caller within their role table
-- ---------------------------------------------------------------------------

-- Returns NULL for a deactivated doctor. Every doctor-facing policy is
-- written against this function, so module 11.3 "Deactivate Doctor Account"
-- revokes data access at the database, not merely at the login screen.
create or replace function app_private.current_doctor_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.doc_id
    from public.doctor d
   where d.user_id = (select auth.uid())
     and d.doc_is_active;
$$;

create or replace function app_private.current_patient_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.pat_id
    from public.patient p
   where p.user_id = (select auth.uid());
$$;

create or replace function app_private.current_admin_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.admin_id
    from public.admin a
   where a.user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Relationship checks
-- ---------------------------------------------------------------------------

-- True when the caller is the active doctor assigned to `target_pat_id`.
-- This single predicate is the basis of every doctor read path in the system.
create or replace function app_private.is_my_patient(target_pat_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.patient p
      join public.doctor d on d.doc_id = p.doc_id
     where p.pat_id = target_pat_id
       and d.user_id = (select auth.uid())
       and d.doc_is_active
  );
$$;

-- True when the caller is the patient the row belongs to.
create or replace function app_private.is_own_patient_record(
  target_pat_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.patient p
     where p.pat_id = target_pat_id
       and p.user_id = (select auth.uid())
  );
$$;

-- The union used by most clinical tables: the patient themselves, or their
-- assigned doctor. Expressed once so the two halves cannot drift apart.
create or replace function app_private.can_access_patient(
  target_pat_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_own_patient_record(target_pat_id)
      or app_private.is_my_patient(target_pat_id);
$$;

-- Resolves a patient to their user account. Used by the doctor-to-patient
-- notification policy (module 7.1) to confirm that the recipient of a
-- notification is genuinely the doctor's own patient.
create or replace function app_private.is_user_my_patient(
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.patient p
      join public.doctor d on d.doc_id = p.doc_id
     where p.user_id = target_user_id
       and d.user_id = (select auth.uid())
       and d.doc_is_active
  );
$$;

-- True when `target_doc_id` is the caller's own assigned doctor. Lets a
-- patient read the one clinician record they are entitled to see, without
-- opening the doctor directory to them.
create or replace function app_private.is_my_doctor(target_doc_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.patient p
     where p.doc_id = target_doc_id
       and p.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Ownership resolvers
-- ---------------------------------------------------------------------------
-- Several tables hang off a parent rather than carrying `pat_id` themselves:
-- a goal belongs to a plan, a schedule to a prescription, a dose log to a
-- schedule. Their policies need the owning patient.
--
-- Resolving that with a plain subquery inside the policy would re-enter the
-- parent table's own RLS for every row — slow, and easy to get subtly wrong.
-- These resolvers do the lookup once, as SECURITY DEFINER, so each policy
-- reduces to `can_access_patient(patient_of_x(...))`.

create or replace function app_private.patient_of_treatment_plan(
  target_plan_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.pat_id
    from public.treatment_plan tp
   where tp.treatment_plan_id = target_plan_id;
$$;

create or replace function app_private.patient_of_prescription(
  target_prescription_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.pat_id
    from public.prescription pr
   where pr.prescription_id = target_prescription_id;
$$;

-- Two hops: schedule -> prescription -> patient.
create or replace function app_private.patient_of_medication_schedule(
  target_schedule_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.pat_id
    from public.medication_schedule ms
    join public.prescription pr
      on pr.prescription_id = ms.prescription_id
   where ms.medication_schedule_id = target_schedule_id;
$$;

create or replace function app_private.patient_of_appointment(
  target_appointment_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.pat_id
    from public.appointment a
   where a.appointment_id = target_appointment_id;
$$;

create or replace function app_private.patient_of_chat_session(
  target_session_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cs.pat_id
    from public.chat_session cs
   where cs.chat_session_id = target_session_id;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC on every newly created function.
-- Revoke that, then grant deliberately. `anon` is never granted anything:
-- an unauthenticated caller has no permissions to evaluate.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
  loop
    execute format('revoke all on function %s from public', fn.signature);
    execute format(
      'grant execute on function %s to authenticated, service_role',
      fn.signature
    );
  end loop;
end;
$$;
