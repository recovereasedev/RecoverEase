-- ===========================================================================
-- RecoverEase — 60. A care case is Active or Discharged, and its reminders are its own
-- ===========================================================================
-- Migration 57 gave a treatment plan a third state, "ready for discharge",
-- set by a daily job. That is gone: the patient's assigned doctor alone
-- decides when care ends, and alone reopens it.
--
--   active ──(the assigned doctor, with a closure reason)──▶ discharged
--   discharged ──(the assigned doctor)──▶ active
--
-- What this does:
--
--   * unschedules `recoverease-mark-plans-ready-for-discharge` and drops
--     `mark_treatment_plans_ready_for_discharge()`. No job replaces it, and
--     nothing discharges or flags a plan by itself;
--   * makes every plan that is ready for discharge active again - the doctor
--     had not discharged it. A discharged plan stays discharged. Each change
--     is kept in the lifecycle history like any other;
--   * `treatment_plan_status_valid`: the status is 'active' or 'discharged'
--     for every writer. The enum keeps its other labels (PostgreSQL cannot
--     drop one); the constraint is what refuses them;
--   * 57's functions that named "ready for discharge" are as 57 left them
--     without it;
--   * a prescription and an appointment belong to one care plan:
--     `prescription.treatment_plan_id` and `appointment.treatment_plan_id`.
--     On a new row the database fills it in with the patient's only active
--     plan; with several active plans the doctor (prescription) or whoever
--     books (appointment) must name one. A plan must be the same patient's,
--     for every writer and every change (a foreign key on (plan, patient)
--     also refuses moving a linked row, or a linked plan, to another
--     patient), and active, for a session. Once set, no session
--     changes it. An appointment booked while the patient's care has ended
--     is a follow-up request (57's mark) and belongs to no plan;
--   * existing rows are linked only where the patient has exactly one plan.
--     Rows of a patient with several plans, and follow-up requests, are left
--     on no plan: nothing is guessed. The migration says how many. They get
--     no reminders until each is placed on a plan by hand
--     (docs/deployment.md lists them, read-only);
--   * a reminder follows its own plan. The four reminder readers, each
--     exactly as 59 (medication, phone) or 53 (appointment) left it but for
--     the lines marked (60), ask `app_private.care_reminders_allowed(plan,
--     patient)`: the plan is the patient's and active. A row on no plan is
--     reminded about only while the patient has no plan at all; once the
--     patient has any plan it is silent until placed on one by hand (it
--     fails closed - another plan being active proves nothing):
--       - public.dispatch_medication_pre_dose_reminders()
--       - public.dispatch_medication_reminders(integer)
--       - public.dispatch_appointment_reminders(integer)
--       - app_private.push_source_is_current(...), so a phone reminder
--         already queued is dropped at delivery.
--     A medicine is reminded about only when its plan allows it AND the
--     doctor has its reminders on (59) AND the patient wants reminders (4.9).
--     A follow-up request is always reminded about.
--   * reopening sends nothing about the past: the follow-up job, and the
--     check before a queued phone reminder is delivered, accept only doses
--     that came due after the dose's own plan was last reopened
--     (`app_private.care_reopened_at`, read from that plan's history).
--     Each job's own "sent" mark still prevents any repeat.
--
-- It refuses, changing nothing, unless 57 and 59 are applied, and while any
-- plan is draft, completed or cancelled: no rule says what those become, and
-- none is guessed. Settle each by hand first:
--
--   select treatment_plan_id, treatment_plan_status from public.treatment_plan
--    where treatment_plan_status::text not in ('active', 'ready_for_discharge', 'discharged');
--
-- Unchanged: the discharge columns, the closure reasons, the lifecycle
-- history, who may discharge and reopen, the check-in guard's rule, the
-- follow-up mark, dose generation, the missed-dose and missed-goal jobs, every
-- other job's schedule, and every dose, log, appointment and notification.
--
-- Rollback: supabase/rollbacks/20260902100060_simplify_discharge_lifecycle.down.sql
-- ===========================================================================

do $$
begin
  -- Migration 57: the discharge functions, the history, the follow-up mark.
  if to_regprocedure('public.doctor_discharge_treatment_plan(uuid, text)') is null
     or to_regprocedure('public.doctor_reopen_treatment_plan(uuid)') is null
     or to_regclass('public.treatment_plan_lifecycle_event') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'appointment'
                       and column_name = 'appointment_follow_up_of_plan_id') then
    raise exception 'Migration 57 is not applied; apply it first. Nothing was changed.';
  end if;
  -- Migration 59: the doctor's reminder switch, which the readers below keep.
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'medication_schedule'
         and column_name in ('medication_schedule_reminders_is_enabled',
                             'medication_schedule_reminders_enabled_at')) <> 2
     or to_regprocedure('public.medication_schedule_stamp_reminders()') is null then
    raise exception 'Migration 59 is not applied; apply it first. Nothing was changed.';
  end if;
  if exists (select 1 from public.treatment_plan
              where treatment_plan_status::text in ('draft', 'completed', 'cancelled')) then
    raise exception 'Some plans are draft, completed or cancelled; settle each as active or discharged first. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- No readiness check, and no job for one
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid)
       from cron.job j
      where j.jobname = 'recoverease-mark-plans-ready-for-discharge';
  end if;
end
$$;

drop function if exists public.mark_treatment_plans_ready_for_discharge();

-- ---------------------------------------------------------------------------
-- Two statuses
-- ---------------------------------------------------------------------------
-- Flagged, never discharged: back to active. The plan's trigger keeps the
-- change in the lifecycle history.
update public.treatment_plan
   set treatment_plan_status = 'active'
 where treatment_plan_status::text = 'ready_for_discharge';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_status_valid'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_status_valid
      check (treatment_plan_status::text in ('active', 'discharged'));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Migration 57's functions, without "ready for discharge"
-- ---------------------------------------------------------------------------

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


create or replace function public.patient_complete_recovery_activity(target_activity_id uuid)
returns public.recovery_activity
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me         uuid := (select auth.uid());
  owner_id   uuid;
  plan_state public.treatment_plan_status;
  is_closed  boolean;
  activity_row public.recovery_activity;
begin
  -- Whose activity it is comes first, read without a lock, so a call from
  -- anyone else is refused before it takes one.
  select p.user_id
    into owner_id
    from public.recovery_activity a
    join public.recovery_phase ph on ph.recovery_phase_id = a.recovery_phase_id
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
    join public.patient p on p.pat_id = tp.pat_id
   where a.recovery_activity_id = target_activity_id;
  if me is null or owner_id is distinct from me then
    raise exception 'Only the patient can mark their own roadmap activity'
      using errcode = 'insufficient_privilege';
  end if;

  -- Then the activity, locked until this call ends, and everything that
  -- decides the change read again under locks: the phase and the plan are
  -- held FOR SHARE, so neither can be archived or closed until this
  -- transaction ends. Always activity, then phase and plan.
  select a.*
    into activity_row
    from public.recovery_activity a
   where a.recovery_activity_id = target_activity_id
     for update;

  select p.user_id, tp.treatment_plan_status,
         ph.recovery_phase_archived_at is not null or activity_row.recovery_activity_archived_at is not null
    into owner_id, plan_state, is_closed
    from public.recovery_phase ph
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
    join public.patient p on p.pat_id = tp.pat_id
   where ph.recovery_phase_id = activity_row.recovery_phase_id
     for share of ph, tp;

  if owner_id is distinct from me then
    raise exception 'Only the patient can mark their own roadmap activity'
      using errcode = 'insufficient_privilege';
  end if;
  if is_closed then
    raise exception 'This activity is no longer on the roadmap'
      using errcode = 'check_violation';
  end if;
  if plan_state::text <> 'active' then
    raise exception 'Activities can be marked only while the treatment plan is active'
      using errcode = 'check_violation';
  end if;
  if activity_row.recovery_activity_completed_at is not null then
    raise exception 'This activity is already marked done'
      using errcode = 'unique_violation';
  end if;

  update public.recovery_activity a
     set recovery_activity_completed_at = now(),
         recovery_activity_completed_by = me
   where a.recovery_activity_id = target_activity_id
  returning a.* into activity_row;

  insert into public.recovery_activity_event
    (recovery_activity_id, recovery_activity_event_kind, recovery_activity_event_actor)
  values (target_activity_id, 'completed', me);

  return activity_row;
end;
$$;


create or replace function public.patient_reopen_recovery_activity(target_activity_id uuid)
returns public.recovery_activity
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me         uuid := (select auth.uid());
  owner_id   uuid;
  plan_state public.treatment_plan_status;
  is_closed  boolean;
  activity_row public.recovery_activity;
begin
  -- Whose activity it is comes first, read without a lock, so a call from
  -- anyone else is refused before it takes one.
  select p.user_id
    into owner_id
    from public.recovery_activity a
    join public.recovery_phase ph on ph.recovery_phase_id = a.recovery_phase_id
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
    join public.patient p on p.pat_id = tp.pat_id
   where a.recovery_activity_id = target_activity_id;
  if me is null or owner_id is distinct from me then
    raise exception 'Only the patient can mark their own roadmap activity'
      using errcode = 'insufficient_privilege';
  end if;

  -- Then the activity, locked until this call ends, and everything that
  -- decides the change read again under locks: the phase and the plan are
  -- held FOR SHARE, so neither can be archived or closed until this
  -- transaction ends. Always activity, then phase and plan.
  select a.*
    into activity_row
    from public.recovery_activity a
   where a.recovery_activity_id = target_activity_id
     for update;

  select p.user_id, tp.treatment_plan_status,
         ph.recovery_phase_archived_at is not null or activity_row.recovery_activity_archived_at is not null
    into owner_id, plan_state, is_closed
    from public.recovery_phase ph
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
    join public.patient p on p.pat_id = tp.pat_id
   where ph.recovery_phase_id = activity_row.recovery_phase_id
     for share of ph, tp;

  if owner_id is distinct from me then
    raise exception 'Only the patient can mark their own roadmap activity'
      using errcode = 'insufficient_privilege';
  end if;
  if is_closed then
    raise exception 'This activity is no longer on the roadmap'
      using errcode = 'check_violation';
  end if;
  if plan_state::text <> 'active' then
    raise exception 'Activities can be marked only while the treatment plan is active'
      using errcode = 'check_violation';
  end if;
  if activity_row.recovery_activity_completed_at is null then
    raise exception 'This activity is not marked done'
      using errcode = 'check_violation';
  end if;

  update public.recovery_activity a
     set recovery_activity_completed_at = null,
         recovery_activity_completed_by = null
   where a.recovery_activity_id = target_activity_id
  returning a.* into activity_row;

  insert into public.recovery_activity_event
    (recovery_activity_id, recovery_activity_event_kind, recovery_activity_event_actor)
  values (target_activity_id, 'reopened', me);

  return activity_row;
end;
$$;


create or replace function public.patient_update_treatment_goal_status(
  target_goal_id uuid,
  new_status     public.treatment_goal_status
)
returns public.treatment_goal
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me         uuid := (select auth.uid());
  owner_id   uuid;
  plan_state public.treatment_plan_status;
  goal_row   public.treatment_goal;
begin
  select p.user_id
    into owner_id
    from public.treatment_goal g
    join public.treatment_plan tp on tp.treatment_plan_id = g.treatment_plan_id
    join public.patient p on p.pat_id = tp.pat_id
   where g.treatment_goal_id = target_goal_id;
  if me is null or owner_id is distinct from me then
    raise exception 'Only the patient can record progress on their own goal'
      using errcode = 'insufficient_privilege';
  end if;

  select g.*
    into goal_row
    from public.treatment_goal g
   where g.treatment_goal_id = target_goal_id
     for update;

  select p.user_id, tp.treatment_plan_status
    into owner_id, plan_state
    from public.treatment_plan tp
    join public.patient p on p.pat_id = tp.pat_id
   where tp.treatment_plan_id = goal_row.treatment_plan_id
     for share of tp;

  if owner_id is distinct from me then
    raise exception 'Only the patient can record progress on their own goal'
      using errcode = 'insufficient_privilege';
  end if;
  if plan_state::text <> 'active' then
    raise exception 'Progress can be recorded only while the treatment plan is active'
      using errcode = 'check_violation';
  end if;
  if new_status = 'missed' then
    raise exception 'A goal is marked missed only by the system, once its target date has passed'
      using errcode = 'insufficient_privilege';
  end if;
  if new_status = 'pending' then
    raise exception 'A goal cannot move back to not started'
      using errcode = 'check_violation';
  end if;
  if new_status = goal_row.treatment_goal_status then
    raise exception 'This goal is already %', replace(new_status::text, '_', ' ')
      using errcode = 'check_violation';
  end if;
  if not (goal_row.treatment_goal_status = 'pending'
          or (goal_row.treatment_goal_status in ('in_progress', 'missed') and new_status = 'achieved')) then
    raise exception 'This goal cannot move from % to %',
      replace(goal_row.treatment_goal_status::text, '_', ' '), replace(new_status::text, '_', ' ')
      using errcode = 'check_violation';
  end if;

  update public.treatment_goal g
     set treatment_goal_status = new_status
   where g.treatment_goal_id = target_goal_id
  returning g.* into goal_row;

  return goal_row;
end;
$$;


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


comment on function public.doctor_discharge_treatment_plan(uuid, text) is
  'Migrations 57 and 60: the patient''s assigned, active doctor discharges an '
  'active plan, with a closure reason. The patient''s account and records are '
  'untouched.';

-- ---------------------------------------------------------------------------
-- The care plan a prescription or appointment belongs to
-- ---------------------------------------------------------------------------

alter table public.prescription
  add column if not exists treatment_plan_id uuid
    references public.treatment_plan (treatment_plan_id) on delete set null;
alter table public.appointment
  add column if not exists treatment_plan_id uuid
    references public.treatment_plan (treatment_plan_id) on delete set null;

create index if not exists prescription_treatment_plan_idx
  on public.prescription (treatment_plan_id) where treatment_plan_id is not null;
create index if not exists appointment_treatment_plan_idx
  on public.appointment (treatment_plan_id) where treatment_plan_id is not null;

comment on column public.prescription.treatment_plan_id is
  'Migration 60: the care plan this prescription belongs to; its reminders '
  'stop while that plan is discharged. Null: issued with no active plan, or '
  'from before 60 for a patient with several plans (see docs/deployment.md).';
comment on column public.appointment.treatment_plan_id is
  'Migration 60: the care plan this appointment belongs to; its reminders '
  'stop while that plan is discharged. Null for a follow-up request '
  '(appointment_follow_up_of_plan_id), and for rows from before 60 that '
  'could not be placed.';

-- Existing rows: only where the patient has exactly one plan, so there is
-- nothing to choose between. A follow-up request belongs to no plan.
with sole_plan as (
  select tp.pat_id, (array_agg(tp.treatment_plan_id))[1] as plan_id
    from public.treatment_plan tp
   group by tp.pat_id
  having count(*) = 1
)
update public.prescription pr
   set treatment_plan_id = s.plan_id
  from sole_plan s
 where s.pat_id = pr.pat_id
   and pr.treatment_plan_id is null;

with sole_plan as (
  select tp.pat_id, (array_agg(tp.treatment_plan_id))[1] as plan_id
    from public.treatment_plan tp
   group by tp.pat_id
  having count(*) = 1
)
update public.appointment a
   set treatment_plan_id = s.plan_id
  from sole_plan s
 where s.pat_id = a.pat_id
   and a.treatment_plan_id is null
   and a.appointment_follow_up_of_plan_id is null;

do $$
declare
  prescriptions integer;
  appointments  integer;
begin
  select count(*) into prescriptions
    from public.prescription pr
   where pr.treatment_plan_id is null
     and (select count(*) from public.treatment_plan tp where tp.pat_id = pr.pat_id) > 1;
  select count(*) into appointments
    from public.appointment a
   where a.treatment_plan_id is null
     and a.appointment_follow_up_of_plan_id is null
     and (select count(*) from public.treatment_plan tp where tp.pat_id = a.pat_id) > 1;
  raise notice 'Migration 60: % prescriptions and % appointments of patients with several plans were left on no plan; they get no reminders until placed on a plan by hand.',
    prescriptions, appointments;
end
$$;

-- A link always names a plan of the row's own patient, for every writer and
-- every change, whatever the row policies let a session see: a foreign key on
-- (plan, patient). It refuses a row moved to another patient with its link
-- left as it was, and a plan given to another patient while anything is
-- linked to it. Deleting a plan clears only the link, never the patient.
-- (PostgreSQL 15 or later for the column list; production runs 17.)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_id_pat_id_key'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_id_pat_id_key unique (treatment_plan_id, pat_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prescription_treatment_plan_same_patient_fkey'
                    and conrelid = 'public.prescription'::regclass) then
    alter table public.prescription
      add constraint prescription_treatment_plan_same_patient_fkey
      foreign key (treatment_plan_id, pat_id)
      references public.treatment_plan (treatment_plan_id, pat_id)
      on delete set null (treatment_plan_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appointment_treatment_plan_same_patient_fkey'
                    and conrelid = 'public.appointment'::regclass) then
    alter table public.appointment
      add constraint appointment_treatment_plan_same_patient_fkey
      foreign key (treatment_plan_id, pat_id)
      references public.treatment_plan (treatment_plan_id, pat_id)
      on delete set null (treatment_plan_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The helpers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER with an empty search_path, and no grants: the reminder
-- functions call them, no session does.

-- Care has ended while the patient has a discharged plan and no active one
-- (the check-in guard's rule, 57). No plan at all: nothing has ended.
create or replace function app_private.patient_care_is_open(target_pat_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.treatment_plan tp
                      where tp.pat_id = target_pat_id
                        and tp.treatment_plan_status::text = 'discharged')
      or exists (select 1 from public.treatment_plan tp
                  where tp.pat_id = target_pat_id
                    and tp.treatment_plan_status::text = 'active');
$$;

-- May this row's reminders be sent? Fails closed.
--   * On a plan: only while that plan is the same patient's and active.
--   * On no plan, for a patient who has any plan: never. Nothing says which
--     plan the row belongs to (another plan being active proves nothing), so
--     it waits until it is placed on one by hand.
--   * On no plan, for a patient with no plan at all: as before 60 - there is
--     no care plan to end.
-- A follow-up request (57's mark) is not asked: the appointment readers let
-- it through on their own.
create or replace function app_private.care_reminders_allowed(target_plan_id uuid, target_pat_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_plan_id is null then
      not exists (select 1 from public.treatment_plan tp
                   where tp.pat_id = target_pat_id)
    else exists (select 1 from public.treatment_plan tp
                  where tp.treatment_plan_id = target_plan_id
                    and tp.pat_id = target_pat_id
                    and tp.treatment_plan_status::text = 'active')
  end;
$$;

-- When the plan was last reopened, from its own history; for a row on no
-- plan, any of the patient's plans. '-infinity' if never.
create or replace function app_private.care_reopened_at(target_plan_id uuid, target_pat_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(e.treatment_plan_changed_at), '-infinity'::timestamptz)
    from public.treatment_plan_lifecycle_event e
    join public.treatment_plan tp on tp.treatment_plan_id = e.treatment_plan_id
   where e.treatment_plan_previous_status::text = 'discharged'
     and e.treatment_plan_new_status::text = 'active'
     and (case when target_plan_id is null then tp.pat_id = target_pat_id
               else e.treatment_plan_id = target_plan_id end);
$$;

revoke all on function app_private.patient_care_is_open(uuid) from public, anon, authenticated;
revoke all on function app_private.care_reminders_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.care_reopened_at(uuid, uuid) from public, anon, authenticated;

comment on function app_private.care_reminders_allowed(uuid, uuid) is
  'Migration 60: true while the plan is the patient''s and active; for a row '
  'on no plan, only while the patient has no plan at all (fails closed until '
  'placed by hand). Read by the reminder jobs and the phone check.';
comment on function app_private.care_reopened_at(uuid, uuid) is
  'Migration 60: when the plan was last reopened, from its history '
  '(''-infinity'' if never). No dose due before it is chased.';

-- ---------------------------------------------------------------------------
-- Linking a new prescription or appointment to its plan
-- ---------------------------------------------------------------------------
-- Runs as the caller, after the row's own policies: only the patient's
-- doctor issues a prescription; the patient or their doctor books.

create or replace function public.prescription_link_care_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  is_session   boolean := current_user in ('authenticated', 'anon');
  plan_status  text;
  active_plans uuid[];
begin
  if tg_op = 'UPDATE' then
    if new.treatment_plan_id is distinct from old.treatment_plan_id then
      if is_session then
        raise exception 'A prescription''s care plan is set when it is issued'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    -- The link must name a plan of the row's own patient, also when the row
    -- is moved to another patient with its link left as it was. (The foreign
    -- key on (treatment_plan_id, pat_id) enforces this on every write; this
    -- says why.) Checked only when either changes: read as the caller, an
    -- unchanged link could be hidden by the row policies.
    if new.treatment_plan_id is not null
       and (new.treatment_plan_id is distinct from old.treatment_plan_id or new.pat_id is distinct from old.pat_id)
       and not exists (select 1 from public.treatment_plan tp
                        where tp.treatment_plan_id = new.treatment_plan_id and tp.pat_id = new.pat_id) then
      raise exception 'That care plan belongs to another patient'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.treatment_plan_id is not null then
    -- Read as the caller: another patient's plan is not visible, so it is refused.
    plan_status := (select tp.treatment_plan_status::text from public.treatment_plan tp
                     where tp.treatment_plan_id = new.treatment_plan_id and tp.pat_id = new.pat_id);
    if plan_status is null then
      raise exception 'That care plan belongs to another patient'
        using errcode = 'check_violation';
    end if;
    if is_session and plan_status <> 'active' then
      raise exception 'Issue a prescription under an active care plan'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- None named: the patient's only active plan, if there is exactly one. A
  -- patient with none (no plan yet, or all discharged) gets a prescription on
  -- no plan; with several, the doctor chooses.
  active_plans := array(select tp.treatment_plan_id from public.treatment_plan tp
                          where tp.pat_id = new.pat_id and tp.treatment_plan_status::text = 'active'
                          order by tp.treatment_plan_id);
  if cardinality(active_plans) = 1 then
    new.treatment_plan_id := active_plans[1];
  elsif cardinality(active_plans) > 1 and is_session then
    raise exception 'Choose which care plan this prescription belongs to'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists prescription_link_care_plan on public.prescription;
create trigger prescription_link_care_plan
  before insert or update on public.prescription
  for each row execute function public.prescription_link_care_plan();

revoke all on function public.prescription_link_care_plan() from public, anon, authenticated;

-- 57's follow-up mark, now also placing the appointment on its plan.
create or replace function public.appointment_mark_follow_up()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  is_session   boolean := current_user in ('authenticated', 'anon');
  plan_status  text;
  active_plans uuid[];
begin
  if tg_op = 'UPDATE' then
    if new.appointment_follow_up_of_plan_id is distinct from old.appointment_follow_up_of_plan_id and is_session then
      raise exception 'An appointment''s follow-up mark is set when it is booked'
        using errcode = 'insufficient_privilege';
    end if;
    if new.treatment_plan_id is distinct from old.treatment_plan_id then
      if is_session then
        raise exception 'An appointment''s care plan is set when it is booked'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    -- The link must name a plan of the row's own patient, also when the row
    -- is moved to another patient with its link left as it was. (The foreign
    -- key on (treatment_plan_id, pat_id) enforces this on every write; this
    -- says why.) Checked only when either changes: read as the caller, an
    -- unchanged link could be hidden by the row policies.
    if new.treatment_plan_id is not null
       and (new.treatment_plan_id is distinct from old.treatment_plan_id or new.pat_id is distinct from old.pat_id)
       and not exists (select 1 from public.treatment_plan tp
                        where tp.treatment_plan_id = new.treatment_plan_id and tp.pat_id = new.pat_id) then
      raise exception 'That care plan belongs to another patient'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- A plan named on booking must be this patient's, and, from a session, active.
  if new.treatment_plan_id is not null then
    -- Read as the caller: another patient's plan is not visible, so it is refused.
    plan_status := (select tp.treatment_plan_status::text from public.treatment_plan tp
                     where tp.treatment_plan_id = new.treatment_plan_id and tp.pat_id = new.pat_id);
    if plan_status is null then
      raise exception 'That care plan belongs to another patient'
        using errcode = 'check_violation';
    end if;
    if is_session and plan_status <> 'active' then
      raise exception 'Book an appointment under an active care plan'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Booked while the patient's care has ended (a discharged plan and no
  -- active one): a follow-up request, as 57 marks it.
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

  -- Otherwise it belongs to a care plan: the patient's only active one, or
  -- the one chosen when there are several.
  if new.appointment_follow_up_of_plan_id is null and new.treatment_plan_id is null then
    active_plans := array(select tp.treatment_plan_id from public.treatment_plan tp
                          where tp.pat_id = new.pat_id and tp.treatment_plan_status::text = 'active'
                          order by tp.treatment_plan_id);
    if cardinality(active_plans) = 1 then
      new.treatment_plan_id := active_plans[1];
    elsif cardinality(active_plans) > 1 and is_session then
      raise exception 'Choose which care plan this appointment belongs to'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The four reminder readers; only the lines marked (60) are new
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps each one's owner, grants and comment.

create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           c.clinic_timezone as zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join public.clinic c
        on c.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- (59) The doctor has reminders on for this medicine ...
       and ms.medication_schedule_reminders_is_enabled
       -- (59) ... and the dose came due after they were last switched back on,
       -- (59) so switching them on does not chase what came due while they were off.
       and (ms.medication_schedule_reminders_enabled_at is null
            or ml.medication_log_scheduled_at >= ms.medication_schedule_reminders_enabled_at)
       -- (60) The dose is on the patient's own care plan and that plan is active
       -- (60) (on no plan: only while the patient has no plan at all; fails closed) ...
       and app_private.care_reminders_allowed(pr.treatment_plan_id, p.pat_id)
       -- (60) ... and the dose came due after that plan was last reopened, so
       -- (60) reopening does not chase what came due while it was closed.
       and ml.medication_log_scheduled_at >= app_private.care_reopened_at(pr.treatment_plan_id, p.pat_id)
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone c.clinic_timezone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_follow_up_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- predicate against the just-updated row, and skips it — so two
       -- schedulers firing at once cannot double-notify.
       and ml.medication_log_follow_up_sent_at is null
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Have you taken your %s (%s)? It was due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_follow_up', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function public.dispatch_medication_pre_dose_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each clinic's lead time, as its settings hold it: 5, 10, 15 or 30
  -- minutes, and ten for anything else. Leading zeros and spaces around the
  -- number are read past, as the grace period's are.
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*(5|10|15|30)\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_lead_minutes'),
             10
           ) as lead_minutes
      from public.clinic c
  ),
  due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           r.zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join clinic_rule r
        on r.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already reminded. This is the duplicate guard.
       and ml.medication_log_pre_dose_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- (59) The doctor has reminders on for this medicine.
       and ms.medication_schedule_reminders_is_enabled
       -- (60) The dose is on the patient's own care plan and that plan is active
       -- (60) (on no plan: only while the patient has no plan at all; fails closed).
       and app_private.care_reminders_allowed(pr.treatment_plan_id, p.pat_id)
       -- Not yet due, and due within the clinic's lead time. The half hour is
       -- the longest lead time a clinic can set: it bounds the read of
       -- medication_log_due_idx to the next 30 minutes, where the slots run
       -- 30 days ahead, on a job that runs every minute.
       and ml.medication_log_scheduled_at > now()
       and ml.medication_log_scheduled_at <= now() + interval '30 minutes'
       and ml.medication_log_scheduled_at
           <= now() + make_interval(mins => r.lead_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone r.zone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_pre_dose_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot: a second
       -- run that overlaps this one re-reads the row it waited for and skips
       -- it, and a dose marked taken meanwhile is not reminded about.
       and ml.medication_log_pre_dose_sent_at is null
       and ml.medication_log_status = 'pending'
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Your %s (%s) is due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_pre_dose', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function public.dispatch_appointment_reminders(
  lead_hours integer default 24
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each message's date and time are in the clinic of the appointment's
  -- doctor - the patient's clinic too, since a patient only ever moves to a
  -- doctor in the same one.
  with due as (
    select a.appointment_id,
           a.appointment_date,
           c.clinic_timezone as zone,
           d.user_id as doctor_user_id,
           d.doc_appointment_reminder_is_enabled as doctor_wants_reminder,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
      join public.clinic  c on c.clinic_id = d.clinic_id
     where a.appointment_status in ('scheduled', 'confirmed')
       and a.appointment_reminder_sent_at is null
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
       -- (60) A follow-up request booked after discharge is reminded about; an
       -- (60) appointment of a plan the doctor has discharged is not, until reopened.
       and (a.appointment_follow_up_of_plan_id is not null or app_private.care_reminders_allowed(a.treatment_plan_id, a.pat_id))
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select recipient.user_id, 'appointment', recipient.message,
         'appointment_reminder', 'reminder', null, due.appointment_id
    from due
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          -- The doctor's, unless they have turned their reminders off.
          due.doctor_wants_reminder,
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          -- The patient's, always.
          true,
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(is_sent, user_id, message)
   where recipient.is_sent;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function app_private.push_source_is_current(
  source_event  text,
  medication_log_id uuid,
  appointment_id uuid,
  due_at        timestamptz,
  owner         uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when source_event in ('medication_pre_dose', 'medication_follow_up') then exists (
      select 1
        from public.medication_log ml
        join public.medication_schedule ms on ms.medication_schedule_id = ml.medication_schedule_id
        join public.prescription pr on pr.prescription_id = ms.prescription_id
        join public.patient p on p.pat_id = pr.pat_id
       where ml.medication_log_id = push_source_is_current.medication_log_id
         and p.user_id = owner
         -- Not yet recorded (taken, skipped or missed) ...
         and ml.medication_log_status = 'pending'
         -- ... still the dose it was about, not one moved to another time ...
         and ml.medication_log_scheduled_at = due_at
         -- ... within the course's dates ...
         and ml.medication_log_dose_date >= ms.medication_schedule_start_date
         and (ms.medication_schedule_end_date is null
              or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
         -- ... and the patient still wants medication reminders.
         and p.pat_reminder_is_enabled
         -- (59) ... and the doctor has reminders on for this medicine.
         and ms.medication_schedule_reminders_is_enabled
         -- (60) ... and the dose's care plan is active ...
         and app_private.care_reminders_allowed(pr.treatment_plan_id, p.pat_id)
         -- (60) ... and the dose came due after that plan was last reopened.
         and ml.medication_log_scheduled_at >= app_private.care_reopened_at(pr.treatment_plan_id, p.pat_id)
         -- A "due soon" reminder is pointless half an hour after the dose.
         and (push_source_is_current.source_event = 'medication_follow_up'
              or now() <= ml.medication_log_scheduled_at + interval '30 minutes')
    )
    when source_event = 'appointment_reminder' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status in ('scheduled', 'confirmed')
         -- An approved reschedule moves appointment_date: the old reminder
         -- is about a time that no longer exists.
         and a.appointment_date = due_at
         and a.appointment_date > now()
         -- (60) A follow-up request, or an appointment whose care plan is active.
         and (a.appointment_follow_up_of_plan_id is not null or app_private.care_reminders_allowed(a.treatment_plan_id, a.pat_id))
    )
    when source_event = 'appointment_cancellation' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status = 'cancelled'
    )
    else false
  end
$$;


-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
