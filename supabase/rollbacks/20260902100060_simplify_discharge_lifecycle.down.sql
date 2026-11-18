-- ===========================================================================
-- Rollback of migration 60 (simplify_discharge_lifecycle)
-- ===========================================================================
-- Puts back what 59 left: the reminder functions without the care-plan
-- conditions, migration 57's functions with "ready for discharge", the
-- readiness function and its daily job; and removes the two-status
-- constraint, the helpers, the prescription trigger, the same-patient
-- foreign keys and their unique key on treatment_plan, and the care-plan
-- columns on prescriptions and appointments. Applied as a new migration,
-- with approval (tests/db/discharge-lifecycle-simplified.test.ts).
--
-- THIS RESUMES REMINDERS FOR DISCHARGED PLANS and restarts the daily
-- readiness job (which will flag plans and notify doctors again).
--
-- IT REFUSES, CHANGING NOTHING, WHILE ANY PRESCRIPTION OR APPOINTMENT IS
-- LINKED TO A CARE PLAN: dropping the columns would delete those links, and
-- links chosen by a person cannot be worked out again. First export them,
-- read-only, and keep the export:
--
--   select prescription_id, pat_id, treatment_plan_id from public.prescription where treatment_plan_id is not null;
--   select appointment_id, pat_id, treatment_plan_id from public.appointment where treatment_plan_id is not null;
--
-- then, with approval, clear them deliberately with the service role:
--
--   update public.prescription set treatment_plan_id = null where treatment_plan_id is not null;
--   update public.appointment set treatment_plan_id = null where treatment_plan_id is not null;
--
-- and run this script, as one transaction, straight after.
--
-- No other row is changed: a plan 60 moved from ready for discharge to
-- active stays active (the job decides again on its next run), and the
-- lifecycle history is kept.
--
-- Roll the website back first: from 60 on it sends and reads the columns
-- this drops.
-- ===========================================================================

set lock_timeout = '3s';

do $$
declare
  prescription_links integer;
  appointment_links  integer;
begin
  if not exists (select 1 from pg_constraint where conname = 'treatment_plan_status_valid'
                    and conrelid = 'public.treatment_plan'::regclass) then
    raise exception 'Migration 60 is not applied. Nothing was changed.';
  end if;

  -- The care-plan links are dropped with their columns below, so refuse
  -- while any exists. The share lock keeps a new link from being written
  -- between this check and the drop (held to the end of the transaction:
  -- run this script as one transaction, as apply_migration does).
  lock table public.prescription, public.appointment in share mode;
  select count(*) into prescription_links from public.prescription where treatment_plan_id is not null;
  select count(*) into appointment_links from public.appointment where treatment_plan_id is not null;
  if prescription_links > 0 or appointment_links > 0 then
    raise exception 'Rollback 60 refused: % prescription and % appointment care-plan links exist, and rolling back would delete them. Export them first (docs/deployment.md, "To roll back 31", step 60), clear them deliberately with the service role, then run the rollback again. Nothing was changed.',
      prescription_links, appointment_links
      using errcode = 'dependent_objects_still_exist';
  end if;
end
$$;

-- The four reminder readers first, as 59 and 53 left them, so nothing calls
-- a helper or column that is about to go.

create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           c.clinic_timezone as zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join public.clinic c
        on c.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- (59) The doctor has reminders on for this medicine ...
       and ms.medication_schedule_reminders_is_enabled
       -- (59) ... and the dose came due after they were last switched back on,
       -- (59) so switching them on does not chase what came due while they were off.
       and (ms.medication_schedule_reminders_enabled_at is null
            or ml.medication_log_scheduled_at >= ms.medication_schedule_reminders_enabled_at)
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone c.clinic_timezone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_follow_up_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- predicate against the just-updated row, and skips it — so two
       -- schedulers firing at once cannot double-notify.
       and ml.medication_log_follow_up_sent_at is null
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Have you taken your %s (%s)? It was due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_follow_up', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function public.dispatch_medication_pre_dose_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each clinic's lead time, as its settings hold it: 5, 10, 15 or 30
  -- minutes, and ten for anything else. Leading zeros and spaces around the
  -- number are read past, as the grace period's are.
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*(5|10|15|30)\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_lead_minutes'),
             10
           ) as lead_minutes
      from public.clinic c
  ),
  due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           r.zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join clinic_rule r
        on r.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already reminded. This is the duplicate guard.
       and ml.medication_log_pre_dose_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- (59) The doctor has reminders on for this medicine.
       and ms.medication_schedule_reminders_is_enabled
       -- Not yet due, and due within the clinic's lead time. The half hour is
       -- the longest lead time a clinic can set: it bounds the read of
       -- medication_log_due_idx to the next 30 minutes, where the slots run
       -- 30 days ahead, on a job that runs every minute.
       and ml.medication_log_scheduled_at > now()
       and ml.medication_log_scheduled_at <= now() + interval '30 minutes'
       and ml.medication_log_scheduled_at
           <= now() + make_interval(mins => r.lead_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone r.zone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_pre_dose_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot: a second
       -- run that overlaps this one re-reads the row it waited for and skips
       -- it, and a dose marked taken meanwhile is not reminded about.
       and ml.medication_log_pre_dose_sent_at is null
       and ml.medication_log_status = 'pending'
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Your %s (%s) is due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_pre_dose', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function public.dispatch_appointment_reminders(
  lead_hours integer default 24
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each message's date and time are in the clinic of the appointment's
  -- doctor - the patient's clinic too, since a patient only ever moves to a
  -- doctor in the same one.
  with due as (
    select a.appointment_id,
           a.appointment_date,
           c.clinic_timezone as zone,
           d.user_id as doctor_user_id,
           d.doc_appointment_reminder_is_enabled as doctor_wants_reminder,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
      join public.clinic  c on c.clinic_id = d.clinic_id
     where a.appointment_status in ('scheduled', 'confirmed')
       and a.appointment_reminder_sent_at is null
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select recipient.user_id, 'appointment', recipient.message,
         'appointment_reminder', 'reminder', null, due.appointment_id
    from due
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          -- The doctor's, unless they have turned their reminders off.
          due.doctor_wants_reminder,
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          -- The patient's, always.
          true,
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(is_sent, user_id, message)
   where recipient.is_sent;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;


create or replace function app_private.push_source_is_current(
  source_event  text,
  medication_log_id uuid,
  appointment_id uuid,
  due_at        timestamptz,
  owner         uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when source_event in ('medication_pre_dose', 'medication_follow_up') then exists (
      select 1
        from public.medication_log ml
        join public.medication_schedule ms on ms.medication_schedule_id = ml.medication_schedule_id
        join public.prescription pr on pr.prescription_id = ms.prescription_id
        join public.patient p on p.pat_id = pr.pat_id
       where ml.medication_log_id = push_source_is_current.medication_log_id
         and p.user_id = owner
         -- Not yet recorded (taken, skipped or missed) ...
         and ml.medication_log_status = 'pending'
         -- ... still the dose it was about, not one moved to another time ...
         and ml.medication_log_scheduled_at = due_at
         -- ... within the course's dates ...
         and ml.medication_log_dose_date >= ms.medication_schedule_start_date
         and (ms.medication_schedule_end_date is null
              or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
         -- ... and the patient still wants medication reminders.
         and p.pat_reminder_is_enabled
         -- (59) ... and the doctor has reminders on for this medicine.
         and ms.medication_schedule_reminders_is_enabled
         -- A "due soon" reminder is pointless half an hour after the dose.
         and (push_source_is_current.source_event = 'medication_follow_up'
              or now() <= ml.medication_log_scheduled_at + interval '30 minutes')
    )
    when source_event = 'appointment_reminder' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status in ('scheduled', 'confirmed')
         -- An approved reschedule moves appointment_date: the old reminder
         -- is about a time that no longer exists.
         and a.appointment_date = due_at
         and a.appointment_date > now()
    )
    when source_event = 'appointment_cancellation' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status = 'cancelled'
    )
    else false
  end
$$;


-- Migration 57's functions, as 57 left them.

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


comment on function public.doctor_discharge_treatment_plan(uuid, text) is
  'Migration 57: the patient''s assigned, active doctor discharges an active '
  'plan or one ready for discharge, with a closure reason. The patient''s '
  'account and records are untouched.';

drop trigger if exists prescription_link_care_plan on public.prescription;
drop function if exists public.prescription_link_care_plan();

drop function if exists app_private.care_reminders_allowed(uuid, uuid);
drop function if exists app_private.care_reopened_at(uuid, uuid);
drop function if exists app_private.patient_care_is_open(uuid);

drop index if exists public.prescription_treatment_plan_idx;
drop index if exists public.appointment_treatment_plan_idx;
alter table public.prescription drop constraint if exists prescription_treatment_plan_same_patient_fkey;
alter table public.appointment drop constraint if exists appointment_treatment_plan_same_patient_fkey;
alter table public.treatment_plan drop constraint if exists treatment_plan_id_pat_id_key;
alter table public.prescription drop column if exists treatment_plan_id;
alter table public.appointment drop column if exists treatment_plan_id;

alter table public.treatment_plan drop constraint if exists treatment_plan_status_valid;

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

reset lock_timeout;
