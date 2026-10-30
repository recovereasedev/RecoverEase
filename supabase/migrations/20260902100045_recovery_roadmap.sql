-- ===========================================================================
-- RecoverEase — 45. The recovery roadmap: phases, activities, and the history
-- behind its progress
-- ===========================================================================
-- Module 5.7 "View Recovery Roadmap", enhanced as the adviser asked: a
-- treatment plan is laid out as numbered phases, each with the activities
-- the doctor assigns, which the patient marks done as they go. What already
-- exists stays the source of truth and is never copied:
--
--   * `treatment_plan` is the roadmap's parent. A patient may have several
--     active plans; each has its own phases and its own progress.
--   * `treatment_goal` keeps its one authoritative status. A goal may now be
--     linked to one phase of its own plan (`recovery_phase_id`); only linked
--     goals count towards the roadmap's progress.
--   * Doses (`medication_log`), appointments (`appointment`) and mood
--     check-ins (`recovery_log`) are only read, as upcoming tasks and in the
--     charts. Nothing here records them again.
--
-- New:
--
--   * `recovery_phase`: a plan's phases, in order, with optional dates
--     inside the plan's own.
--   * `recovery_activity`: a phase's doctor-assigned activities - only what
--     is not already a dose, an appointment or a goal. The patient's
--     completion is two columns no signed-in session may write directly.
--   * `recovery_activity_event`: every completion and every undo, with who
--     and when - append-only, written only by the two functions below.
--   * `treatment_goal_status_event`: every change of a goal's status from
--     now on, with who and when, so a chart can say when a goal was achieved.
--     Goals already achieved have no such date, and none is invented.
--   * `patient_complete_recovery_activity()` / `patient_reopen_recovery_
--     activity()`: the patient's only way to mark an activity done or undo
--     it, so a patient can never touch the doctor's text, dates or order.
--   * `doctor_reorder_recovery_phases()` / `doctor_reorder_recovery_
--     activities()`: a new order in one statement, under the doctor's own
--     row-level security.
--
-- Who may do what: the patient reads their own roadmap and marks their own
-- activities; their assigned, active doctor builds and changes it
-- (`is_my_patient`, which already requires both); nobody else - another
-- doctor, a deactivated one, a Clinic Admin, a visitor - reads or writes a
-- row. Nothing is deleted through the website: a phase or an activity is
-- archived, so a completion's history outlives it.
--
-- Rollback: supabase/rollbacks/20260902100045_recovery_roadmap.down.sql
-- ===========================================================================

-- Adding the goal's column, its foreign key and its trigger locks
-- `treatment_goal`. Waiting at most 3 seconds for that lock, the migration
-- fails rather than holding the website up behind it (docs/deployment.md,
-- "Migration timing and run history"). A plain SET, not SET LOCAL, so it
-- holds whether or not the runner wraps this file in one transaction; it is
-- reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Phases
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_phase (
  recovery_phase_id              uuid primary key default gen_random_uuid(),
  treatment_plan_id              uuid not null
                                   references public.treatment_plan (treatment_plan_id)
                                   on delete cascade,
  recovery_phase_title           text not null,
  recovery_phase_description     text,
  recovery_phase_order           integer not null,
  recovery_phase_start_date      date,
  recovery_phase_target_end_date date,
  recovery_phase_archived_at     timestamptz,
  recovery_phase_created_at      timestamptz not null default now(),
  recovery_phase_updated_at      timestamptz not null default now(),

  constraint recovery_phase_title_valid
    check (btrim(recovery_phase_title) <> '' and char_length(recovery_phase_title) <= 120),
  constraint recovery_phase_description_length
    check (recovery_phase_description is null or char_length(recovery_phase_description) <= 2000),
  constraint recovery_phase_order_positive
    check (recovery_phase_order > 0),
  constraint recovery_phase_dates_ordered
    check (
      recovery_phase_start_date is null
      or recovery_phase_target_end_date is null
      or recovery_phase_target_end_date >= recovery_phase_start_date
    ),
  -- What a goal's link refers to, so a goal can only join a phase of its
  -- own plan (`treatment_goal_phase_in_plan` below).
  constraint recovery_phase_in_plan unique (recovery_phase_id, treatment_plan_id)
);

-- One phase per place in its plan's order; an archived phase gives its
-- place up.
create unique index if not exists recovery_phase_order_unique
  on public.recovery_phase (treatment_plan_id, recovery_phase_order)
  where recovery_phase_archived_at is null;

-- Every phase of a plan, archived ones too, for the plan's own deletion.
create index if not exists recovery_phase_plan_idx
  on public.recovery_phase (treatment_plan_id);

comment on table public.recovery_phase is
  'Module 5.7 (migration 45): a treatment plan''s recovery phases, in order. '
  'Written by the patient''s assigned, active doctor; read by them and the '
  'patient. Archived, never deleted, through the website.';

-- ---------------------------------------------------------------------------
-- Activities
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_activity (
  recovery_activity_id           uuid primary key default gen_random_uuid(),
  recovery_phase_id              uuid not null
                                   references public.recovery_phase (recovery_phase_id)
                                   on delete cascade,
  recovery_activity_title        text not null,
  recovery_activity_description  text,
  recovery_activity_target_date  date,
  recovery_activity_order        integer not null,
  -- The patient's completion. Written only by
  -- patient_complete_recovery_activity() and patient_reopen_recovery_
  -- activity(); `recovery_activity_guard` refuses it from any session.
  recovery_activity_completed_at timestamptz,
  recovery_activity_completed_by uuid
                                   references public.user_account (user_id)
                                   on delete set null,
  recovery_activity_archived_at  timestamptz,
  recovery_activity_created_at   timestamptz not null default now(),
  recovery_activity_updated_at   timestamptz not null default now(),

  constraint recovery_activity_title_valid
    check (btrim(recovery_activity_title) <> '' and char_length(recovery_activity_title) <= 200),
  constraint recovery_activity_description_length
    check (recovery_activity_description is null or char_length(recovery_activity_description) <= 2000),
  constraint recovery_activity_order_positive
    check (recovery_activity_order > 0)
);

create unique index if not exists recovery_activity_order_unique
  on public.recovery_activity (recovery_phase_id, recovery_activity_order)
  where recovery_activity_archived_at is null;

create index if not exists recovery_activity_phase_idx
  on public.recovery_activity (recovery_phase_id);
create index if not exists recovery_activity_completed_by_idx
  on public.recovery_activity (recovery_activity_completed_by)
  where recovery_activity_completed_by is not null;

comment on table public.recovery_activity is
  'Module 5.7 (migration 45): the activities a doctor assigns in a recovery '
  'phase - only what is not already a dose, an appointment or a treatment '
  'goal. The patient marks one done through patient_complete_recovery_'
  'activity(); archived, never deleted, through the website.';

-- ---------------------------------------------------------------------------
-- The history behind progress
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regtype('public.recovery_activity_event_kind') is null then
    create type public.recovery_activity_event_kind as enum ('completed', 'reopened');
  end if;
end
$$;

create table if not exists public.recovery_activity_event (
  recovery_activity_event_id    uuid primary key default gen_random_uuid(),
  recovery_activity_id          uuid not null
                                  references public.recovery_activity (recovery_activity_id)
                                  on delete cascade,
  recovery_activity_event_kind  public.recovery_activity_event_kind not null,
  recovery_activity_event_actor uuid
                                  references public.user_account (user_id)
                                  on delete set null,
  recovery_activity_event_at    timestamptz not null default now()
);

create index if not exists recovery_activity_event_activity_idx
  on public.recovery_activity_event (recovery_activity_id, recovery_activity_event_at);

create index if not exists recovery_activity_event_actor_idx
  on public.recovery_activity_event (recovery_activity_event_actor)
  where recovery_activity_event_actor is not null;

comment on table public.recovery_activity_event is
  'Migration 45: each time a patient marked a roadmap activity done or '
  'undid it, by whom and when. Append-only; written only by the two '
  'patient functions.';

create table if not exists public.treatment_goal_status_event (
  treatment_goal_status_event_id uuid primary key default gen_random_uuid(),
  treatment_goal_id              uuid not null
                                   references public.treatment_goal (treatment_goal_id)
                                   on delete cascade,
  -- Null when the event is the goal being set.
  treatment_goal_previous_status public.treatment_goal_status,
  treatment_goal_new_status      public.treatment_goal_status not null,
  -- Null where no signed-in user made the change (the service role).
  treatment_goal_changed_by      uuid
                                   references public.user_account (user_id)
                                   on delete set null,
  treatment_goal_changed_at      timestamptz not null default now()
);

create index if not exists treatment_goal_status_event_goal_idx
  on public.treatment_goal_status_event (treatment_goal_id, treatment_goal_changed_at);

create index if not exists treatment_goal_status_event_changed_by_idx
  on public.treatment_goal_status_event (treatment_goal_changed_by)
  where treatment_goal_changed_by is not null;

comment on table public.treatment_goal_status_event is
  'Migration 45: every change of a treatment goal''s status from migration '
  '45 on, by whom and when. Goals set before it have no history; none is '
  'invented. Written only by the goal''s trigger.';

-- No session writes either history directly; the functions and the trigger
-- that do run as their owner.
revoke insert, update, delete, truncate on public.recovery_activity_event from anon, authenticated;
revoke insert, update, delete, truncate on public.treatment_goal_status_event from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A goal joins one phase of its own plan
-- ---------------------------------------------------------------------------

alter table public.treatment_goal
  add column if not exists recovery_phase_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'treatment_goal_phase_in_plan'
       and conrelid = 'public.treatment_goal'::regclass
  ) then
    alter table public.treatment_goal
      add constraint treatment_goal_phase_in_plan
      foreign key (recovery_phase_id, treatment_plan_id)
      references public.recovery_phase (recovery_phase_id, treatment_plan_id)
      on delete set null (recovery_phase_id);
  end if;
end
$$;

create index if not exists treatment_goal_phase_idx
  on public.treatment_goal (recovery_phase_id)
  where recovery_phase_id is not null;

comment on column public.treatment_goal.recovery_phase_id is
  'Migration 45: the recovery phase this goal belongs to, in its own plan, '
  'or null. Only linked goals count towards the roadmap''s progress.';

-- ---------------------------------------------------------------------------
-- Which patient a row belongs to, for the policies
-- ---------------------------------------------------------------------------

create or replace function app_private.patient_of_recovery_phase(target_phase_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.pat_id
    from public.recovery_phase ph
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
   where ph.recovery_phase_id = target_phase_id;
$$;

create or replace function app_private.patient_of_recovery_activity(target_activity_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.pat_id
    from public.recovery_activity a
    join public.recovery_phase ph on ph.recovery_phase_id = a.recovery_phase_id
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
   where a.recovery_activity_id = target_activity_id;
$$;

create or replace function app_private.patient_of_treatment_goal(target_goal_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.pat_id
    from public.treatment_goal g
    join public.treatment_plan tp on tp.treatment_plan_id = g.treatment_plan_id
   where g.treatment_goal_id = target_goal_id;
$$;

revoke all on function app_private.patient_of_recovery_phase(uuid) from public;
revoke all on function app_private.patient_of_recovery_activity(uuid) from public;
revoke all on function app_private.patient_of_treatment_goal(uuid) from public;
grant execute on function app_private.patient_of_recovery_phase(uuid) to authenticated, service_role;
grant execute on function app_private.patient_of_recovery_activity(uuid) to authenticated, service_role;
grant execute on function app_private.patient_of_treatment_goal(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.recovery_phase enable row level security;
alter table public.recovery_activity enable row level security;
alter table public.recovery_activity_event enable row level security;
alter table public.treatment_goal_status_event enable row level security;

drop policy if exists recovery_phase_select on public.recovery_phase;
create policy recovery_phase_select
  on public.recovery_phase for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )));

drop policy if exists recovery_phase_insert_doctor on public.recovery_phase;
create policy recovery_phase_insert_doctor
  on public.recovery_phase for insert to authenticated
  with check ((select app_private.is_my_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )));

drop policy if exists recovery_phase_update_doctor on public.recovery_phase;
create policy recovery_phase_update_doctor
  on public.recovery_phase for update to authenticated
  using ((select app_private.is_my_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )))
  with check ((select app_private.is_my_patient(
    (select app_private.patient_of_treatment_plan(treatment_plan_id))
  )));

drop policy if exists recovery_activity_select on public.recovery_activity;
create policy recovery_activity_select
  on public.recovery_activity for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_recovery_phase(recovery_phase_id))
  )));

drop policy if exists recovery_activity_insert_doctor on public.recovery_activity;
create policy recovery_activity_insert_doctor
  on public.recovery_activity for insert to authenticated
  with check ((select app_private.is_my_patient(
    (select app_private.patient_of_recovery_phase(recovery_phase_id))
  )));

drop policy if exists recovery_activity_update_doctor on public.recovery_activity;
create policy recovery_activity_update_doctor
  on public.recovery_activity for update to authenticated
  using ((select app_private.is_my_patient(
    (select app_private.patient_of_recovery_phase(recovery_phase_id))
  )))
  with check ((select app_private.is_my_patient(
    (select app_private.patient_of_recovery_phase(recovery_phase_id))
  )));

drop policy if exists recovery_activity_event_select on public.recovery_activity_event;
create policy recovery_activity_event_select
  on public.recovery_activity_event for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_recovery_activity(recovery_activity_id))
  )));

drop policy if exists treatment_goal_status_event_select on public.treatment_goal_status_event;
create policy treatment_goal_status_event_select
  on public.treatment_goal_status_event for select to authenticated
  using ((select app_private.can_access_patient(
    (select app_private.patient_of_treatment_goal(treatment_goal_id))
  )));

-- ---------------------------------------------------------------------------
-- What a write may change
-- ---------------------------------------------------------------------------
-- Timestamps and order are the database's; a phase stays in its plan and an
-- activity in its plan; dates stay inside the plan's; and archiving is a
-- one-way move made at the server's time (undone only by clearing it, which
-- puts the row at the end of the order).

create or replace function public.recovery_phase_prepare()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  plan_start date;
  plan_end   date;
begin
  if tg_op = 'INSERT' then
    new.recovery_phase_created_at := now();
    new.recovery_phase_archived_at := null;
    if new.recovery_phase_order is null then
      select coalesce(max(ph.recovery_phase_order), 0) + 1 into new.recovery_phase_order
        from public.recovery_phase ph
       where ph.treatment_plan_id = new.treatment_plan_id
         and ph.recovery_phase_archived_at is null;
    end if;
  else
    if new.treatment_plan_id is distinct from old.treatment_plan_id then
      raise exception 'A phase stays in its own treatment plan'
        using errcode = 'insufficient_privilege';
    end if;
    new.recovery_phase_created_at := old.recovery_phase_created_at;
    if old.recovery_phase_archived_at is null and new.recovery_phase_archived_at is not null then
      new.recovery_phase_archived_at := now();
    elsif old.recovery_phase_archived_at is not null and new.recovery_phase_archived_at is not null then
      new.recovery_phase_archived_at := old.recovery_phase_archived_at;
    elsif old.recovery_phase_archived_at is not null and new.recovery_phase_archived_at is null then
      select coalesce(max(ph.recovery_phase_order), 0) + 1 into new.recovery_phase_order
        from public.recovery_phase ph
       where ph.treatment_plan_id = new.treatment_plan_id
         and ph.recovery_phase_archived_at is null;
    end if;
  end if;
  new.recovery_phase_updated_at := now();

  -- Checked when the dates are set or changed, so a plan whose own dates
  -- moved later does not stop the phase being reordered or archived.
  if tg_op = 'INSERT'
     or new.recovery_phase_start_date is distinct from old.recovery_phase_start_date
     or new.recovery_phase_target_end_date is distinct from old.recovery_phase_target_end_date then
    select tp.treatment_plan_start_date, tp.treatment_plan_end_date
      into plan_start, plan_end
      from public.treatment_plan tp
     where tp.treatment_plan_id = new.treatment_plan_id;
  end if;
  if new.recovery_phase_start_date < plan_start
     or new.recovery_phase_target_end_date < plan_start
     or (plan_end is not null and (new.recovery_phase_start_date > plan_end
                                   or new.recovery_phase_target_end_date > plan_end)) then
    raise exception 'A phase''s dates must fall within its treatment plan''s dates'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists recovery_phase_prepare on public.recovery_phase;
create trigger recovery_phase_prepare
  before insert or update on public.recovery_phase
  for each row execute function public.recovery_phase_prepare();

-- A phase archived takes its goals off the roadmap: they stay in the plan,
-- unlinked, for the doctor to place again.
create or replace function public.recovery_phase_release_goals()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.recovery_phase_archived_at is null and new.recovery_phase_archived_at is not null then
    update public.treatment_goal g
       set recovery_phase_id = null
     where g.recovery_phase_id = new.recovery_phase_id;
  end if;
  return null;
end;
$$;

drop trigger if exists recovery_phase_release_goals on public.recovery_phase;
create trigger recovery_phase_release_goals
  after update of recovery_phase_archived_at on public.recovery_phase
  for each row execute function public.recovery_phase_release_goals();

create or replace function public.recovery_activity_prepare()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  is_session   boolean := current_user in ('authenticated', 'anon');
  phase_plan   uuid;
  phase_closed boolean;
  plan_start   date;
  plan_end     date;
begin
  select ph.treatment_plan_id, ph.recovery_phase_archived_at is not null,
         tp.treatment_plan_start_date, tp.treatment_plan_end_date
    into phase_plan, phase_closed, plan_start, plan_end
    from public.recovery_phase ph
    join public.treatment_plan tp on tp.treatment_plan_id = ph.treatment_plan_id
   where ph.recovery_phase_id = new.recovery_phase_id;

  if tg_op = 'INSERT' then
    if is_session and (new.recovery_activity_completed_at is not null
                       or new.recovery_activity_completed_by is not null) then
      raise exception 'An activity is marked done by the patient, on their roadmap'
        using errcode = 'insufficient_privilege';
    end if;
    if phase_closed then
      raise exception 'This phase is archived; add the activity to a current phase'
        using errcode = 'check_violation';
    end if;
    new.recovery_activity_created_at := now();
    new.recovery_activity_archived_at := null;
    if new.recovery_activity_order is null then
      select coalesce(max(a.recovery_activity_order), 0) + 1 into new.recovery_activity_order
        from public.recovery_activity a
       where a.recovery_phase_id = new.recovery_phase_id
         and a.recovery_activity_archived_at is null;
    end if;
  else
    if is_session and (new.recovery_activity_completed_at is distinct from old.recovery_activity_completed_at
                       or new.recovery_activity_completed_by is distinct from old.recovery_activity_completed_by) then
      raise exception 'An activity is marked done by the patient, on their roadmap'
        using errcode = 'insufficient_privilege';
    end if;
    if new.recovery_phase_id is distinct from old.recovery_phase_id then
      if phase_plan is distinct from (select ph.treatment_plan_id
                                        from public.recovery_phase ph
                                       where ph.recovery_phase_id = old.recovery_phase_id) then
        raise exception 'An activity stays in its own treatment plan'
          using errcode = 'insufficient_privilege';
      end if;
      if phase_closed then
        raise exception 'This phase is archived; move the activity to a current phase'
          using errcode = 'check_violation';
      end if;
      -- Moved, it goes to the end of its new phase.
      select coalesce(max(a.recovery_activity_order), 0) + 1 into new.recovery_activity_order
        from public.recovery_activity a
       where a.recovery_phase_id = new.recovery_phase_id
         and a.recovery_activity_archived_at is null;
    end if;
    new.recovery_activity_created_at := old.recovery_activity_created_at;
    if old.recovery_activity_archived_at is null and new.recovery_activity_archived_at is not null then
      new.recovery_activity_archived_at := now();
    elsif old.recovery_activity_archived_at is not null and new.recovery_activity_archived_at is not null then
      new.recovery_activity_archived_at := old.recovery_activity_archived_at;
    elsif old.recovery_activity_archived_at is not null and new.recovery_activity_archived_at is null then
      select coalesce(max(a.recovery_activity_order), 0) + 1 into new.recovery_activity_order
        from public.recovery_activity a
       where a.recovery_phase_id = new.recovery_phase_id
         and a.recovery_activity_archived_at is null;
    end if;
  end if;
  new.recovery_activity_updated_at := now();

  -- Checked when the date is set or changed, or the activity moves, so a
  -- plan whose own dates moved later does not stop the patient marking it.
  if (tg_op = 'INSERT'
      or new.recovery_activity_target_date is distinct from old.recovery_activity_target_date
      or new.recovery_phase_id is distinct from old.recovery_phase_id)
     and (new.recovery_activity_target_date < plan_start
          or (plan_end is not null and new.recovery_activity_target_date > plan_end)) then
    raise exception 'An activity''s target date must fall within its treatment plan''s dates'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists recovery_activity_prepare on public.recovery_activity;
create trigger recovery_activity_prepare
  before insert or update on public.recovery_activity
  for each row execute function public.recovery_activity_prepare();

-- A goal joins only a current phase. (Its plan is the foreign key's.)
create or replace function public.treatment_goal_check_phase()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recovery_phase_id is not null
     and (tg_op = 'INSERT' or new.recovery_phase_id is distinct from old.recovery_phase_id)
     and exists (select 1 from public.recovery_phase ph
                  where ph.recovery_phase_id = new.recovery_phase_id
                    and ph.recovery_phase_archived_at is not null) then
    raise exception 'This phase is archived; link the goal to a current phase'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists treatment_goal_check_phase on public.treatment_goal;
create trigger treatment_goal_check_phase
  before insert or update of recovery_phase_id on public.treatment_goal
  for each row execute function public.treatment_goal_check_phase();

-- Every change of a goal's status, kept. Runs as its owner: no session may
-- write the history itself.
create or replace function public.treatment_goal_record_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.treatment_goal_status is distinct from old.treatment_goal_status then
    insert into public.treatment_goal_status_event
      (treatment_goal_id, treatment_goal_previous_status, treatment_goal_new_status, treatment_goal_changed_by)
    values (
      new.treatment_goal_id,
      case when tg_op = 'UPDATE' then old.treatment_goal_status end,
      new.treatment_goal_status,
      (select auth.uid())
    );
  end if;
  return null;
end;
$$;

drop trigger if exists treatment_goal_record_status on public.treatment_goal;
create trigger treatment_goal_record_status
  after insert or update of treatment_goal_status on public.treatment_goal
  for each row execute function public.treatment_goal_record_status();

-- Trigger functions are not part of the Data API; firing a trigger needs no
-- EXECUTE (migration 10).
revoke all on function public.recovery_phase_prepare() from public, anon, authenticated;
revoke all on function public.recovery_phase_release_goals() from public, anon, authenticated;
revoke all on function public.recovery_activity_prepare() from public, anon, authenticated;
revoke all on function public.treatment_goal_check_phase() from public, anon, authenticated;
revoke all on function public.treatment_goal_record_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The patient marks an activity done, or undoes it
-- ---------------------------------------------------------------------------
-- The only writes a patient makes to the roadmap. Each locks the activity
-- row, so two presses at once make one change and one event; the second is
-- refused. An activity can be marked only while its phase and itself are on
-- the roadmap and its plan is active.

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
   where ph.recovery_phase_id = activity_row.recovery_phase_id;

  if me is null or owner_id is distinct from me then
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
   where ph.recovery_phase_id = activity_row.recovery_phase_id;

  if me is null or owner_id is distinct from me then
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

comment on function public.patient_complete_recovery_activity(uuid) is
  'Module 5.7 (migration 45): the signed-in patient marks one of their own '
  'roadmap activities done, at the server''s time; recorded as an event.';
comment on function public.patient_reopen_recovery_activity(uuid) is
  'Module 5.7 (migration 45): the signed-in patient undoes marking one of '
  'their own roadmap activities done; recorded as an event.';

-- ---------------------------------------------------------------------------
-- The doctor reorders phases or activities
-- ---------------------------------------------------------------------------
-- As the caller, under their own row-level security. The new order lists
-- every current row once; it is written in two steps so no two rows ever
-- share a place.

create or replace function public.doctor_reorder_recovery_phases(target_plan_id uuid, phase_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select app_private.is_my_patient((select app_private.patient_of_treatment_plan(target_plan_id)))) then
    raise exception 'Only the patient''s assigned doctor can change their roadmap'
      using errcode = 'insufficient_privilege';
  end if;
  if cardinality(phase_ids) is distinct from (select count(distinct id) from unnest(phase_ids) as id)
     or (select array_agg(ph.recovery_phase_id order by ph.recovery_phase_id)
           from public.recovery_phase ph
          where ph.treatment_plan_id = target_plan_id
            and ph.recovery_phase_archived_at is null)
        is distinct from
        (select array_agg(id order by id) from unnest(phase_ids) as id) then
    raise exception 'The new order must list each of the plan''s current phases once'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.recovery_phase ph
     set recovery_phase_order = ph.recovery_phase_order + 100000
   where ph.treatment_plan_id = target_plan_id
     and ph.recovery_phase_archived_at is null;
  update public.recovery_phase ph
     set recovery_phase_order = o.position
    from unnest(phase_ids) with ordinality as o(id, position)
   where ph.recovery_phase_id = o.id;
end;
$$;

create or replace function public.doctor_reorder_recovery_activities(target_phase_id uuid, activity_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select app_private.is_my_patient((select app_private.patient_of_recovery_phase(target_phase_id)))) then
    raise exception 'Only the patient''s assigned doctor can change their roadmap'
      using errcode = 'insufficient_privilege';
  end if;
  if cardinality(activity_ids) is distinct from (select count(distinct id) from unnest(activity_ids) as id)
     or (select array_agg(a.recovery_activity_id order by a.recovery_activity_id)
           from public.recovery_activity a
          where a.recovery_phase_id = target_phase_id
            and a.recovery_activity_archived_at is null)
        is distinct from
        (select array_agg(id order by id) from unnest(activity_ids) as id) then
    raise exception 'The new order must list each of the phase''s current activities once'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.recovery_activity a
     set recovery_activity_order = a.recovery_activity_order + 100000
   where a.recovery_phase_id = target_phase_id
     and a.recovery_activity_archived_at is null;
  update public.recovery_activity a
     set recovery_activity_order = o.position
    from unnest(activity_ids) with ordinality as o(id, position)
   where a.recovery_activity_id = o.id;
end;
$$;

revoke all on function public.doctor_reorder_recovery_phases(uuid, uuid[]) from public, anon;
revoke all on function public.doctor_reorder_recovery_activities(uuid, uuid[]) from public, anon;
grant execute on function public.doctor_reorder_recovery_phases(uuid, uuid[]) to authenticated;
grant execute on function public.doctor_reorder_recovery_activities(uuid, uuid[]) to authenticated;

comment on function public.doctor_reorder_recovery_phases(uuid, uuid[]) is
  'Module 5.7 (migration 45): the assigned doctor puts a plan''s current '
  'phases in a new order, in one call.';
comment on function public.doctor_reorder_recovery_activities(uuid, uuid[]) is
  'Module 5.7 (migration 45): the assigned doctor puts a phase''s current '
  'activities in a new order, in one call.';

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
