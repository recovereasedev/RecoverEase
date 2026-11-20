-- ===========================================================================
-- Rollback of migration 63 (patient_care_lifecycle)
-- ===========================================================================
-- Removes the patient-level care lifecycle: the doctor's discharge and
-- reopen functions, the care columns and their guard, the care history, the
-- read-only guards on plans, goals and the roadmap, and the follow-up mark on
-- appointments with its same-patient foreign key. Migration 61's check-in
-- guard and follow-up trigger are put back exactly as 61 wrote them, so the
-- schema is exactly what 62 left.
--
-- It refuses, changing nothing, while any patient is discharged (the doctor
-- reopens each first), or while migration 64 or later is applied (roll those
-- back first: 64's missed-goal job reads the patient's care).
--
-- Data loss: the care history and the care follow-up marks are dropped with
-- their table and column. Export them first:
--
--   select * from public.patient_care_event order by patient_care_changed_at;
--   select appointment_id, appointment_follow_up_of_care_event_id from public.appointment
--    where appointment_follow_up_of_care_event_id is not null;
--
-- No patient, account, plan, appointment or check-in row is deleted.
--
-- Roll the website back first: it calls the functions this drops. Applied as
-- a new migration, with approval (tests/db/patient-care-lifecycle.test.ts).
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.doctor_discharge_patient_care(uuid, text)') is null then
    raise exception 'Migration 63 is not applied. Nothing was changed.';
  end if;
  if to_regprocedure('public.mark_missed_treatment_goals()') is not null then
    raise exception 'Migration 64 is applied; roll it back first. Nothing was changed.';
  end if;
  if exists (select 1 from public.patient where pat_care_status = 'discharged') then
    raise exception 'Some patients are discharged; reopen each first. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

drop function if exists public.doctor_discharge_patient_care(uuid, text);
drop function if exists public.doctor_reopen_patient_care(uuid);

drop trigger if exists treatment_plan_guard_care_ended on public.treatment_plan;
drop trigger if exists treatment_goal_guard_care_ended on public.treatment_goal;
drop trigger if exists recovery_phase_guard_care_ended on public.recovery_phase;
drop trigger if exists recovery_activity_guard_care_ended on public.recovery_activity;
drop function if exists public.care_record_guard_discharged();

-- Migration 61's check-in guard and follow-up trigger, unchanged.
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
                            and open_plan.treatment_plan_status::text = 'active')
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

comment on column public.appointment.appointment_follow_up_of_plan_id is
  'Migration 61: the discharged plan this appointment follows up, set by the '
  'database when the patient booked it after their care ended; null otherwise.';

alter table public.appointment drop constraint if exists appointment_follow_up_care_same_patient_fkey;
drop index if exists public.appointment_follow_up_of_care_event_idx;
alter table public.appointment drop column if exists appointment_follow_up_of_care_event_id;

drop function if exists app_private.patient_current_discharge_event(uuid);
drop function if exists app_private.patient_care_is_discharged(uuid, boolean);

drop trigger if exists patient_guard_care on public.patient;
drop function if exists public.patient_guard_care();
drop trigger if exists patient_record_care_event on public.patient;
drop function if exists public.patient_record_care_event();
drop table if exists public.patient_care_event;
drop function if exists public.patient_care_event_append_only();

alter table public.patient
  drop constraint if exists patient_care_discharge_complete,
  drop constraint if exists patient_care_closure_reason_valid,
  drop constraint if exists patient_care_status_valid,
  drop column if exists pat_care_discharged_at,
  drop column if exists pat_care_closure_reason,
  drop column if exists pat_care_status;

reset lock_timeout;
