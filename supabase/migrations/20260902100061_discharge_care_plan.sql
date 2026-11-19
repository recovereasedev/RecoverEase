-- ===========================================================================
-- RecoverEase — 61. Discharge a care plan, and reopen it
-- ===========================================================================
-- A standalone release on top of migration 53. It needs nothing from
-- migrations 54-60, which are not in this release (supabase/pending and
-- supabase/superseded say why).
--
-- A treatment plan is the patient's care case, and it is Active or
-- Discharged. The patient's assigned, active doctor alone moves it:
--
--   active ──(the assigned doctor, with a closure reason)──▶ discharged
--   discharged ──(the assigned doctor)──▶ active
--
-- Nothing here deletes or rewrites a patient, an account or a record. A
-- discharged patient keeps their profile, history, prescriptions, doses,
-- appointments and messages, and can still book an appointment.
--
-- New:
--
--   * enum value `discharged`; `treatment_plan_status_valid` lets a plan be
--     only 'active' or 'discharged' (the enum keeps migration 1's other
--     labels - PostgreSQL cannot drop one - and the constraint refuses them);
--   * `treatment_plan_closure_reason` (completed_recovery | transferred |
--     withdrew | lost_to_follow_up | referred) and
--     `treatment_plan_discharged_at`, set together exactly while a plan is
--     discharged, cleared on reopening;
--   * `treatment_plan_lifecycle_event`: every status change from 61 on -
--     previous, new, reason, who, source (doctor | service), when.
--     Append-only; written only by the plan's trigger;
--   * `doctor_discharge_treatment_plan()` / `doctor_reopen_treatment_plan()`:
--     the only way a session discharges or reopens;
--     `treatment_plan_guard_lifecycle` refuses every other session write of
--     the status into or out of 'discharged', and of the two columns;
--   * `recovery_log_guard_care_ended`: no new or changed daily check-in while
--     the patient's care has ended (a discharged plan and no active one);
--   * `appointment.appointment_follow_up_of_plan_id`: set by the database
--     when a patient whose care has ended books, so the doctor sees a
--     follow-up after discharge.
--
-- Already true at 53 and unchanged: a patient marks a roadmap activity only
-- while its plan is 'active' (migration 45), so a discharged plan's
-- activities are closed; and only the doctor writes goals.
--
-- Not changed, on purpose: medication and appointment reminders. Schema 53
-- does not record which care plan a prescription or appointment belongs to,
-- so reminders cannot tell a discharged plan's medicine from a long-term one
-- and are left exactly as they are. docs/deployment.md says what the doctor
-- does at discharge.
--
-- Values added to an enum cannot be used in the transaction that adds them,
-- so nothing below compares with 'discharged' outside a plpgsql body (read
-- at run time) or a cast to text.
--
-- It refuses, changing nothing, while any plan is draft, completed or
-- cancelled (production had none on 2026-11-19): no rule says what those
-- become, and none is guessed.
--
-- Rollback: supabase/rollbacks/20260902100061_discharge_care_plan.down.sql
-- ===========================================================================

do $$
begin
  if exists (select 1 from public.treatment_plan
              where treatment_plan_status::text not in ('active', 'discharged')) then
    raise exception 'Some plans are draft, completed or cancelled; settle each as active first. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

alter type public.treatment_plan_status add value if not exists 'discharged' after 'active';

-- ---------------------------------------------------------------------------
-- Two statuses, and why and when a plan was discharged
-- ---------------------------------------------------------------------------

-- One statement, so the table is locked once.
alter table public.treatment_plan
  add column if not exists treatment_plan_closure_reason text,
  add column if not exists treatment_plan_discharged_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_status_valid'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_status_valid
      check (treatment_plan_status::text in ('active', 'discharged'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_closure_reason_valid'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_closure_reason_valid
      check (treatment_plan_closure_reason in
             ('completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred'));
  end if;
  -- A discharge always has its reason and time, and only a discharge has.
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_discharge_complete'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_discharge_complete
      check (
        (treatment_plan_status::text = 'discharged')
        = (treatment_plan_closure_reason is not null and treatment_plan_discharged_at is not null)
        and (treatment_plan_closure_reason is null) = (treatment_plan_discharged_at is null)
      );
  end if;
end
$$;

comment on column public.treatment_plan.treatment_plan_closure_reason is
  'Migration 61: why the doctor discharged the plan, while it is discharged; '
  'cleared on reopening (the lifecycle history keeps it).';
comment on column public.treatment_plan.treatment_plan_discharged_at is
  'Migration 61: when the plan was discharged, while it is; cleared on reopening.';

-- ---------------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------------

create table if not exists public.treatment_plan_lifecycle_event (
  treatment_plan_lifecycle_event_id uuid primary key default gen_random_uuid(),
  treatment_plan_id                 uuid not null
                                      references public.treatment_plan (treatment_plan_id)
                                      on delete cascade,
  treatment_plan_previous_status    public.treatment_plan_status,
  treatment_plan_new_status         public.treatment_plan_status not null,
  -- The reason, on a discharge only.
  treatment_plan_closure_reason     text,
  -- Null where no signed-in user made the change (the service role).
  treatment_plan_changed_by         uuid
                                      references public.user_account (user_id)
                                      on delete set null,
  treatment_plan_change_source      text not null,
  treatment_plan_changed_at         timestamptz not null default now(),

  constraint treatment_plan_change_source_valid
    check (treatment_plan_change_source in ('doctor', 'service'))
);

create index if not exists treatment_plan_lifecycle_event_plan_idx
  on public.treatment_plan_lifecycle_event (treatment_plan_id, treatment_plan_changed_at);
create index if not exists treatment_plan_lifecycle_event_changed_by_idx
  on public.treatment_plan_lifecycle_event (treatment_plan_changed_by)
  where treatment_plan_changed_by is not null;

comment on table public.treatment_plan_lifecycle_event is
  'Migration 61: every change of a treatment plan''s status from 61 on - '
  'previous, new, reason, who, source and when. Append-only; written only by '
  'the plan''s trigger. Changes before 61 were not recorded; none is invented.';

alter table public.treatment_plan_lifecycle_event enable row level security;
revoke insert, update, delete, truncate on public.treatment_plan_lifecycle_event from anon, authenticated;

drop policy if exists treatment_plan_lifecycle_event_select on public.treatment_plan_lifecycle_event;
create policy treatment_plan_lifecycle_event_select
  on public.treatment_plan_lifecycle_event for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )));

-- Every status change, kept, as its owner. 'doctor' when a signed-in user
-- made it (only the doctor's two functions can change it from a session);
-- 'service' when no one is signed in (the service role, the SQL editor).
create or replace function public.treatment_plan_record_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if new.treatment_plan_status is distinct from old.treatment_plan_status then
    insert into public.treatment_plan_lifecycle_event
      (treatment_plan_id, treatment_plan_previous_status, treatment_plan_new_status,
       treatment_plan_closure_reason, treatment_plan_changed_by, treatment_plan_change_source)
    values (
      new.treatment_plan_id,
      old.treatment_plan_status,
      new.treatment_plan_status,
      case when new.treatment_plan_status::text = 'discharged' then new.treatment_plan_closure_reason end,
      actor,
      case when actor is not null then 'doctor' else 'service' end
    );
  end if;
  return null;
end;
$$;

drop trigger if exists treatment_plan_record_lifecycle on public.treatment_plan;
create trigger treatment_plan_record_lifecycle
  after update of treatment_plan_status on public.treatment_plan
  for each row execute function public.treatment_plan_record_lifecycle();

-- ---------------------------------------------------------------------------
-- No session moves a plan into or out of a discharge directly
-- ---------------------------------------------------------------------------
-- Runs as the caller. The doctor's two functions run as their owner and
-- pass; everything else signed in goes through them.
create or replace function public.treatment_plan_guard_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.treatment_plan_status::text = 'discharged'
       or new.treatment_plan_closure_reason is not null
       or new.treatment_plan_discharged_at is not null then
      raise exception 'A plan is discharged only through Discharge patient'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.treatment_plan_status is distinct from old.treatment_plan_status
      and (old.treatment_plan_status::text = 'discharged'
           or new.treatment_plan_status::text = 'discharged'))
     or new.treatment_plan_closure_reason is distinct from old.treatment_plan_closure_reason
     or new.treatment_plan_discharged_at is distinct from old.treatment_plan_discharged_at then
    raise exception 'A plan''s discharge lifecycle changes only through Discharge patient and Reopen case'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists treatment_plan_guard_lifecycle on public.treatment_plan;
create trigger treatment_plan_guard_lifecycle
  before insert or update on public.treatment_plan
  for each row execute function public.treatment_plan_guard_lifecycle();

-- Trigger functions are not part of the Data API (migration 10).
revoke all on function public.treatment_plan_record_lifecycle() from public, anon, authenticated;
revoke all on function public.treatment_plan_guard_lifecycle() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The doctor discharges, or reopens
-- ---------------------------------------------------------------------------
-- Who may comes first, before any lock, in the same words for a plan that is
-- someone else's or does not exist; then the plan is locked FOR UPDATE, so a
-- second press waits, sees the first, and is refused.

create or replace function public.doctor_discharge_treatment_plan(
  target_plan_id uuid,
  closure_reason text
)
returns public.treatment_plan
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  plan_row public.treatment_plan;
begin
  if not coalesce((select app_private.is_my_patient((select app_private.patient_of_treatment_plan(target_plan_id)))), false) then
    raise exception 'Only the patient''s assigned doctor can discharge this plan'
      using errcode = 'insufficient_privilege';
  end if;
  if closure_reason is null
     or closure_reason not in ('completed_recovery', 'transferred', 'withdrew', 'lost_to_follow_up', 'referred') then
    raise exception 'Choose a closure reason for the discharge'
      using errcode = 'check_violation';
  end if;

  select tp.* into plan_row
    from public.treatment_plan tp
   where tp.treatment_plan_id = target_plan_id
     for update;
  if plan_row.treatment_plan_status::text <> 'active' then
    raise exception 'You can discharge only an active plan'
      using errcode = 'check_violation';
  end if;

  update public.treatment_plan tp
     set treatment_plan_status = 'discharged',
         treatment_plan_closure_reason = closure_reason,
         treatment_plan_discharged_at = now()
   where tp.treatment_plan_id = target_plan_id
  returning tp.* into plan_row;
  return plan_row;
end;
$$;

create or replace function public.doctor_reopen_treatment_plan(target_plan_id uuid)
returns public.treatment_plan
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  plan_row public.treatment_plan;
begin
  if not coalesce((select app_private.is_my_patient((select app_private.patient_of_treatment_plan(target_plan_id)))), false) then
    raise exception 'Only the patient''s assigned doctor can reopen this plan'
      using errcode = 'insufficient_privilege';
  end if;

  select tp.* into plan_row
    from public.treatment_plan tp
   where tp.treatment_plan_id = target_plan_id
     for update;
  if plan_row.treatment_plan_status::text <> 'discharged' then
    raise exception 'You can reopen only a discharged plan'
      using errcode = 'check_violation';
  end if;

  update public.treatment_plan tp
     set treatment_plan_status = 'active',
         treatment_plan_closure_reason = null,
         treatment_plan_discharged_at = null
   where tp.treatment_plan_id = target_plan_id
  returning tp.* into plan_row;
  return plan_row;
end;
$$;

revoke all on function public.doctor_discharge_treatment_plan(uuid, text) from public, anon;
revoke all on function public.doctor_reopen_treatment_plan(uuid) from public, anon;
grant execute on function public.doctor_discharge_treatment_plan(uuid, text) to authenticated;
grant execute on function public.doctor_reopen_treatment_plan(uuid) to authenticated;

comment on function public.doctor_discharge_treatment_plan(uuid, text) is
  'Migration 61: the patient''s assigned, active doctor discharges an active '
  'plan, with a closure reason. The patient''s account and records are untouched.';
comment on function public.doctor_reopen_treatment_plan(uuid) is
  'Migration 61: the patient''s assigned, active doctor reopens a discharged '
  'plan; the discharge stays in the plan''s lifecycle history.';

-- ---------------------------------------------------------------------------
-- No daily check-in once care has ended
-- ---------------------------------------------------------------------------
-- `recovery_log` belongs to the patient, not a plan, and nothing records
-- which plan a check-in was for, so none is guessed. The rule: a patient may
-- not add or change a check-in while they have a discharged plan and no
-- active one. A patient with no plans is unaffected. Runs as the caller, who
-- reads their own plans.
create or replace function public.recovery_log_guard_care_ended()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if exists (select 1 from public.treatment_plan tp
              where tp.pat_id = new.pat_id
                and tp.treatment_plan_status::text = 'discharged')
     and not exists (select 1 from public.treatment_plan tp
                      where tp.pat_id = new.pat_id
                        and tp.treatment_plan_status::text = 'active') then
    raise exception 'Your care plan has ended. Book a follow-up if you need more care.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists recovery_log_guard_care_ended on public.recovery_log;
create trigger recovery_log_guard_care_ended
  before insert or update on public.recovery_log
  for each row execute function public.recovery_log_guard_care_ended();

revoke all on function public.recovery_log_guard_care_ended() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A follow-up booked after discharge
-- ---------------------------------------------------------------------------
-- Set by the database when the appointment is made, never by a session: the
-- patient's most recently discharged plan, if their care has ended at that
-- moment (a discharged plan and no active one). The doctor's appointment
-- list shows it as a follow-up after discharge. Booking itself is unchanged.

alter table public.appointment
  add column if not exists appointment_follow_up_of_plan_id uuid
    references public.treatment_plan (treatment_plan_id) on delete set null;

create index if not exists appointment_follow_up_of_plan_idx
  on public.appointment (appointment_follow_up_of_plan_id)
  where appointment_follow_up_of_plan_id is not null;

comment on column public.appointment.appointment_follow_up_of_plan_id is
  'Migration 61: the discharged plan this appointment follows up, set by the '
  'database when the patient booked it after their care ended; null otherwise.';

create or replace function public.appointment_mark_follow_up()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.appointment_follow_up_of_plan_id := (
      select tp.treatment_plan_id
        from public.treatment_plan tp
       where tp.pat_id = new.pat_id
         and tp.treatment_plan_status::text = 'discharged'
         and not exists (select 1 from public.treatment_plan open_plan
                          where open_plan.pat_id = new.pat_id
                            and open_plan.treatment_plan_status::text = 'active')
       order by tp.treatment_plan_discharged_at desc, tp.treatment_plan_id
       limit 1
    );
    return new;
  end if;
  if new.appointment_follow_up_of_plan_id is distinct from old.appointment_follow_up_of_plan_id
     and current_user in ('authenticated', 'anon') then
    raise exception 'An appointment''s follow-up mark is set when it is booked'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists appointment_mark_follow_up on public.appointment;
create trigger appointment_mark_follow_up
  before insert or update on public.appointment
  for each row execute function public.appointment_mark_follow_up();

revoke all on function public.appointment_mark_follow_up() from public, anon, authenticated;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
