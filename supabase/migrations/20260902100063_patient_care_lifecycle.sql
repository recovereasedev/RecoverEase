-- ===========================================================================
-- RecoverEase — 63. A patient's care: In Care or Discharged, by the doctor
-- ===========================================================================
-- The clinic's rule: THE DOCTOR MANUALLY DISCHARGES THE PATIENT. A patient's
-- care never depends on a treatment plan existing or not, a plan's dates, its
-- goals, its roadmap, an appointment, a date or any scheduled job. Only the
-- patient's assigned, active doctor moves it, by pressing a button:
--
--   in_care ──(the assigned doctor, with a closure reason)──▶ discharged
--   discharged ──(the assigned doctor)──▶ in_care
--
-- Three statuses, kept apart:
--
--   * account status  - `patient.pat_status` (migration 0): whether the
--                       patient can use their account. Never changed here.
--   * care status     - NEW, `patient.pat_care_status`: whether the patient
--                       is in the clinic's care. The source of truth for
--                       everything below.
--   * plan status     - `treatment_plan.treatment_plan_status` (61): one
--                       plan's own Active/Discharged. Never changed here, and
--                       never read to decide a patient's care.
--
-- New:
--
--   * `patient.pat_care_status` ('in_care' | 'discharged', default in_care),
--     `pat_care_closure_reason` and `pat_care_discharged_at`, set together
--     exactly while discharged, cleared on reopening. Every existing patient
--     is In Care: nothing is inferred from their plans.
--   * `patient_care_event`: every care change - previous, new, reason, who
--     (account and doctor), source (doctor | service), when. Append-only;
--     written only by the patient row's trigger.
--   * `doctor_discharge_patient_care()` / `doctor_reopen_patient_care()`: the
--     only way a session moves a patient's care. `patient_guard_care` refuses
--     every other session write of the three columns.
--   * Read-only care: while a patient is discharged, no signed-in person -
--     doctor, patient or administrator, directly or through any function -
--     adds, changes or deletes the patient's treatment plans, goals, roadmap
--     phases or roadmap activities, or adds or changes a daily check-in.
--     Everything stays readable. Clinical notes, prescriptions, medicines,
--     doses, appointments and messages are untouched.
--   * Follow-ups: `appointment.appointment_follow_up_of_care_event_id`, set
--     by the database when a discharged patient books - the discharge event
--     their care is in. A composite foreign key keeps it on an event of the
--     appointment's own patient. 61's plan mark stays on the rows that have
--     it and is no longer set: a follow-up is now after a patient's
--     discharge, not a plan's.
--
-- 61 is kept: its plan-level functions, history, columns, keys and marks
-- stay as they are. Its check-in guard and follow-up trigger are redefined
-- to read the patient's care, not their plans.
--
-- Reminders are unchanged on discharge (as in 61): the doctor ends medicines
-- or switches their reminders off (migration 67) as part of discharging.
--
-- Rollback: supabase/rollbacks/20260902100063_patient_care_lifecycle.down.sql
-- ===========================================================================

set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- The patient's care
-- ---------------------------------------------------------------------------

-- One statement, so the table is locked once. A constant default is not a
-- rewrite: every existing patient reads in_care without being touched.
alter table public.patient
  add column if not exists pat_care_status         text not null default 'in_care',
  add column if not exists pat_care_closure_reason text,
  add column if not exists pat_care_discharged_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'patient_care_status_valid'
                    and conrelid = 'public.patient'::regclass) then
    alter table public.patient
      add constraint patient_care_status_valid
      check (pat_care_status in ('in_care', 'discharged'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'patient_care_closure_reason_valid'
                    and conrelid = 'public.patient'::regclass) then
    alter table public.patient
      add constraint patient_care_closure_reason_valid
      check (pat_care_closure_reason in
             ('completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred'));
  end if;
  -- A discharge always has its reason and time, and only a discharge has.
  if not exists (select 1 from pg_constraint where conname = 'patient_care_discharge_complete'
                    and conrelid = 'public.patient'::regclass) then
    alter table public.patient
      add constraint patient_care_discharge_complete
      check (
        (pat_care_status = 'discharged')
        = (pat_care_closure_reason is not null and pat_care_discharged_at is not null)
        and (pat_care_closure_reason is null) = (pat_care_discharged_at is null)
      );
  end if;
end
$$;

comment on column public.patient.pat_care_status is
  'Migration 63: in_care or discharged - whether the patient is in the '
  'clinic''s care. Changed only by the assigned doctor''s Discharge patient '
  'and Reopen case. Independent of pat_status (the account) and of every '
  'treatment plan''s status.';
comment on column public.patient.pat_care_closure_reason is
  'Migration 63: why the doctor discharged the patient, while discharged; '
  'cleared on reopening (patient_care_event keeps it).';
comment on column public.patient.pat_care_discharged_at is
  'Migration 63: when the doctor discharged the patient, while discharged; '
  'cleared on reopening.';

-- ---------------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------------

create table if not exists public.patient_care_event (
  patient_care_event_id        uuid primary key default gen_random_uuid(),
  pat_id                       uuid not null
                                 references public.patient (pat_id)
                                 on delete cascade,
  patient_care_previous_status text not null,
  patient_care_new_status      text not null,
  -- The reason, on a discharge only.
  patient_care_closure_reason  text,
  -- Null where no signed-in user made the change (the service role).
  patient_care_changed_by      uuid
                                 references public.user_account (user_id)
                                 on delete set null,
  -- The doctor who pressed the button, when it was a doctor.
  patient_care_changed_by_doc_id uuid
                                 references public.doctor (doc_id)
                                 on delete set null,
  patient_care_change_source   text not null,
  patient_care_changed_at      timestamptz not null default now(),

  constraint patient_care_event_statuses_valid
    check (patient_care_previous_status in ('in_care', 'discharged')
           and patient_care_new_status in ('in_care', 'discharged')
           and patient_care_previous_status <> patient_care_new_status),
  constraint patient_care_event_reason_valid
    check ((patient_care_new_status = 'discharged') = (patient_care_closure_reason is not null)
           and (patient_care_closure_reason is null or patient_care_closure_reason in
                ('completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred'))),
  constraint patient_care_change_source_valid
    check (patient_care_change_source in ('doctor', 'service')),
  -- What an appointment's follow-up key needs: an event of a given patient.
  constraint patient_care_event_id_pat_id_key unique (patient_care_event_id, pat_id)
);

create index if not exists patient_care_event_patient_idx
  on public.patient_care_event (pat_id, patient_care_changed_at);
create index if not exists patient_care_event_changed_by_idx
  on public.patient_care_event (patient_care_changed_by)
  where patient_care_changed_by is not null;
create index if not exists patient_care_event_changed_by_doc_idx
  on public.patient_care_event (patient_care_changed_by_doc_id)
  where patient_care_changed_by_doc_id is not null;

comment on table public.patient_care_event is
  'Migration 63: every change of a patient''s care status - previous, new, '
  'reason, who, source and when. Append-only; written only by the patient '
  'row''s trigger. Nothing before 63 is invented.';

alter table public.patient_care_event enable row level security;
revoke insert, update, delete, truncate on public.patient_care_event from anon, authenticated;

drop policy if exists patient_care_event_select on public.patient_care_event;
create policy patient_care_event_select
  on public.patient_care_event for select to authenticated
  using ((select app_private.can_access_patient(pat_id)));

-- Append-only for every writer: an event is never rewritten. (Deleting the
-- patient removes their events with them.)
create or replace function public.patient_care_event_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A care history event cannot be changed'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists patient_care_event_append_only on public.patient_care_event;
create trigger patient_care_event_append_only
  before update on public.patient_care_event
  for each row execute function public.patient_care_event_append_only();

-- Every care change, kept, as its owner.
create or replace function public.patient_record_care_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if new.pat_care_status is distinct from old.pat_care_status then
    insert into public.patient_care_event
      (pat_id, patient_care_previous_status, patient_care_new_status,
       patient_care_closure_reason, patient_care_changed_by,
       patient_care_changed_by_doc_id, patient_care_change_source)
    values (
      new.pat_id,
      old.pat_care_status,
      new.pat_care_status,
      case when new.pat_care_status = 'discharged' then new.pat_care_closure_reason end,
      actor,
      (select d.doc_id from public.doctor d where d.user_id = actor),
      case when actor is not null then 'doctor' else 'service' end
    );
  end if;
  return null;
end;
$$;

drop trigger if exists patient_record_care_event on public.patient;
create trigger patient_record_care_event
  after update of pat_care_status on public.patient
  for each row execute function public.patient_record_care_event();

-- ---------------------------------------------------------------------------
-- No session moves a patient's care directly
-- ---------------------------------------------------------------------------
-- Runs as the caller. The doctor's two functions run as their owner and pass;
-- a patient, a doctor or an administrator updating the row directly is
-- refused. A new patient starts In Care.
create or replace function public.patient_guard_care()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.pat_care_status <> 'in_care'
       or new.pat_care_closure_reason is not null
       or new.pat_care_discharged_at is not null then
      raise exception 'A new patient starts in care'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.pat_care_status is distinct from old.pat_care_status
     or new.pat_care_closure_reason is distinct from old.pat_care_closure_reason
     or new.pat_care_discharged_at is distinct from old.pat_care_discharged_at then
    raise exception 'A patient''s care changes only through Discharge patient and Reopen case'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists patient_guard_care on public.patient;
create trigger patient_guard_care
  before insert or update on public.patient
  for each row execute function public.patient_guard_care();

revoke all on function public.patient_care_event_append_only() from public, anon, authenticated;
revoke all on function public.patient_record_care_event() from public, anon, authenticated;
revoke all on function public.patient_guard_care() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the rest of the schema reads
-- ---------------------------------------------------------------------------

-- Whether a patient's care has ended. Locks the patient row FOR SHARE when
-- asked, so a write that checks it and a discharge cannot cross: whichever
-- comes second sees the first.
create or replace function app_private.patient_care_is_discharged(target_pat_id uuid, hold boolean default false)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  care text;
begin
  if hold then
    select p.pat_care_status into care
      from public.patient p where p.pat_id = target_pat_id
       for share;
  else
    select p.pat_care_status into care
      from public.patient p where p.pat_id = target_pat_id;
  end if;
  return coalesce(care = 'discharged', false);
end;
$$;

-- The discharge event a discharged patient's care is in: the latest one.
-- Null while the patient is in care.
create or replace function app_private.patient_current_discharge_event(target_pat_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.patient_care_event_id
    from public.patient p
    join public.patient_care_event e on e.pat_id = p.pat_id
   where p.pat_id = target_pat_id
     and p.pat_care_status = 'discharged'
     and e.patient_care_new_status = 'discharged'
   order by e.patient_care_changed_at desc, e.patient_care_event_id desc
   limit 1;
$$;

revoke all on function app_private.patient_care_is_discharged(uuid, boolean) from public, anon;
revoke all on function app_private.patient_current_discharge_event(uuid) from public, anon;
grant execute on function app_private.patient_care_is_discharged(uuid, boolean) to authenticated, service_role;
grant execute on function app_private.patient_current_discharge_event(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The doctor discharges, or reopens
-- ---------------------------------------------------------------------------
-- Who may comes first, before any lock, in the same words for a patient who
-- is someone else's or does not exist: the assigned doctor, active
-- (`is_my_patient`). A patient, another doctor, a deactivated doctor, a
-- Clinic Admin and a visitor are refused. Then the patient row is locked FOR
-- UPDATE, so a second press waits, sees the first, and is refused. Nothing
-- else is touched: not the account, not a plan, a medicine or an appointment.

create or replace function public.doctor_discharge_patient_care(
  target_pat_id uuid,
  closure_reason text
)
returns public.patient
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  patient_row public.patient;
begin
  if not coalesce((select app_private.is_my_patient(target_pat_id)), false) then
    raise exception 'Only the patient''s assigned doctor can discharge this patient'
      using errcode = 'insufficient_privilege';
  end if;
  if closure_reason is null
     or closure_reason not in ('completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred') then
    raise exception 'Choose a closure reason for the discharge'
      using errcode = 'check_violation';
  end if;

  select p.* into patient_row
    from public.patient p
   where p.pat_id = target_pat_id
     for update;
  if patient_row.pat_care_status <> 'in_care' then
    raise exception 'This patient is already discharged'
      using errcode = 'check_violation';
  end if;

  update public.patient p
     set pat_care_status = 'discharged',
         pat_care_closure_reason = closure_reason,
         pat_care_discharged_at = now()
   where p.pat_id = target_pat_id
  returning p.* into patient_row;
  return patient_row;
end;
$$;

create or replace function public.doctor_reopen_patient_care(target_pat_id uuid)
returns public.patient
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  patient_row public.patient;
begin
  if not coalesce((select app_private.is_my_patient(target_pat_id)), false) then
    raise exception 'Only the patient''s assigned doctor can reopen this patient''s care'
      using errcode = 'insufficient_privilege';
  end if;

  select p.* into patient_row
    from public.patient p
   where p.pat_id = target_pat_id
     for update;
  if patient_row.pat_care_status <> 'discharged' then
    raise exception 'This patient is already in care'
      using errcode = 'check_violation';
  end if;

  update public.patient p
     set pat_care_status = 'in_care',
         pat_care_closure_reason = null,
         pat_care_discharged_at = null
   where p.pat_id = target_pat_id
  returning p.* into patient_row;
  return patient_row;
end;
$$;

revoke all on function public.doctor_discharge_patient_care(uuid, text) from public, anon;
revoke all on function public.doctor_reopen_patient_care(uuid) from public, anon;
grant execute on function public.doctor_discharge_patient_care(uuid, text) to authenticated;
grant execute on function public.doctor_reopen_patient_care(uuid) to authenticated;

comment on function public.doctor_discharge_patient_care(uuid, text) is
  'Migration 63: the patient''s assigned, active doctor discharges the '
  'patient from care, with a closure reason. The account, plans, medicines '
  'and appointments are untouched.';
comment on function public.doctor_reopen_patient_care(uuid) is
  'Migration 63: the patient''s assigned, active doctor reopens a discharged '
  'patient''s care; the discharge stays in patient_care_event.';

-- ---------------------------------------------------------------------------
-- Care records are read-only while the patient is discharged
-- ---------------------------------------------------------------------------
-- Any change made by a signed-in person - directly, or through any function,
-- the patient's and the doctor's own included - to the patient's treatment
-- plans, goals, roadmap phases and activities is refused while their care is
-- discharged. The service role and the database's jobs (no one signed in)
-- are not stopped here; each job says itself what it skips. Deleting the
-- patient deletes their records with them (the patient row is gone first).
-- Reading is never affected.

create or replace function public.care_record_guard_discharged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  target_patient uuid;
begin
  if (select auth.uid()) is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  target_patient := case tg_table_name
    when 'treatment_plan' then (row_data ->> 'pat_id')::uuid
    when 'treatment_goal' then app_private.patient_of_treatment_plan((row_data ->> 'treatment_plan_id')::uuid)
    when 'recovery_phase' then app_private.patient_of_treatment_plan((row_data ->> 'treatment_plan_id')::uuid)
    when 'recovery_activity' then app_private.patient_of_recovery_phase((row_data ->> 'recovery_phase_id')::uuid)
  end;

  if target_patient is not null and app_private.patient_care_is_discharged(target_patient, true) then
    raise exception 'This patient''s care has ended. Their care records are read-only until the doctor reopens the case.'
      using errcode = 'check_violation';
  end if;
  -- A plan moved to another patient: that patient must be in care too.
  if tg_op = 'UPDATE' and tg_table_name = 'treatment_plan'
     and (to_jsonb(old) ->> 'pat_id') is distinct from (row_data ->> 'pat_id')
     and app_private.patient_care_is_discharged((to_jsonb(old) ->> 'pat_id')::uuid, true) then
    raise exception 'This patient''s care has ended. Their care records are read-only until the doctor reopens the case.'
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.care_record_guard_discharged() from public, anon, authenticated;

drop trigger if exists treatment_plan_guard_care_ended on public.treatment_plan;
create trigger treatment_plan_guard_care_ended
  before insert or update or delete on public.treatment_plan
  for each row execute function public.care_record_guard_discharged();

drop trigger if exists treatment_goal_guard_care_ended on public.treatment_goal;
create trigger treatment_goal_guard_care_ended
  before insert or update or delete on public.treatment_goal
  for each row execute function public.care_record_guard_discharged();

drop trigger if exists recovery_phase_guard_care_ended on public.recovery_phase;
create trigger recovery_phase_guard_care_ended
  before insert or update or delete on public.recovery_phase
  for each row execute function public.care_record_guard_discharged();

drop trigger if exists recovery_activity_guard_care_ended on public.recovery_activity;
create trigger recovery_activity_guard_care_ended
  before insert or update or delete on public.recovery_activity
  for each row execute function public.care_record_guard_discharged();

-- ---------------------------------------------------------------------------
-- No daily check-in while discharged (61's guard, now on the patient's care)
-- ---------------------------------------------------------------------------
-- Same name and trigger as 61; it now reads the patient's care, not their
-- plans. A patient with no plan, an expired plan or a discharged plan who is
-- in care checks in as usual. Past check-ins stay readable.
create or replace function public.recovery_log_guard_care_ended()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (select app_private.patient_care_is_discharged(new.pat_id, true)) then
    raise exception 'Your care has ended. Book a follow-up if you need more care.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- A follow-up booked after the patient's discharge
-- ---------------------------------------------------------------------------

alter table public.appointment
  add column if not exists appointment_follow_up_of_care_event_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'appointment_follow_up_care_same_patient_fkey'
                    and conrelid = 'public.appointment'::regclass) then
    alter table public.appointment
      add constraint appointment_follow_up_care_same_patient_fkey
      foreign key (appointment_follow_up_of_care_event_id, pat_id)
      references public.patient_care_event (patient_care_event_id, pat_id)
      on delete set null (appointment_follow_up_of_care_event_id);
  end if;
end
$$;

create index if not exists appointment_follow_up_of_care_event_idx
  on public.appointment (appointment_follow_up_of_care_event_id)
  where appointment_follow_up_of_care_event_id is not null;

comment on column public.appointment.appointment_follow_up_of_care_event_id is
  'Migration 63: the patient''s discharge (patient_care_event) this '
  'appointment follows up, set by the database when a discharged patient '
  'booked it; null otherwise. Kept after the care is reopened.';
comment on column public.appointment.appointment_follow_up_of_plan_id is
  'Migration 61: the discharged plan this appointment follows up. Set on '
  'bookings before migration 63 and kept; from 63 a follow-up is marked '
  'with appointment_follow_up_of_care_event_id instead.';

-- Same name and trigger as 61. A booking takes the patient's current
-- discharge event, whatever plans they have or not; neither mark is a
-- session's to set or change.
create or replace function public.appointment_mark_follow_up()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.appointment_follow_up_of_plan_id := null;
    new.appointment_follow_up_of_care_event_id :=
      (select app_private.patient_current_discharge_event(new.pat_id));
    return new;
  end if;
  if (new.appointment_follow_up_of_plan_id is distinct from old.appointment_follow_up_of_plan_id
      or new.appointment_follow_up_of_care_event_id is distinct from old.appointment_follow_up_of_care_event_id)
     and current_user in ('authenticated', 'anon') then
    raise exception 'An appointment''s follow-up mark is set when it is booked'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

reset lock_timeout;
