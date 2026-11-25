-- ===========================================================================
-- RecoverEase — 65. The recovery roadmap is generated, not built by hand
-- ===========================================================================
-- Re-landed from pending migration 56 (merged in PR #86, never applied to
-- production), renumbered after 61. Unchanged but for this note and its
-- numbers; "migration 56" below means this migration.
--
-- Module 5.7, as the adviser asked: every treatment plan's roadmap has
-- exactly (its goals + 2) current phases, made and kept in step by the
-- database alone:
--
--   1. Initial Recovery          - always first; starts on the plan's start.
--   2. Recovery and Monitoring   - one per treatment goal, in the order the
--                                  goals were set, due on the goal's target
--                                  date. Its heading on screen is the goal's
--                                  own description; its status is the goal's
--                                  own `treatment_goal_status` (migration 55
--                                  stays its only writer) - never copied.
--   3. Follow-up and Assessment  - always last; due on the plan's end, with
--                                  the follow-up appointment the doctor
--                                  chose for the plan, if any.
--
-- What changes:
--
--   * `recovery_phase` gains `recovery_phase_kind` (initial | goal |
--     follow_up; null only on a pre-56 phase this migration archived) and
--     `treatment_goal_id` (a goal phase's goal, unique). The order is
--     structural: Initial 1, goal phases 2..999 999, Follow-up 1 000 000, so
--     a new goal never rewrites another phase.
--   * `treatment_plan.treatment_plan_follow_up_appointment_id`: the plan's
--     follow-up appointment, one of its own patient's (composite foreign
--     key), chosen by the doctor. `appointment` has no type or plan of its
--     own, so nothing is guessed: with none chosen, none is shown.
--   * `app_private.sync_recovery_roadmap(plan)`: makes any missing phase and
--     brings dates and links up to date; idempotent. Run by triggers when a
--     plan is created or its dates change, and when a goal is added or its
--     target date changes. A goal deleted takes its phase off the roadmap
--     (archived), its activities moving to Initial Recovery with their
--     history.
--   * No session writes a phase any more: the doctor's insert and update
--     policies, `doctor_reorder_recovery_phases()` and the release of goals
--     on archive are gone, and a session cannot move a goal to a phase or to
--     another plan. Activities stay the doctor's to manage and the patient's
--     to mark, unchanged.
--
-- Existing roadmaps: a current phase linked to exactly one goal becomes that
-- goal's phase, in place - same row, same activities, same history. Any
-- other current phase hands its current activities, in order, to Initial
-- Recovery and is archived. Nothing is deleted.
--
-- Nothing here reads or writes `treatment_plan_status`, a patient or an
-- account: a roadmap fully done is progress, not recovery or discharge.
--
-- Rollback: supabase/rollbacks/20260902100065_automatic_recovery_roadmap.down.sql
-- ===========================================================================

set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- A phase's kind and goal
-- ---------------------------------------------------------------------------

alter table public.recovery_phase
  add column if not exists recovery_phase_kind text,
  add column if not exists treatment_goal_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recovery_phase_kind_valid'
                    and conrelid = 'public.recovery_phase'::regclass) then
    alter table public.recovery_phase
      add constraint recovery_phase_kind_valid
      check (recovery_phase_kind in ('initial', 'goal', 'follow_up'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recovery_phase_goal_fk'
                    and conrelid = 'public.recovery_phase'::regclass) then
    alter table public.recovery_phase
      add constraint recovery_phase_goal_fk
      foreign key (treatment_goal_id) references public.treatment_goal (treatment_goal_id)
      on delete set null;
  end if;
  -- One phase per goal, ever: the database's own guard against a duplicate.
  if not exists (select 1 from pg_constraint where conname = 'recovery_phase_goal_unique'
                    and conrelid = 'public.recovery_phase'::regclass) then
    alter table public.recovery_phase
      add constraint recovery_phase_goal_unique unique (treatment_goal_id);
  end if;
end
$$;

comment on column public.recovery_phase.recovery_phase_kind is
  'Migration 56: initial, goal or follow_up - which generated phase this is. '
  'Null only on a phase made by hand before 56, which 56 archived.';
comment on column public.recovery_phase.treatment_goal_id is
  'Migration 56: the goal a Recovery and Monitoring phase belongs to. '
  'Unique; its status is read from the goal, never copied.';

-- ---------------------------------------------------------------------------
-- The plan's follow-up appointment
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'appointment_id_patient_unique'
                    and conrelid = 'public.appointment'::regclass) then
    alter table public.appointment
      add constraint appointment_id_patient_unique unique (appointment_id, pat_id);
  end if;
end
$$;

alter table public.treatment_plan
  add column if not exists treatment_plan_follow_up_appointment_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_follow_up_appointment_fk'
                    and conrelid = 'public.treatment_plan'::regclass) then
    alter table public.treatment_plan
      add constraint treatment_plan_follow_up_appointment_fk
      foreign key (treatment_plan_follow_up_appointment_id, pat_id)
      references public.appointment (appointment_id, pat_id)
      on delete set null (treatment_plan_follow_up_appointment_id);
  end if;
end
$$;

create index if not exists treatment_plan_follow_up_appointment_idx
  on public.treatment_plan (treatment_plan_follow_up_appointment_id)
  where treatment_plan_follow_up_appointment_id is not null;

comment on column public.treatment_plan.treatment_plan_follow_up_appointment_id is
  'Migration 56: the appointment shown in the roadmap''s Follow-up and '
  'Assessment phase - one of this plan''s patient''s own, chosen by the '
  'doctor. Its date and status are read from the appointment.';

-- ---------------------------------------------------------------------------
-- No session writes a phase
-- ---------------------------------------------------------------------------

-- Inserting and deleting are refused outright. UPDATE stays granted, with
-- the doctor's policy, only because `FOR SHARE` needs both: the doctor's
-- own goal and activity writes lock a phase that way (migration 45). The
-- write itself is refused by `recovery_phase_prepare` below for every
-- signed-in or anonymous session.
drop policy if exists recovery_phase_insert_doctor on public.recovery_phase;
revoke insert, delete, truncate on public.recovery_phase from anon, authenticated;

drop function if exists public.doctor_reorder_recovery_phases(uuid, uuid[]);

-- A phase is archived only when its goal is deleted, and only after the goal
-- is on its way out, so nothing is left to release.
drop trigger if exists recovery_phase_release_goals on public.recovery_phase;
drop function if exists public.recovery_phase_release_goals();

-- What a write to a phase may change, now that only the database writes
-- one: the timestamps are the server's, a phase stays in its plan, and
-- archiving is one-way. Dates are copied from the plan and goals as they
-- are, so they are not checked against the plan here.
create or replace function public.recovery_phase_prepare()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'Roadmap phases are generated by the system'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.recovery_phase_created_at := now();
    new.recovery_phase_archived_at := null;
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
      raise exception 'An archived phase stays archived'
        using errcode = 'check_violation';
    end if;
  end if;
  new.recovery_phase_updated_at := now();
  return new;
end;
$$;

revoke all on function public.recovery_phase_prepare() from public, anon, authenticated;

-- Migration 45's activity rule, with one change: an activity the database
-- itself moves (a deleted goal's, or a pre-56 phase's) keeps its target date
-- even where the plan's dates have since moved. A doctor's move is checked
-- as before.
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
  -- An activity joining a phase (added, moved or restored) holds the phase
  -- FOR SHARE until its transaction ends, as a goal does, so it and an
  -- archive of that phase cannot cross; the read below then sees any
  -- archive that came first. Other changes take no phase lock.
  if tg_op = 'INSERT'
     or new.recovery_phase_id is distinct from old.recovery_phase_id
     or (old.recovery_activity_archived_at is not null and new.recovery_activity_archived_at is null) then
    perform 1
       from public.recovery_phase ph
      where ph.recovery_phase_id = new.recovery_phase_id
        for share;
  end if;

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
      -- Restored, it goes to the end of its phase - which must be current.
      if phase_closed then
        raise exception 'This phase is archived; restore the phase first'
          using errcode = 'check_violation';
      end if;
      select coalesce(max(a.recovery_activity_order), 0) + 1 into new.recovery_activity_order
        from public.recovery_activity a
       where a.recovery_phase_id = new.recovery_phase_id
         and a.recovery_activity_archived_at is null;
    end if;
  end if;
  new.recovery_activity_updated_at := now();

  -- Checked when the date is set or changed, or a session moves the
  -- activity, so a plan whose own dates moved later does not stop the
  -- patient marking it, nor the database moving it.
  if (tg_op = 'INSERT'
      or new.recovery_activity_target_date is distinct from old.recovery_activity_target_date
      or (is_session and new.recovery_phase_id is distinct from old.recovery_phase_id))
     and (new.recovery_activity_target_date < plan_start
          or (plan_end is not null and new.recovery_activity_target_date > plan_end)) then
    raise exception 'An activity''s target date must fall within its treatment plan''s dates'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.recovery_activity_prepare() from public, anon, authenticated;

-- A goal's phase is the database's to set, and a goal stays in its plan. A
-- session adding a goal names no phase (any it names is dropped); the
-- generator links it.
create or replace function public.treatment_goal_keep_roadmap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.recovery_phase_id := null;
    return new;
  end if;
  if new.recovery_phase_id is distinct from old.recovery_phase_id then
    raise exception 'A goal''s roadmap phase is set by the system'
      using errcode = 'insufficient_privilege';
  end if;
  if new.treatment_plan_id is distinct from old.treatment_plan_id then
    raise exception 'A goal stays in its own treatment plan'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists treatment_goal_keep_roadmap on public.treatment_goal;
create trigger treatment_goal_keep_roadmap
  before insert or update on public.treatment_goal
  for each row execute function public.treatment_goal_keep_roadmap();

revoke all on function public.treatment_goal_keep_roadmap() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The generator
-- ---------------------------------------------------------------------------
-- The plan row is held FOR NO KEY UPDATE until the transaction ends: two
-- goals added to one plan at once are generated one after the other, the
-- second seeing the first's phase. (It does not conflict with the key-share
-- lock a new goal's foreign key takes, so two such writers cannot deadlock
-- on it.) Every write is made only where something differs, so running it
-- again writes nothing, and adding a goal touches no other phase.

create or replace function app_private.sync_recovery_roadmap(target_plan_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  plan_row  public.treatment_plan;
  goal_row  record;
  phase_id  uuid;
begin
  select tp.* into plan_row
    from public.treatment_plan tp
   where tp.treatment_plan_id = target_plan_id
     for no key update;
  if not found then
    return;
  end if;

  -- Initial Recovery, first, from the plan's start.
  insert into public.recovery_phase
    (treatment_plan_id, recovery_phase_kind, recovery_phase_title, recovery_phase_order, recovery_phase_start_date)
  select target_plan_id, 'initial', 'Initial Recovery', 1, plan_row.treatment_plan_start_date
   where not exists (select 1 from public.recovery_phase ph
                      where ph.treatment_plan_id = target_plan_id
                        and ph.recovery_phase_kind = 'initial'
                        and ph.recovery_phase_archived_at is null);
  update public.recovery_phase ph
     set recovery_phase_start_date = plan_row.treatment_plan_start_date
   where ph.treatment_plan_id = target_plan_id
     and ph.recovery_phase_kind = 'initial'
     and ph.recovery_phase_archived_at is null
     and ph.recovery_phase_start_date is distinct from plan_row.treatment_plan_start_date;

  -- Follow-up and Assessment, last, due on the plan's end.
  insert into public.recovery_phase
    (treatment_plan_id, recovery_phase_kind, recovery_phase_title, recovery_phase_order, recovery_phase_target_end_date)
  select target_plan_id, 'follow_up', 'Follow-up and Assessment', 1000000, plan_row.treatment_plan_end_date
   where not exists (select 1 from public.recovery_phase ph
                      where ph.treatment_plan_id = target_plan_id
                        and ph.recovery_phase_kind = 'follow_up'
                        and ph.recovery_phase_archived_at is null);
  update public.recovery_phase ph
     set recovery_phase_target_end_date = plan_row.treatment_plan_end_date
   where ph.treatment_plan_id = target_plan_id
     and ph.recovery_phase_kind = 'follow_up'
     and ph.recovery_phase_archived_at is null
     and ph.recovery_phase_target_end_date is distinct from plan_row.treatment_plan_end_date;

  -- One Recovery and Monitoring phase per goal, in the order goals were set.
  for goal_row in
    select g.treatment_goal_id, g.treatment_goal_target_date, g.recovery_phase_id
      from public.treatment_goal g
     where g.treatment_plan_id = target_plan_id
     order by g.treatment_goal_created_at, g.treatment_goal_id
  loop
    select ph.recovery_phase_id into phase_id
      from public.recovery_phase ph
     where ph.treatment_goal_id = goal_row.treatment_goal_id
       and ph.recovery_phase_archived_at is null;

    if phase_id is null then
      insert into public.recovery_phase
        (treatment_plan_id, recovery_phase_kind, treatment_goal_id, recovery_phase_title,
         recovery_phase_order, recovery_phase_target_end_date)
      select target_plan_id, 'goal', goal_row.treatment_goal_id, 'Recovery and Monitoring',
             coalesce(max(ph.recovery_phase_order), 1) + 1, goal_row.treatment_goal_target_date
        from public.recovery_phase ph
       where ph.treatment_plan_id = target_plan_id
         and ph.recovery_phase_kind = 'goal'
         and ph.recovery_phase_archived_at is null
      returning recovery_phase_id into phase_id;
    else
      update public.recovery_phase ph
         set recovery_phase_target_end_date = goal_row.treatment_goal_target_date
       where ph.recovery_phase_id = phase_id
         and ph.recovery_phase_target_end_date is distinct from goal_row.treatment_goal_target_date;
    end if;

    if goal_row.recovery_phase_id is distinct from phase_id then
      update public.treatment_goal g
         set recovery_phase_id = phase_id
       where g.treatment_goal_id = goal_row.treatment_goal_id;
    end if;
  end loop;
end;
$$;

revoke all on function app_private.sync_recovery_roadmap(uuid) from public, anon, authenticated;
grant execute on function app_private.sync_recovery_roadmap(uuid) to service_role;

comment on function app_private.sync_recovery_roadmap(uuid) is
  'Migration 56: makes a plan''s roadmap exactly Initial Recovery, one '
  'Recovery and Monitoring phase per goal, and Follow-up and Assessment, '
  'with their dates. Idempotent; run by triggers.';

-- The triggers, as their owner: a session may not write a phase itself.
create or replace function public.recovery_roadmap_sync_from_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.sync_recovery_roadmap(new.treatment_plan_id);
  return null;
end;
$$;

drop trigger if exists treatment_plan_sync_roadmap on public.treatment_plan;
create trigger treatment_plan_sync_roadmap
  after insert or update of treatment_plan_start_date, treatment_plan_end_date on public.treatment_plan
  for each row execute function public.recovery_roadmap_sync_from_plan();

create or replace function public.recovery_roadmap_sync_from_goal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.sync_recovery_roadmap(new.treatment_plan_id);
  return null;
end;
$$;

drop trigger if exists treatment_goal_sync_roadmap on public.treatment_goal;
create trigger treatment_goal_sync_roadmap
  after insert or update of treatment_goal_target_date on public.treatment_goal
  for each row execute function public.recovery_roadmap_sync_from_goal();

-- A goal deleted: its current activities move, in order, to Initial
-- Recovery - the same rows, done or not, with their history - and its phase
-- is archived, so the roadmap is goals + 2 again. Nothing when the whole
-- plan is going (its phases go with it).
create or replace function public.treatment_goal_retire_phase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  goal_phase    uuid;
  initial_phase uuid;
  activity_id   uuid;
begin
  perform 1 from public.treatment_plan tp
   where tp.treatment_plan_id = old.treatment_plan_id
     for no key update;
  if not found then
    return old;
  end if;

  select ph.recovery_phase_id into goal_phase
    from public.recovery_phase ph
   where ph.treatment_goal_id = old.treatment_goal_id
     and ph.recovery_phase_archived_at is null;
  if goal_phase is null then
    return old;
  end if;

  select ph.recovery_phase_id into initial_phase
    from public.recovery_phase ph
   where ph.treatment_plan_id = old.treatment_plan_id
     and ph.recovery_phase_kind = 'initial'
     and ph.recovery_phase_archived_at is null;

  for activity_id in
    select a.recovery_activity_id
      from public.recovery_activity a
     where a.recovery_phase_id = goal_phase
       and a.recovery_activity_archived_at is null
     order by a.recovery_activity_order
  loop
    update public.recovery_activity a
       set recovery_phase_id = initial_phase
     where a.recovery_activity_id = activity_id;
  end loop;

  update public.recovery_phase ph
     set recovery_phase_archived_at = now()
   where ph.recovery_phase_id = goal_phase;
  return old;
end;
$$;

drop trigger if exists treatment_goal_retire_phase on public.treatment_goal;
create trigger treatment_goal_retire_phase
  before delete on public.treatment_goal
  for each row execute function public.treatment_goal_retire_phase();

revoke all on function public.recovery_roadmap_sync_from_plan() from public, anon, authenticated;
revoke all on function public.recovery_roadmap_sync_from_goal() from public, anon, authenticated;
revoke all on function public.treatment_goal_retire_phase() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Existing roadmaps
-- ---------------------------------------------------------------------------
-- Run once in effect: on a second run no current phase is without a kind,
-- every plan is already in step, and every goal phase is in place.

do $$
declare
  legacy        record;
  goal_count    integer;
  only_goal     uuid;
  initial_phase uuid;
  activity_id   uuid;
  plan_id       uuid;
begin
  -- 1. A current hand-made phase holding exactly one goal (with no phase of
  --    its own yet) becomes that goal's phase, in place. The others step
  --    aside in the order, to be emptied and archived below.
  for legacy in
    select ph.recovery_phase_id, ph.treatment_plan_id
      from public.recovery_phase ph
     where ph.recovery_phase_kind is null
       and ph.recovery_phase_archived_at is null
     order by ph.treatment_plan_id, ph.recovery_phase_order
  loop
    select count(*), min(g.treatment_goal_id::text)::uuid
      into goal_count, only_goal
      from public.treatment_goal g
     where g.recovery_phase_id = legacy.recovery_phase_id;

    if goal_count = 1
       and not exists (select 1 from public.recovery_phase x where x.treatment_goal_id = only_goal) then
      update public.recovery_phase ph
         set recovery_phase_kind = 'goal',
             treatment_goal_id = only_goal,
             recovery_phase_title = 'Recovery and Monitoring',
             recovery_phase_start_date = null,
             recovery_phase_target_end_date = (select g.treatment_goal_target_date
                                                 from public.treatment_goal g
                                                where g.treatment_goal_id = only_goal),
             recovery_phase_order = ph.recovery_phase_order + 500000
       where ph.recovery_phase_id = legacy.recovery_phase_id;
    else
      update public.recovery_phase ph
         set recovery_phase_order = ph.recovery_phase_order + 900000
       where ph.recovery_phase_id = legacy.recovery_phase_id;
    end if;
  end loop;

  -- 2. Every plan's fixed phases, and a phase for every goal still without.
  for plan_id in select tp.treatment_plan_id from public.treatment_plan tp loop
    perform app_private.sync_recovery_roadmap(plan_id);
  end loop;

  -- 3. The other hand-made phases: their current activities, in their
  --    order, join Initial Recovery; the phase is archived, never deleted.
  for legacy in
    select ph.recovery_phase_id, ph.treatment_plan_id
      from public.recovery_phase ph
     where ph.recovery_phase_kind is null
       and ph.recovery_phase_archived_at is null
     order by ph.treatment_plan_id, ph.recovery_phase_order
  loop
    select ph.recovery_phase_id into initial_phase
      from public.recovery_phase ph
     where ph.treatment_plan_id = legacy.treatment_plan_id
       and ph.recovery_phase_kind = 'initial'
       and ph.recovery_phase_archived_at is null;

    for activity_id in
      select a.recovery_activity_id
        from public.recovery_activity a
       where a.recovery_phase_id = legacy.recovery_phase_id
         and a.recovery_activity_archived_at is null
       order by a.recovery_activity_order
    loop
      update public.recovery_activity a
         set recovery_phase_id = initial_phase
       where a.recovery_activity_id = activity_id;
    end loop;

    update public.recovery_phase ph
       set recovery_phase_archived_at = now()
     where ph.recovery_phase_id = legacy.recovery_phase_id;
  end loop;

  -- 4. Goal phases numbered 2, 3, … in the order their goals were set -
  --    only those not already in place, through a free range so no two
  --    current phases ever share a place.
  create temporary table goal_phase_order on commit drop as
  select ph.recovery_phase_id,
         (row_number() over (partition by ph.treatment_plan_id
                             order by g.treatment_goal_created_at, g.treatment_goal_id) + 1)::integer as wanted
    from public.recovery_phase ph
    join public.treatment_goal g on g.treatment_goal_id = ph.treatment_goal_id
   where ph.recovery_phase_kind = 'goal'
     and ph.recovery_phase_archived_at is null;

  update public.recovery_phase ph
     set recovery_phase_order = o.wanted + 2000000
    from goal_phase_order o
   where ph.recovery_phase_id = o.recovery_phase_id
     and ph.recovery_phase_order <> o.wanted;
  update public.recovery_phase ph
     set recovery_phase_order = o.wanted
    from goal_phase_order o
   where ph.recovery_phase_id = o.recovery_phase_id
     and ph.recovery_phase_order <> o.wanted;

  drop table goal_phase_order;
end
$$;

-- ---------------------------------------------------------------------------
-- The shape, held by the database
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recovery_phase_current_has_kind'
                    and conrelid = 'public.recovery_phase'::regclass) then
    -- A current phase is a generated one; a goal phase has its goal.
    alter table public.recovery_phase
      add constraint recovery_phase_current_has_kind
      check (
        recovery_phase_archived_at is not null
        or (recovery_phase_kind is not null
            and (recovery_phase_kind = 'goal') = (treatment_goal_id is not null))
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recovery_phase_kind_order'
                    and conrelid = 'public.recovery_phase'::regclass) then
    -- Initial first, goals between, Follow-up last - whatever is written.
    alter table public.recovery_phase
      add constraint recovery_phase_kind_order
      check (
        recovery_phase_kind is null
        or (recovery_phase_kind = 'initial' and recovery_phase_order = 1)
        or (recovery_phase_kind = 'follow_up' and recovery_phase_order = 1000000)
        or (recovery_phase_kind = 'goal' and recovery_phase_order between 2 and 999999)
      );
  end if;
end
$$;

-- One Initial Recovery and one Follow-up and Assessment per plan.
create unique index if not exists recovery_phase_fixed_kind_unique
  on public.recovery_phase (treatment_plan_id, recovery_phase_kind)
  where recovery_phase_kind in ('initial', 'follow_up')
    and recovery_phase_archived_at is null;

comment on table public.recovery_phase is
  'Module 5.7 (migrations 45, 56): a treatment plan''s recovery phases - '
  'Initial Recovery, one Recovery and Monitoring per goal, Follow-up and '
  'Assessment - generated and kept in step by the database. Read by the '
  'patient and their assigned, active doctor; written by no session.';

reset lock_timeout;
