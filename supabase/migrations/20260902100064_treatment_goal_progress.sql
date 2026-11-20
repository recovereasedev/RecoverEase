-- ===========================================================================
-- RecoverEase — 64. Treatment goal progress: the patient's own progress and
-- the system's missed status
-- ===========================================================================
-- Re-landed from pending migration 55 (merged in PR #85, never applied to
-- production), renumbered after 61 and 63. Two changes from 55, both marked
-- (64) below: the missed-goal job skips a patient whose care is discharged
-- (63) and a plan that is discharged (61); and the patient's progress is
-- refused while their care is discharged, in the patient's words (63's guard
-- would refuse it anyway). Everything else is 55's text; "migration 55" in
-- it means this migration.
--
-- Module 3.3 "Define Treatment Goals" and 5.8 "View Treatment Goals",
-- completed. The doctor sets a goal; the patient records their progress
-- (pending → in progress → achieved); once the target date has passed in the
-- clinic's own time zone, a scheduled job marks a goal still open as missed.
-- What already exists stays the source of truth and is never copied:
--
--   * `treatment_goal.treatment_goal_status` is the one status.
--   * `treatment_goal_status_event` (migration 45) keeps every change, written
--     only by `treatment_goal_record_status`. It gains one column,
--     `treatment_goal_change_source`, so the patient's changes and the
--     system's can be told apart without inventing an actor: 'user' is a
--     signed-in person (`treatment_goal_changed_by`), 'system' is the missed
--     job, 'service' any other change made with no one signed in. Events
--     written before 55 keep a null source; none is rewritten.
--
-- New:
--
--   * `patient_update_treatment_goal_status()`: the patient's only way to
--     change a goal - its status, to in progress or achieved, and nothing
--     else. A missed goal may still be achieved late; its missed event stays.
--   * `treatment_goal_guard_progress`: no signed-in session sets a status
--     directly, so the doctor monitors progress but never records it; and a
--     target date a session sets is not in the past and lies within the
--     plan's dates (the rule migration 45 gave activities).
--   * `mark_missed_treatment_goals()`: the job, for the service role only,
--     run hourly by pg_cron as `recoverease-mark-missed-treatment-goals`.
--
-- Rollback: supabase/rollbacks/20260902100064_treatment_goal_progress.down.sql
-- ===========================================================================

-- Adding the column and the triggers locks `treatment_goal_status_event` and
-- `treatment_goal`. Waiting at most 3 seconds for those locks, the migration
-- fails rather than holding the website up behind it; reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Who made a change: a person, the system, or the service
-- ---------------------------------------------------------------------------

alter table public.treatment_goal_status_event
  add column if not exists treatment_goal_change_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'treatment_goal_change_source_valid'
       and conrelid = 'public.treatment_goal_status_event'::regclass
  ) then
    alter table public.treatment_goal_status_event
      add constraint treatment_goal_change_source_valid
      check (treatment_goal_change_source in ('user', 'system', 'service'));
  end if;
end
$$;

comment on column public.treatment_goal_status_event.treatment_goal_change_source is
  'Migration 55: who made the change - ''user'' (a signed-in person, in '
  'treatment_goal_changed_by), ''system'' (the scheduled missed check) or '
  '''service'' (any other change with no one signed in). Null for events '
  'written before migration 55.';

-- The history's writer, as in migration 45, now with the source. 'system'
-- only when no one is signed in and the missed job set its transaction-local
-- flag, so no session can pass its own change off as the system's.
create or replace function public.treatment_goal_record_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' or new.treatment_goal_status is distinct from old.treatment_goal_status then
    insert into public.treatment_goal_status_event
      (treatment_goal_id, treatment_goal_previous_status, treatment_goal_new_status,
       treatment_goal_changed_by, treatment_goal_change_source)
    values (
      new.treatment_goal_id,
      case when tg_op = 'UPDATE' then old.treatment_goal_status end,
      new.treatment_goal_status,
      actor,
      case
        when actor is not null then 'user'
        when current_setting('recoverease.goal_status_source', true) = 'system' then 'system'
        else 'service'
      end
    );
  end if;
  return null;
end;
$$;

revoke all on function public.treatment_goal_record_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What a signed-in session may write to a goal
-- ---------------------------------------------------------------------------
-- Row-level security already limits writes to the patient's assigned, active
-- doctor (migration 6). This adds what a policy cannot say: the status is not
-- theirs to set - a new goal starts pending, and only the patient's function
-- and the system's job change it afterwards. Both run as their owner, so this
-- check, which runs as the caller, lets them through.
create or replace function public.treatment_goal_guard_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  plan_patient uuid;
  plan_start   date;
  plan_end     date;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.treatment_goal_status <> 'pending')
     or (tg_op = 'UPDATE' and new.treatment_goal_status is distinct from old.treatment_goal_status) then
    raise exception 'Only the patient records a goal''s progress; the system marks it missed'
      using errcode = 'insufficient_privilege';
  end if;

  -- Checked when the date is set or changed, or the goal changes plan, so a
  -- goal whose date has since passed can still be reworded.
  if new.treatment_goal_target_date is not null
     and (tg_op = 'INSERT'
          or new.treatment_goal_target_date is distinct from old.treatment_goal_target_date
          or new.treatment_plan_id is distinct from old.treatment_plan_id) then
    select tp.pat_id, tp.treatment_plan_start_date, tp.treatment_plan_end_date
      into plan_patient, plan_start, plan_end
      from public.treatment_plan tp
     where tp.treatment_plan_id = new.treatment_plan_id;

    -- A goal due before today would be missed the moment it was set.
    if new.treatment_goal_target_date
       < app_private.clinic_today(app_private.clinic_of_patient(plan_patient)) then
      raise exception 'A goal''s target date cannot be in the past'
        using errcode = 'check_violation';
    end if;
    if new.treatment_goal_target_date < plan_start
       or (plan_end is not null and new.treatment_goal_target_date > plan_end) then
      raise exception 'A goal''s target date must fall within its treatment plan''s dates'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists treatment_goal_guard_progress on public.treatment_goal;
create trigger treatment_goal_guard_progress
  before insert or update on public.treatment_goal
  for each row execute function public.treatment_goal_guard_progress();

-- Trigger functions are not part of the Data API (migration 10).
revoke all on function public.treatment_goal_guard_progress() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The patient records their progress
-- ---------------------------------------------------------------------------
-- The only write a patient makes to a goal, and it changes the status alone.
-- As `patient_complete_recovery_activity` (migration 45): whose goal it is
-- comes first, read without a lock, so anyone else is refused - in the same
-- words whether the goal is someone else's or does not exist - before a lock
-- is taken. Then the goal is locked FOR UPDATE and its plan held FOR SHARE,
-- so two presses at once make one change and one event, and the missed job
-- waits for this call (or this call for it) and re-reads the status after.
--
-- Allowed: pending -> in progress, pending -> achieved, in progress ->
-- achieved, and missed -> achieved - a goal reached late. The missed event
-- stays in the history and the achieved one follows it; nothing is
-- rewritten. A goal never goes back, and only the system marks one missed.
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
  -- (64) Not while the patient's care has ended.
  if (select app_private.patient_care_is_discharged(
        (select tp.pat_id from public.treatment_plan tp where tp.treatment_plan_id = goal_row.treatment_plan_id),
        true)) then
    raise exception 'Your care has ended. Book a follow-up if you need more care.'
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

revoke all on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) from public, anon;
grant execute on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) to authenticated;

comment on function public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status) is
  'Module 5.8 (migration 55): the patient moves their own goal to in progress '
  'or achieved. The only change a patient makes to a goal.';

-- ---------------------------------------------------------------------------
-- The system marks overdue goals missed
-- ---------------------------------------------------------------------------
-- A goal still pending or in progress whose target date is before today in
-- its clinic's time zone - the patient's doctor's clinic, as the medication
-- jobs read it - becomes missed. A goal with no target date, or one already
-- achieved or missed, is never touched. Every patient has a doctor
-- (`patient.doc_id` is not null), so every goal has its clinic's day; no
-- zone is ever guessed.
--
-- One statement: under READ COMMITTED a goal the patient is changing at the
-- same moment is waited for and re-checked, so an achievement that commits
-- first is kept. Run again, it finds nothing to change and writes nothing,
-- since the history trigger writes only on a real change. The history marks
-- each change 'system', with no actor. A failure is raised with its SQLSTATE
-- alone - no goal, patient or clinical text - for pg_cron's run history, and
-- the whole run is undone.
create index if not exists treatment_goal_open_target_idx
  on public.treatment_goal (treatment_goal_target_date)
  where treatment_goal_status in ('pending', 'in_progress')
    and treatment_goal_target_date is not null;

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
     -- (64) Never for a patient whose care is discharged, nor a discharged plan.
     and p.pat_care_status = 'in_care'
     and tp.treatment_plan_status::text = 'active'
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

revoke all on function public.mark_missed_treatment_goals() from public, anon, authenticated;
grant execute on function public.mark_missed_treatment_goals() to service_role;

comment on function public.mark_missed_treatment_goals() is
  'Migration 55: marks goals whose target date has passed in their clinic''s '
  'time zone missed, as the system. Scheduled hourly by pg_cron; service '
  'role only. Idempotent.';

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
-- Guarded on pg_cron as migration 9 is: the PGlite test harness has none,
-- and the right behaviour without it is to skip and say so. Hourly, at ten
-- past, so a goal turns missed within an hour of its clinic's midnight in
-- any time zone, clear of the overdue-dose job at five past.
-- cron.schedule(name, ...) replaces a job of the same name, so re-running
-- this does not add a second job.
do $$
begin
  if not exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    raise notice
      'pg_cron is not available; the missed-goal job was NOT scheduled. '
      'Call mark_missed_treatment_goals() hourly from an external scheduler '
      'with the service role instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule(
    'recoverease-mark-missed-treatment-goals',
    '10 * * * *',
    $job$ select public.mark_missed_treatment_goals() $job$
  );

  raise notice 'RecoverEase missed-goal job scheduled via pg_cron.';
end
$$;

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
