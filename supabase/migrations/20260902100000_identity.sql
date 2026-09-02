-- ===========================================================================
-- RecoverEase — 01. Identity
-- ===========================================================================
-- Implements the ERD entities: userAccount, doctor, admin, patient.
--
-- Deviations from the ERD, each deliberate and documented in
-- docs/database.md:
--
--   * `userAccount.userPasswordHash` is NOT implemented. Supabase Auth owns
--     credentials in `auth.users`. Keeping a second password store beside it
--     would create a real breach surface and two sources of truth.
--     `user_account.user_id` is therefore the same value as `auth.users.id`.
--
--   * Surrogate keys are `uuid`, not `int`. Sequential integers in a system
--     holding patient data are enumerable: they leak record counts and invite
--     IDOR probing of `/patients/1`, `/patients/2`. Entities, attributes and
--     relationships are otherwise exactly as drawn.
--
--   * Identifiers are snake_case. Unquoted identifiers in PostgreSQL fold to
--     lower case, so `patFirstName` would silently become `patfirstname`.
--     The ERD's attribute prefixes (`pat_`, `doc_`, `admin_`) are preserved
--     so the mapping back to the diagram stays one-to-one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
-- The ERD types every status column as `varchar` without listing the allowed
-- values. Each enum below is derived from the module specification; the
-- reasoning for each value set is recorded in docs/database.md.

create type public.user_role as enum ('patient', 'doctor', 'admin');

-- Module 11.3 is "Deactivate / Reactivate Doctor Account", and the ERD gives
-- `patStatus` to patients. Patients are never deleted, only moved out of
-- active care.
create type public.patient_status as enum ('active', 'inactive', 'discharged');

-- ---------------------------------------------------------------------------
-- Shared trigger function: maintain an updated-at column
-- ---------------------------------------------------------------------------
-- The ERD prefixes every column with its entity name, so the timestamp column
-- is `user_updated_at` on one table and `treatment_plan_updated_at` on
-- another. Rather than write a near-identical trigger function per table, the
-- target column is passed as a trigger argument.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_nargs <> 1 then
    raise exception
      'set_updated_at() requires the updated-at column name as its argument';
  end if;

  new := jsonb_populate_record(
    new,
    jsonb_build_object(tg_argv[0], now())
  );
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger. Pass the updated-at column name as the '
  'single trigger argument, e.g. execute function set_updated_at(''user_updated_at'').';

-- ---------------------------------------------------------------------------
-- userAccount
-- ---------------------------------------------------------------------------
-- One row per authenticated principal. `user_email` is mirrored from
-- auth.users by trigger so that application queries and RLS policies never
-- need to read the protected `auth` schema.

create table public.user_account (
  user_id         uuid primary key
                    references auth.users (id) on delete cascade,
  user_email      text not null,
  user_role       public.user_role not null,
  user_created_at timestamptz not null default now(),
  user_updated_at timestamptz not null default now(),

  constraint user_account_email_lowercase
    check (user_email = lower(user_email))
);

create unique index user_account_email_key
  on public.user_account (user_email);

-- Listing users by role is the admin's primary access pattern.
create index user_account_role_idx
  on public.user_account (user_role);

comment on table public.user_account is
  'ERD: userAccount. Profile row keyed by auth.users.id. Credentials live in '
  'Supabase Auth; userPasswordHash from the ERD is intentionally absent.';

create trigger user_account_set_updated_at
  before update on public.user_account
  for each row execute function public.set_updated_at('user_updated_at');

-- ---------------------------------------------------------------------------
-- doctor
-- ---------------------------------------------------------------------------

create table public.doctor (
  doc_id             uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique
                       references public.user_account (user_id)
                       on delete cascade,
  doc_first_name     text not null,
  doc_last_name      text not null,
  doc_specialization text,
  doc_license_no     text not null,
  doc_contact_no     text,
  doc_is_active      boolean not null default true,
  doc_created_at     timestamptz not null default now(),

  constraint doctor_first_name_not_blank check (btrim(doc_first_name) <> ''),
  constraint doctor_last_name_not_blank  check (btrim(doc_last_name) <> ''),
  constraint doctor_license_not_blank    check (btrim(doc_license_no) <> '')
);

-- A licence number identifies a real practitioner; duplicates indicate a
-- data-entry error or an impersonation attempt.
create unique index doctor_license_no_key
  on public.doctor (doc_license_no);

-- Module 11.1 "View Doctor List" filters on active status.
create index doctor_is_active_idx
  on public.doctor (doc_is_active);

comment on table public.doctor is
  'ERD: doctor. Created by an administrator (module 2.1 Register Doctor '
  'Account). Deactivated rather than deleted (module 11.3).';

-- ---------------------------------------------------------------------------
-- admin
-- ---------------------------------------------------------------------------

create table public.admin (
  admin_id         uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique
                     references public.user_account (user_id)
                     on delete cascade,
  admin_first_name text not null,
  admin_last_name  text not null,
  admin_created_at timestamptz not null default now(),

  constraint admin_first_name_not_blank check (btrim(admin_first_name) <> ''),
  constraint admin_last_name_not_blank  check (btrim(admin_last_name) <> '')
);

comment on table public.admin is
  'ERD: admin. Administrators are provisioned out of band, never through the '
  'application, because no module grants anyone the ability to create one.';

-- ---------------------------------------------------------------------------
-- patient
-- ---------------------------------------------------------------------------
-- `doc_id` is NOT NULL: module 2.2 makes a doctor the creator of every
-- patient account, and Row Level Security uses this column to decide which
-- doctor may read the record. A patient with no doctor would be invisible to
-- every clinician in the system, so the database refuses to store one.
--
-- The reference is ON DELETE RESTRICT because doctors are deactivated rather
-- than deleted (module 11.3); losing the link would orphan patient records.

create table public.patient (
  pat_id                     uuid primary key default gen_random_uuid(),
  user_id                    uuid not null unique
                               references public.user_account (user_id)
                               on delete cascade,
  doc_id                     uuid not null
                               references public.doctor (doc_id)
                               on delete restrict,
  pat_first_name             text not null,
  pat_last_name              text not null,
  pat_birth_date             date,
  pat_gender                 text,
  pat_contact_no             text,
  pat_address                text,
  -- Module 1.5 "Capture Data Privacy Consent". NULL means consent has not yet
  -- been given; the application blocks the patient at a consent gate until it
  -- is set.
  pat_consent_at             timestamptz,
  pat_created_at             timestamptz not null default now(),
  pat_status                 public.patient_status not null default 'active',
  -- Module 4.9 "Configure Medication Reminder Preferences".
  pat_reminder_preferred_time time,
  pat_reminder_is_enabled     boolean not null default true,

  constraint patient_first_name_not_blank check (btrim(pat_first_name) <> ''),
  constraint patient_last_name_not_blank  check (btrim(pat_last_name) <> '')
);

-- A birth date in the future, or one implying an age beyond recorded human
-- lifespan, is a typo rather than a real value. This is a trigger and not a
-- CHECK constraint because `current_date` is STABLE, and PostgreSQL only
-- permits IMMUTABLE expressions inside CHECK.
create or replace function public.patient_validate_birth_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pat_birth_date is null then
    return new;
  end if;

  if new.pat_birth_date > current_date then
    raise exception 'Date of birth cannot be in the future'
      using errcode = 'check_violation';
  end if;

  if new.pat_birth_date <= current_date - interval '130 years' then
    raise exception 'Date of birth is implausibly early'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger patient_check_birth_date
  before insert or update of pat_birth_date on public.patient
  for each row execute function public.patient_validate_birth_date();

-- The single most frequent query in the system: "my patients", run on every
-- doctor page load and evaluated inside almost every RLS policy.
create index patient_doc_id_idx
  on public.patient (doc_id);

create index patient_status_idx
  on public.patient (pat_status);

comment on table public.patient is
  'ERD: patient. Assigned to exactly one doctor via doc_id, which is the '
  'basis of every doctor-facing Row Level Security policy.';

comment on column public.patient.pat_consent_at is
  'Module 1.5. NULL until the patient accepts the data privacy notice on '
  'first sign-in.';
