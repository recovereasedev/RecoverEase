-- ===========================================================================
-- RecoverEase — 02. Clinical records
-- ===========================================================================
-- ERD entities: treatmentPlan, treatmentGoal, prescription,
-- medicationSchedule, medicationLog, recoveryLog, doctorNote.
-- ===========================================================================

create type public.treatment_plan_status as enum
  ('draft', 'active', 'completed', 'cancelled');

create type public.treatment_goal_status as enum
  ('pending', 'in_progress', 'achieved', 'missed');

-- Module 4.6 "Mark Medication as Taken" and 4.8 "View Weekly Adherence
-- Tracking" require a per-dose outcome, not just a boolean.
create type public.medication_log_status as enum
  ('pending', 'taken', 'missed', 'skipped');

-- ---------------------------------------------------------------------------
-- treatmentPlan
-- ---------------------------------------------------------------------------

create table public.treatment_plan (
  treatment_plan_id          uuid primary key default gen_random_uuid(),
  pat_id                     uuid not null
                               references public.patient (pat_id)
                               on delete cascade,
  doc_id                     uuid not null
                               references public.doctor (doc_id)
                               on delete restrict,
  treatment_plan_title       text not null,
  treatment_plan_description text,
  treatment_plan_start_date  date not null default current_date,
  treatment_plan_end_date    date,
  treatment_plan_status      public.treatment_plan_status
                               not null default 'active',
  treatment_plan_created_at  timestamptz not null default now(),
  treatment_plan_updated_at  timestamptz not null default now(),

  constraint treatment_plan_title_not_blank
    check (btrim(treatment_plan_title) <> ''),
  constraint treatment_plan_dates_ordered
    check (
      treatment_plan_end_date is null
      or treatment_plan_end_date >= treatment_plan_start_date
    )
);

create index treatment_plan_pat_id_idx
  on public.treatment_plan (pat_id, treatment_plan_start_date desc);

create trigger treatment_plan_set_updated_at
  before update on public.treatment_plan
  for each row
  execute function public.set_updated_at('treatment_plan_updated_at');

comment on table public.treatment_plan is
  'ERD: treatmentPlan. Authored by the assigned doctor (modules 3.1, 3.2); '
  'readable by that doctor and by the patient (module 3.4).';

-- ---------------------------------------------------------------------------
-- treatmentGoal
-- ---------------------------------------------------------------------------
-- ADDITION: `treatment_goal_created_at` is not in the ERD. Without it there
-- is no stable sort key for a goal list — uuid ordering is arbitrary and
-- target_date is nullable — so goals would reorder between page loads.

create table public.treatment_goal (
  treatment_goal_id          uuid primary key default gen_random_uuid(),
  treatment_plan_id          uuid not null
                               references public.treatment_plan
                                 (treatment_plan_id)
                               on delete cascade,
  treatment_goal_description text not null,
  treatment_goal_target_date date,
  treatment_goal_status      public.treatment_goal_status
                               not null default 'pending',
  treatment_goal_created_at  timestamptz not null default now(),

  constraint treatment_goal_description_not_blank
    check (btrim(treatment_goal_description) <> '')
);

create index treatment_goal_plan_id_idx
  on public.treatment_goal (treatment_plan_id, treatment_goal_created_at);

comment on table public.treatment_goal is
  'ERD: treatmentGoal. Defined by the doctor (module 3.3), visible to the '
  'patient (module 5.8 View Treatment Goals).';

-- ---------------------------------------------------------------------------
-- prescription
-- ---------------------------------------------------------------------------

create table public.prescription (
  prescription_id           uuid primary key default gen_random_uuid(),
  pat_id                    uuid not null
                              references public.patient (pat_id)
                              on delete cascade,
  doc_id                    uuid not null
                              references public.doctor (doc_id)
                              on delete restrict,
  prescription_issued_date  date not null default current_date,
  prescription_notes        text,
  prescription_created_at   timestamptz not null default now()
);

create index prescription_pat_id_idx
  on public.prescription (pat_id, prescription_issued_date desc);

comment on table public.prescription is
  'ERD: prescription. Issued by the assigned doctor (module 4.3). The system '
  'records and tracks prescriptions; it does not generate clinical advice.';

-- ---------------------------------------------------------------------------
-- medicationSchedule
-- ---------------------------------------------------------------------------
-- REFINEMENT: the ERD types `medicationScheduleTimes` as varchar, which in
-- practice means a delimited string such as '08:00,20:00'. It is stored here
-- as `time[]` instead: the same information, correctly typed, parseable
-- without string splitting, and checkable against the frequency column. A
-- schedule claiming three doses a day but listing two times is a data error
-- the database can now reject outright.
--
-- ADDITION: `medication_schedule_created_at`, for stable list ordering.

create table public.medication_schedule (
  medication_schedule_id         uuid primary key default gen_random_uuid(),
  prescription_id                uuid not null
                                   references public.prescription
                                     (prescription_id)
                                   on delete cascade,
  medication_schedule_name       text not null,
  medication_schedule_dosage     text not null,
  medication_schedule_frequency  integer not null,
  medication_schedule_times      time[] not null,
  medication_schedule_start_date date not null default current_date,
  medication_schedule_end_date   date,
  medication_schedule_created_at timestamptz not null default now(),

  constraint medication_schedule_name_not_blank
    check (btrim(medication_schedule_name) <> ''),
  constraint medication_schedule_dosage_not_blank
    check (btrim(medication_schedule_dosage) <> ''),
  constraint medication_schedule_frequency_sane
    check (medication_schedule_frequency between 1 and 12),
  constraint medication_schedule_times_match_frequency
    check (
      cardinality(medication_schedule_times)
        = medication_schedule_frequency
    ),
  constraint medication_schedule_dates_ordered
    check (
      medication_schedule_end_date is null
      or medication_schedule_end_date >= medication_schedule_start_date
    )
);

create index medication_schedule_prescription_id_idx
  on public.medication_schedule (prescription_id);

-- Dose-slot generation scans for schedules that are live on a given date.
create index medication_schedule_active_window_idx
  on public.medication_schedule
     (medication_schedule_start_date, medication_schedule_end_date);

comment on table public.medication_schedule is
  'ERD: medicationSchedule. Set by the doctor (module 4.1). '
  'medicationScheduleTimes is stored as time[] rather than a delimited '
  'string so it can be validated against the frequency.';

-- ---------------------------------------------------------------------------
-- medicationLog
-- ---------------------------------------------------------------------------
-- One row per scheduled dose. Rows are generated from the schedule (see
-- migration 06), then updated by the patient when a dose is taken.
--
-- The unique constraint makes slot generation idempotent: running the
-- generator twice cannot produce duplicate doses.

create table public.medication_log (
  medication_log_id             uuid primary key default gen_random_uuid(),
  medication_schedule_id        uuid not null
                                  references public.medication_schedule
                                    (medication_schedule_id)
                                  on delete cascade,
  medication_log_scheduled_at   timestamptz not null,
  medication_log_taken_at       timestamptz,
  medication_log_status         public.medication_log_status
                                  not null default 'pending',
  -- Module 4.2 "Configure Automated Medication Reminders": stamped when a
  -- follow-up reminder has been dispatched, so it is never sent twice.
  medication_log_follow_up_sent_at timestamptz,

  constraint medication_log_taken_requires_timestamp
    check (
      (medication_log_status = 'taken')
        = (medication_log_taken_at is not null)
    )
);

create unique index medication_log_slot_key
  on public.medication_log
     (medication_schedule_id, medication_log_scheduled_at);

-- "What is due today" and "weekly adherence" both scan by time then status.
create index medication_log_due_idx
  on public.medication_log
     (medication_log_scheduled_at, medication_log_status);

comment on table public.medication_log is
  'ERD: medicationLog. One row per scheduled dose. Patients update the '
  'status (module 4.6); doctors read it for adherence (module 5.3) but may '
  'not alter it — an adherence record the clinician can edit is worthless.';

-- ---------------------------------------------------------------------------
-- recoveryLog
-- ---------------------------------------------------------------------------
-- Module 5.9 is "Log Daily Recovery Progress" and 5.12 is "View Recovery
-- Streak", so entries are one-per-day: the unique constraint is what makes a
-- streak calculable and unambiguous.
--
-- ASSUMPTION: `recoveryLogMoodRating` is typed `int` in the ERD with no range
-- given. A 1-5 scale is used, documented in docs/database.md.

create table public.recovery_log (
  recovery_log_id          uuid primary key default gen_random_uuid(),
  pat_id                   uuid not null
                             references public.patient (pat_id)
                             on delete cascade,
  recovery_log_date        date not null default current_date,
  recovery_log_notes       text,
  recovery_log_mood_rating integer,
  recovery_log_created_at  timestamptz not null default now(),

  constraint recovery_log_mood_rating_range
    check (
      recovery_log_mood_rating is null
      or recovery_log_mood_rating between 1 and 5
    )
);

-- A recovery entry dated in the future is always an error. Enforced by
-- trigger rather than CHECK because `current_date` is STABLE and PostgreSQL
-- only permits IMMUTABLE expressions inside a CHECK constraint.
create or replace function public.recovery_log_validate_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recovery_log_date > current_date then
    raise exception 'A recovery log cannot be dated in the future'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger recovery_log_check_date
  before insert or update of recovery_log_date on public.recovery_log
  for each row execute function public.recovery_log_validate_date();

create unique index recovery_log_patient_day_key
  on public.recovery_log (pat_id, recovery_log_date);

-- Trend charts (5.11) and the streak (5.12) read a date-descending window.
create index recovery_log_pat_date_idx
  on public.recovery_log (pat_id, recovery_log_date desc);

comment on table public.recovery_log is
  'ERD: recoveryLog. One entry per patient per day (modules 5.9, 5.12). '
  'Written by the patient; readable by the assigned doctor (module 5.1).';

-- ---------------------------------------------------------------------------
-- doctorNote
-- ---------------------------------------------------------------------------
-- Clinical notes. Modules 5.4 "Add Doctor's Notes" and 5.5 "View Doctor's
-- Notes History" are both doctor-only; no patient module grants access to
-- them. Row Level Security enforces that in migration 05 — patients cannot
-- read this table at all.

create table public.doctor_note (
  doctor_note_id         uuid primary key default gen_random_uuid(),
  pat_id                 uuid not null
                           references public.patient (pat_id)
                           on delete cascade,
  doc_id                 uuid not null
                           references public.doctor (doc_id)
                           on delete restrict,
  doctor_note_text       text not null,
  doctor_note_created_at timestamptz not null default now(),

  constraint doctor_note_text_not_blank check (btrim(doctor_note_text) <> '')
);

create index doctor_note_pat_id_idx
  on public.doctor_note (pat_id, doctor_note_created_at desc);

comment on table public.doctor_note is
  'ERD: doctorNote. Doctor-only in both directions: no module grants a '
  'patient access, so no patient SELECT policy exists.';
