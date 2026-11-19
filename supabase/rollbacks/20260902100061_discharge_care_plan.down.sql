-- ===========================================================================
-- Rollback of migration 61 (discharge_care_plan)
-- ===========================================================================
-- Removes the care-plan discharge: the doctor's discharge and reopen
-- functions, the guards, the check-in guard, the follow-up mark on
-- appointments with its same-patient foreign key and the plan's
-- (plan, patient) unique key, the lifecycle history, the discharge columns
-- and constraints, and the enum value - the schema is exactly what 53 left.
--
-- It refuses, changing nothing, while any plan is discharged: no status is
-- rewritten here. The doctor reopens each one first (Reopen case), or an
-- operator decides each by hand.
--
-- Data loss: the lifecycle history and the follow-up marks are dropped with
-- their table and column. Export them first:
--
--   select * from public.treatment_plan_lifecycle_event order by treatment_plan_changed_at;
--   select appointment_id, appointment_follow_up_of_plan_id from public.appointment
--    where appointment_follow_up_of_plan_id is not null;
--
-- No patient, account, plan, appointment or check-in row is deleted.
--
-- Roll the website back first: it calls the functions this drops. Applied as
-- a new migration, with approval (tests/db/discharge-care-plan.test.ts).
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.doctor_discharge_treatment_plan(uuid, text)') is null then
    raise exception 'Migration 61 is not applied. Nothing was changed.';
  end if;
  if exists (select 1 from public.treatment_plan
              where treatment_plan_status::text = 'discharged') then
    raise exception 'Some plans are discharged; reopen each first. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

drop function if exists public.doctor_discharge_treatment_plan(uuid, text);
drop function if exists public.doctor_reopen_treatment_plan(uuid);

drop trigger if exists appointment_mark_follow_up on public.appointment;
drop function if exists public.appointment_mark_follow_up();
-- The foreign key first, then the unique key it depends on, before the
-- column goes and before the enum is rebuilt below.
alter table public.appointment drop constraint if exists appointment_follow_up_same_patient_fkey;
alter table public.treatment_plan drop constraint if exists treatment_plan_id_pat_id_key;
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
  drop constraint if exists treatment_plan_status_valid,
  drop column if exists treatment_plan_discharged_at,
  drop column if exists treatment_plan_closure_reason;

-- An enum value cannot be dropped: the type is made again with migration 1's
-- four values, and the column moved onto it. No row holds 'discharged' (the
-- check above). Migration 45's activity functions declare a variable of this
-- type; plpgsql resolves it when called, so they need no change.
alter table public.treatment_plan alter column treatment_plan_status drop default;
alter type public.treatment_plan_status rename to treatment_plan_status_61;
create type public.treatment_plan_status as enum
  ('draft', 'active', 'completed', 'cancelled');
alter table public.treatment_plan
  alter column treatment_plan_status type public.treatment_plan_status
  using treatment_plan_status::text::public.treatment_plan_status;
alter table public.treatment_plan alter column treatment_plan_status set default 'active';
drop type public.treatment_plan_status_61;

reset lock_timeout;
