-- ===========================================================================
-- RecoverEase — 57. Discharge a treatment case, and reopen it
-- ===========================================================================
-- A treatment plan is the patient's care case. Its lifecycle, on the
-- existing `treatment_plan_status` (no second status column):
--
--   active ──(daily check, the system)──▶ ready_for_discharge
--   active | ready_for_discharge ──(the assigned doctor, with a reason)──▶ discharged
--   discharged ──(the assigned doctor)──▶ active
--
-- `draft`, `completed` and `cancelled` keep their meaning; no existing row is
-- changed. Nothing here touches a patient, an account, or any record: a
-- discharged patient keeps their profile, history and appointment booking.
--
-- New:
--
--   * enum values `ready_for_discharge` and `discharged`;
--   * `treatment_plan_closure_reason` (completed_recovery | transferred |
--     withdrew | lost_to_follow_up | referred) and
--     `treatment_plan_discharged_at`, set together exactly while a plan is
--     discharged, cleared on reopening;
--   * `treatment_plan_lifecycle_event`: every status change from 57 on -
--     previous, new, reason, who, source (doctor | system | service), when.
--     Append-only; written only by the plan's trigger;
--   * `doctor_discharge_treatment_plan()` / `doctor_reopen_treatment_plan()`:
--     the assigned, active doctor's only way to discharge or reopen;
--     `treatment_plan_guard_lifecycle` refuses every other session write of
--     those statuses or columns;
--   * `mark_treatment_plans_ready_for_discharge()`: the daily job, service
--     role only. It flags, notifies the doctor, and never discharges;
--   * `recovery_log_guard_care_ended`: no new or changed daily check-in
--     while the patient's care has ended (a discharged plan and no open one);
--   * `appointment.appointment_follow_up_of_plan_id`: set by the database
--     when a patient whose care has ended books, so the doctor sees a
--     follow-up after discharge;
--   * the patient's activity and goal functions accept a plan ready for
--     discharge; the missed-goal job skips discharged plans.
--
-- Values added to an enum cannot be used in the transaction that adds them,
-- so nothing below compares with them outside a plpgsql body (read at run
-- time) or a cast to text.
--
-- Rollback: supabase/rollbacks/20260902100057_discharge_reopen_treatment_case.down.sql
-- ===========================================================================

set lock_timeout = '3s';

alter type public.treatment_plan_status add value if not exists 'ready_for_discharge' after 'active';
alter type public.treatment_plan_status add value if not exists 'discharged' after 'ready_for_discharge';

-- ---------------------------------------------------------------------------
-- Why and when a plan was discharged
-- ---------------------------------------------------------------------------

alter table public.treatment_plan
  add column if not exists treatment_plan_closure_reason text,
  add column if not exists treatment_plan_discharged_at  timestamptz;

do $$
begin
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
  'Migration 57: why the doctor discharged the plan, while it is discharged; '
  'cleared on reopening (the lifecycle history keeps it).';
comment on column public.treatment_plan.treatment_plan_discharged_at is
  'Migration 57: when the plan was discharged, while it is; cleared on reopening.';

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
  -- Null where no signed-in user made the change (the job, the service role).
  treatment_plan_changed_by         uuid
                                      references public.user_account (user_id)
                                      on delete set null,
  treatment_plan_change_source      text not null,
  treatment_plan_changed_at         timestamptz not null default now(),

  constraint treatment_plan_change_source_valid
    check (treatment_plan_change_source in ('doctor', 'system', 'service'))
);

create index if not exists treatment_plan_lifecycle_event_plan_idx
  on public.treatment_plan_lifecycle_event (treatment_plan_id, treatment_plan_changed_at);
create index if not exists treatment_plan_lifecycle_event_changed_by_idx
  on public.treatment_plan_lifecycle_event (treatment_plan_changed_by)
  where treatment_plan_changed_by is not null;

comment on table public.treatment_plan_lifecycle_event is
  'Migration 57: every change of a treatment plan''s status from 57 on - '
  'previous, new, reason, who, source and when. Append-only; written only by '
  'the plan''s trigger. Changes before 57 were not recorded; none is invented.';

alter table public.treatment_plan_lifecycle_event enable row level security;
revoke insert, update, delete, truncate on public.treatment_plan_lifecycle_event from anon, authenticated;

drop policy if exists treatment_plan_lifecycle_event_select on public.treatment_plan_lifecycle_event;
create policy treatment_plan_lifecycle_event_select
  on public.treatment_plan_lifecycle_event for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )));

-- Every status change, kept, as its owner. 'doctor' when a signed-in user
-- made it (only a doctor can change a plan's status); 'system' only when no
-- one is signed in and the readiness job set its transaction-local flag.
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
      case
        when actor is not null then 'doctor'
        when current_setting('recoverease.plan_status_source', true) = 'system' then 'system'
        else 'service'
      end
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
-- No session moves a plan into, out of, or around a discharge directly
-- ---------------------------------------------------------------------------
-- Runs as the caller. The doctor's two functions and the job run as their
-- owner and pass; everything else signed in goes through them.
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
    if new.treatment_plan_status::text in ('ready_for_discharge', 'discharged')
       or new.treatment_plan_closure_reason is not null
       or new.treatment_plan_discharged_at is not null then
      raise exception 'A plan is discharged only through Discharge patient'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.treatment_plan_status is distinct from old.treatment_plan_status
      and (old.treatment_plan_status::text in ('ready_for_discharge', 'discharged')
           or new.treatment_plan_status::text in ('ready_for_discharge', 'discharged')))
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

revoke all on function public.treatment_plan_record_lifecycle() from public, anon, authenticated;
revoke all on function public.treatment_plan_guard_lifecycle() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The doctor discharges, or reopens
-- ---------------------------------------------------------------------------
-- As `patient_update_treatment_goal_status` (55): who may comes first, before
-- any lock, in the same words for a plan that is someone else's or does not
-- exist; then the plan is locked FOR UPDATE, so a discharge and the daily job
-- or a second press cannot cross - the second sees the first and is refused.

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
  if plan_row.treatment_plan_status::text not in ('active', 'ready_for_discharge') then
    raise exception 'You can discharge only an active plan or one ready for discharge'
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
  'Migration 57: the patient''s assigned, active doctor discharges an active '
  'plan or one ready for discharge, with a closure reason. The patient''s '
  'account and records are untouched.';
comment on function public.doctor_reopen_treatment_plan(uuid) is
  'Migration 57: the patient''s assigned, active doctor reopens a discharged '
  'plan; the discharge stays in the plan''s lifecycle history.';

-- ---------------------------------------------------------------------------
-- Care stays open while a plan is ready for discharge
-- ---------------------------------------------------------------------------
-- Migrations 45 and 55's patient functions, with one change each: a plan
-- ready for discharge is still open care, so its patient may still mark
-- activities and record goal progress until the doctor discharges it.

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
  if plan_state::text not in ('active', 'ready_for_discharge') then
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
  if plan_state::text not in ('active', 'ready_for_discharge') then
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

revoke all on function public.patient_complete_recovery_activity(uuid) from public, anon;
revoke all on function public.patient_reopen_recovery_activity(uuid) from public, anon;
grant execute on function public.patient_complete_recovery_activity(uuid) to authenticated;
grant execute on function public.patient_reopen_recovery_activity(uuid) to authenticated;

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
  if plan_state::text not in ('active', 'ready_for_discharge') then
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

-- Migration 55's missed-goal job, with one change: a discharged plan's goals
-- are left as they were. Reopened, the plan's goals are checked again.
create or replace function public.mark_missed_treatment_goals()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  perform set_config('recoverease.goal_status_source', 'system', true);

  update public.treatment_goal g
     set treatment_goal_status = 'missed'
    from public.treatment_plan tp
    join public.patient p on p.pat_id = tp.pat_id
    join public.doctor d on d.doc_id = p.doc_id
    join public.clinic c on c.clinic_id = d.clinic_id
   where tp.treatment_plan_id = g.treatment_plan_id
     and tp.treatment_plan_status::text <> 'discharged'
     and g.treatment_goal_status in ('pending', 'in_progress')
     and g.treatment_goal_target_date is not null
     and g.treatment_goal_target_date < (now() at time zone c.clinic_timezone)::date;

  get diagnostics changed = row_count;
  perform set_config('recoverease.goal_status_source', '', true);
  return changed;
exception
  when others then
    raise exception 'RecoverEase: the missed-goal check failed (SQLSTATE %)', sqlstate
      using errcode = sqlstate;
end;
$$;

revoke all on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) from public, anon;
grant execute on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) to authenticated;
revoke all on function public.mark_missed_treatment_goals() from public, anon, authenticated;
grant execute on function public.mark_missed_treatment_goals() to service_role;

-- ---------------------------------------------------------------------------
-- The daily readiness check
-- ---------------------------------------------------------------------------
-- An active plan becomes ready for discharge when either:
--
--   * its end date is before today in its clinic's time zone (patient ->
--     doctor -> clinic, as the missed-goal job); a plan ending today is not
--     yet past; or
--   * it has at least one goal and every one of them is achieved - a plan
--     with no goals is never "all achieved", and a pending, in-progress or
--     missed goal is not achieved. Roadmap activities are not counted: the
--     schema has no "required" activity, so none is a milestone.
--
-- One statement, under READ COMMITTED: a plan the doctor discharges at the
-- same moment is waited for and re-checked, and stays discharged. The same
-- statement's rows each give the patient's assigned doctor one notification,
-- so a second run - finding nothing active and eligible - writes no event
-- and no notification. A plan whose patient's assigned doctor is deactivated
-- is left active and no one is told (no other recipient is invented): the
-- first run after the patient has an active doctor flags it and tells them.
-- It never sets `discharged`. A failure is raised with
-- its SQLSTATE alone, with no patient or clinical text, and nothing is kept.

create or replace function public.mark_treatment_plans_ready_for_discharge()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  perform set_config('recoverease.plan_status_source', 'system', true);

  with flagged as (
    update public.treatment_plan tp
       set treatment_plan_status = 'ready_for_discharge'
      from public.patient p
      join public.doctor d on d.doc_id = p.doc_id
      join public.clinic c on c.clinic_id = d.clinic_id
     where p.pat_id = tp.pat_id
       and tp.treatment_plan_status = 'active'
       -- A deactivated doctor can neither review nor discharge: the plan
       -- waits, unflagged and unannounced, until the patient has an active one.
       and d.doc_is_active
       and (
         (tp.treatment_plan_end_date is not null
          and tp.treatment_plan_end_date < (now() at time zone c.clinic_timezone)::date)
         or (exists (select 1 from public.treatment_goal g
                      where g.treatment_plan_id = tp.treatment_plan_id)
             and not exists (select 1 from public.treatment_goal g
                              where g.treatment_plan_id = tp.treatment_plan_id
                                and g.treatment_goal_status <> 'achieved'))
       )
    returning tp.treatment_plan_title, d.user_id as doctor_user_id, p.pat_first_name, p.pat_last_name
  )
  insert into public.notification (user_id, notification_type, notification_message)
  select f.doctor_user_id,
         'treatment',
         format('%s %s''s care plan "%s" is ready for discharge review.',
                f.pat_first_name, f.pat_last_name, f.treatment_plan_title)
    from flagged f;

  get diagnostics changed = row_count;
  perform set_config('recoverease.plan_status_source', '', true);
  return changed;
exception
  when others then
    raise exception 'RecoverEase: the ready-for-discharge check failed (SQLSTATE %)', sqlstate
      using errcode = sqlstate;
end;
$$;

revoke all on function public.mark_treatment_plans_ready_for_discharge() from public, anon, authenticated;
grant execute on function public.mark_treatment_plans_ready_for_discharge() to service_role;

comment on function public.mark_treatment_plans_ready_for_discharge() is
  'Migration 57: flags active plans ready for discharge (end date past in the '
  'clinic''s time zone, or every goal achieved) and tells the assigned '
  'doctor. Never discharges. Daily by pg_cron; service role only. Idempotent.';

-- ---------------------------------------------------------------------------
-- No daily check-in once care has ended
-- ---------------------------------------------------------------------------
-- `recovery_log` belongs to the patient, not a plan, and nothing records
-- which plan a check-in was for, so none is guessed. The rule: a patient may
-- not add or change a check-in while they have a discharged plan and no open
-- one (active or ready for discharge). With an open plan the check-in is that
-- care's; a patient with no plans, or only completed or cancelled ones from
-- before 57, is unaffected. Runs as the caller, who reads their own plans.
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
                        and tp.treatment_plan_status::text in ('active', 'ready_for_discharge')) then
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
-- moment (a discharged plan and no open one). The doctor's appointment list
-- shows it as a follow-up after discharge. It is not the roadmap's chosen
-- follow-up appointment (migration 56) unless the doctor chooses it.

alter table public.appointment
  add column if not exists appointment_follow_up_of_plan_id uuid
    references public.treatment_plan (treatment_plan_id) on delete set null;

create index if not exists appointment_follow_up_of_plan_idx
  on public.appointment (appointment_follow_up_of_plan_id)
  where appointment_follow_up_of_plan_id is not null;

comment on column public.appointment.appointment_follow_up_of_plan_id is
  'Migration 57: the discharged plan this appointment follows up, set by the '
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
                            and open_plan.treatment_plan_status::text in ('active', 'ready_for_discharge'))
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

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
-- Guarded on pg_cron as migrations 9 and 55: the test harness has none. Daily
-- at 16:15 UTC - 00:15 in Asia/Manila, the clinic's zone - clear of the
-- hourly jobs at :00, :05 and :10. cron.schedule(name, ...) replaces a job of
-- the same name, so re-running this adds no second job.
do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; the ready-for-discharge job was NOT scheduled. '
      'Call mark_treatment_plans_ready_for_discharge() daily from an external '
      'scheduler with the service role instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule(
    'recoverease-mark-plans-ready-for-discharge',
    '15 16 * * *',
    $job$ select public.mark_treatment_plans_ready_for_discharge() $job$
  );

  raise notice 'RecoverEase ready-for-discharge job scheduled via pg_cron.';
end
$$;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
