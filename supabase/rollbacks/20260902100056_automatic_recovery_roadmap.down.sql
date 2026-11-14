-- ===========================================================================
-- Rollback of migration 56 (automatic_recovery_roadmap)
-- ===========================================================================
-- Puts the roadmap back as migration 45 left it: the doctor builds phases by
-- hand again (insert and update policies, doctor_reorder_recovery_phases(),
-- goals released when their phase is archived), and the generator, its
-- triggers, the phase kind and goal columns and the plan's follow-up
-- appointment column are removed.
--
-- Rows stay as they are: every generated phase stays as an ordinary phase
-- (in the same order, with its activities and their history), phases 56
-- archived stay archived, and activities 56 moved to Initial Recovery stay
-- there. Only the follow-up appointment chosen for a plan is lost (the
-- appointment itself is untouched). Applied as a new migration, with
-- approval (tests/db/automatic-recovery-roadmap.test.ts).
--
-- Roll the website back first: from 56 on it reads the dropped columns and
-- shows no phase controls.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'recovery_phase' and column_name = 'recovery_phase_kind'
  ) then
    raise exception 'Migration 56 is not applied. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

drop trigger if exists treatment_plan_sync_roadmap on public.treatment_plan;
drop trigger if exists treatment_goal_sync_roadmap on public.treatment_goal;
drop trigger if exists treatment_goal_retire_phase on public.treatment_goal;
drop trigger if exists treatment_goal_keep_roadmap on public.treatment_goal;
drop function if exists public.recovery_roadmap_sync_from_plan();
drop function if exists public.recovery_roadmap_sync_from_goal();
drop function if exists public.treatment_goal_retire_phase();
drop function if exists public.treatment_goal_keep_roadmap();
drop function if exists app_private.sync_recovery_roadmap(uuid);

alter table public.treatment_plan
  drop column if exists treatment_plan_follow_up_appointment_id;
alter table public.appointment
  drop constraint if exists appointment_id_patient_unique;

drop index if exists public.recovery_phase_fixed_kind_unique;
alter table public.recovery_phase
  drop constraint if exists recovery_phase_kind_order,
  drop constraint if exists recovery_phase_current_has_kind,
  drop constraint if exists recovery_phase_goal_unique,
  drop constraint if exists recovery_phase_goal_fk,
  drop constraint if exists recovery_phase_kind_valid,
  drop column if exists treatment_goal_id,
  drop column if exists recovery_phase_kind;

comment on table public.recovery_phase is
  'Module 5.7 (migration 45): a treatment plan''s recovery phases, in order. '
  'Written by the patient''s assigned, active doctor; read by them and the '
  'patient. Archived, never deleted, through the website.';

-- Supabase's default table privileges, as before 56 (UPDATE was kept).
grant insert, delete, truncate on public.recovery_phase to anon, authenticated;

-- Migration 45's phase policies, functions and trigger, unchanged.
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

revoke all on function public.recovery_phase_prepare() from public, anon, authenticated;
revoke all on function public.recovery_phase_release_goals() from public, anon, authenticated;
revoke all on function public.recovery_activity_prepare() from public, anon, authenticated;

create or replace function public.doctor_reorder_recovery_phases(target_plan_id uuid, phase_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  locked_ids uuid[];
begin
  if not (select app_private.is_my_patient((select app_private.patient_of_treatment_plan(target_plan_id)))) then
    raise exception 'Only the patient''s assigned doctor can change their roadmap'
      using errcode = 'insufficient_privilege';
  end if;
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into locked_ids
    from (select ph.recovery_phase_id as id
            from public.recovery_phase ph
           where ph.treatment_plan_id = target_plan_id
             and ph.recovery_phase_archived_at is null
             for update) as locked;

  if phase_ids is null
     or cardinality(phase_ids) <> (select count(distinct id) from unnest(phase_ids) as id)
     or locked_ids is distinct from
        (select coalesce(array_agg(id order by id), '{}') from unnest(phase_ids) as id) then
    raise exception 'The new order must list each of the plan''s current phases once'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.recovery_phase ph
     set recovery_phase_order = ph.recovery_phase_order + 100000
   where ph.recovery_phase_id = any (locked_ids);
  update public.recovery_phase ph
     set recovery_phase_order = o.position
    from unnest(phase_ids) with ordinality as o(id, position)
   where ph.recovery_phase_id = o.id
     and ph.recovery_phase_id = any (locked_ids)
     and ph.treatment_plan_id = target_plan_id
     and ph.recovery_phase_archived_at is null;
end;
$$;

revoke all on function public.doctor_reorder_recovery_phases(uuid, uuid[]) from public, anon;
grant execute on function public.doctor_reorder_recovery_phases(uuid, uuid[]) to authenticated;

comment on function public.doctor_reorder_recovery_phases(uuid, uuid[]) is
  'Module 5.7 (migration 45): the assigned doctor puts a plan''s current '
  'phases in a new order, in one call.';

reset lock_timeout;
