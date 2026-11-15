-- ===========================================================================
-- Rollback of migration 57 (discharge_reopen_treatment_case)
-- ===========================================================================
-- Removes the case lifecycle: the readiness job and its schedule, the
-- doctor's discharge and reopen functions, the guards, the lifecycle history,
-- the discharge columns, the follow-up mark on appointments, and the two
-- enum values; and puts back migrations 45 and 55's patient functions and
-- missed-goal job.
--
-- It refuses while any plan is discharged or ready for discharge: those
-- values cannot be removed while a row holds them, and no status is
-- rewritten here. Reopen each discharged plan (and decide each ready one)
-- first. The lifecycle history and follow-up marks are dropped with their
-- table and column. Applied as a new migration, with approval
-- (tests/db/discharge-reopen.test.ts).
--
-- Roll the website back first: from 57 on it calls the functions this drops.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.doctor_discharge_treatment_plan(uuid, text)') is null then
    raise exception 'Migration 57 is not applied. Nothing was changed.';
  end if;
  if exists (select 1 from public.treatment_plan
              where treatment_plan_status::text in ('ready_for_discharge', 'discharged')) then
    raise exception 'Some plans are discharged or ready for discharge; reopen or settle them first. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

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
drop function if exists public.doctor_discharge_treatment_plan(uuid, text);
drop function if exists public.doctor_reopen_treatment_plan(uuid);

drop trigger if exists appointment_mark_follow_up on public.appointment;
drop function if exists public.appointment_mark_follow_up();
drop index if exists public.appointment_follow_up_of_plan_idx;
alter table public.appointment drop column if exists appointment_follow_up_of_plan_id;

drop trigger if exists recovery_log_guard_care_ended on public.recovery_log;
drop function if exists public.recovery_log_guard_care_ended();

drop trigger if exists treatment_plan_guard_lifecycle on public.treatment_plan;
drop function if exists public.treatment_plan_guard_lifecycle();
drop trigger if exists treatment_plan_record_lifecycle on public.treatment_plan;
drop function if exists public.treatment_plan_record_lifecycle();
drop table if exists public.treatment_plan_lifecycle_event;

alter table public.treatment_plan
  drop constraint if exists treatment_plan_discharge_complete,
  drop constraint if exists treatment_plan_closure_reason_valid,
  drop column if exists treatment_plan_discharged_at,
  drop column if exists treatment_plan_closure_reason;

-- An enum value cannot be dropped: the type is made again with migration 1's
-- four values, and the column moved onto it.
alter table public.treatment_plan alter column treatment_plan_status drop default;
alter type public.treatment_plan_status rename to treatment_plan_status_57;
create type public.treatment_plan_status as enum
  ('draft', 'active', 'completed', 'cancelled');
alter table public.treatment_plan
  alter column treatment_plan_status type public.treatment_plan_status
  using treatment_plan_status::text::public.treatment_plan_status;
alter table public.treatment_plan alter column treatment_plan_status set default 'active';
drop type public.treatment_plan_status_57;

-- Migrations 45 and 55's functions, unchanged.
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
  if plan_state <> 'active' then
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
  if plan_state <> 'active' then
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
  if plan_state <> 'active' then
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

reset lock_timeout;
