-- ===========================================================================
-- Rollback of migration 45 (recovery_roadmap)
-- ===========================================================================
-- Removes the recovery roadmap: every phase, every activity, every record of
-- an activity marked done or undone, and every recorded change of a goal's
-- status are gone for good. Each treatment plan and treatment goal stays,
-- with its current status; a goal's link to its phase goes. Applied as a new
-- migration, with approval (tests/db/recovery-roadmap.test.ts).
--
-- Roll the website back first: from migration 45 the Recovery roadmap page,
-- the record's roadmap editor and the progress panel's roadmap view read
-- these tables and call these functions; without them each says it could
-- not load.
-- ===========================================================================

do $$
begin
  if to_regclass('public.recovery_phase') is null then
    raise exception 'Migration 45 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the goal's column, foreign key and triggers locks
-- `treatment_goal`. Waiting at most 3 seconds for that lock, the rollback
-- fails rather than holding the website up behind it (docs/deployment.md,
-- "Migration timing and run history"). A plain SET, not SET LOCAL, so it
-- holds whether or not the runner wraps this file in one transaction. It
-- comes after the check, so a refusal changes no setting, and it is reset
-- at the end.
set lock_timeout = '3s';

drop function if exists public.patient_complete_recovery_activity(uuid);
drop function if exists public.patient_reopen_recovery_activity(uuid);
drop function if exists public.doctor_reorder_recovery_phases(uuid, uuid[]);
drop function if exists public.doctor_reorder_recovery_activities(uuid, uuid[]);

drop trigger if exists treatment_goal_record_status on public.treatment_goal;
drop trigger if exists treatment_goal_check_phase on public.treatment_goal;
drop function if exists public.treatment_goal_record_status();
drop function if exists public.treatment_goal_check_phase();

alter table public.treatment_goal drop constraint if exists treatment_goal_phase_in_plan;
drop index if exists public.treatment_goal_phase_idx;
alter table public.treatment_goal drop column if exists recovery_phase_id;

drop table if exists public.treatment_goal_status_event;
drop table if exists public.recovery_activity_event;
drop table if exists public.recovery_activity;
drop table if exists public.recovery_phase;
drop type if exists public.recovery_activity_event_kind;

drop function if exists public.recovery_activity_prepare();
drop function if exists public.recovery_phase_release_goals();
drop function if exists public.recovery_phase_prepare();
drop function if exists app_private.patient_of_recovery_phase(uuid);
drop function if exists app_private.patient_of_recovery_activity(uuid);
drop function if exists app_private.patient_of_treatment_goal(uuid);

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
