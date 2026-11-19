-- ===========================================================================
-- Rollback of migration 55 (treatment_goal_progress)
-- ===========================================================================
-- Removes the missed-goal job and its schedule, the patient's progress
-- function and the guard on a goal's status, and puts the history's writer
-- back as migration 45 left it. Goals keep the status they have, and every
-- history event stays; only the `treatment_goal_change_source` column is
-- dropped, so events written while 55 was live keep their actor
-- (`treatment_goal_changed_by`) but no longer say 'system' or 'service'.
-- Applied as a new migration, with approval
-- (tests/db/treatment-goal-progress.test.ts).
--
-- Roll the website back first: its patient screen calls the function this
-- removes.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.mark_missed_treatment_goals()') is null then
    raise exception 'Migration 55 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the trigger and the column locks `treatment_goal` and its
-- history. Waiting at most 3 seconds for those locks, the rollback fails
-- rather than holding the website up behind it. It comes after the check, so
-- a refusal changes no setting, and it is reset at the end.
set lock_timeout = '3s';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid)
       from cron.job j
      where j.jobname = 'recoverease-mark-missed-treatment-goals';
  end if;
end
$$;

drop function if exists public.mark_missed_treatment_goals();
drop index if exists public.treatment_goal_open_target_idx;
drop function if exists public.patient_update_treatment_goal_status(uuid, public.treatment_goal_status);
drop trigger if exists treatment_goal_guard_progress on public.treatment_goal;
drop function if exists public.treatment_goal_guard_progress();

-- Migration 45's writer, unchanged.
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

revoke all on function public.treatment_goal_record_status() from public, anon, authenticated;

alter table public.treatment_goal_status_event
  drop column if exists treatment_goal_change_source;

reset lock_timeout;
