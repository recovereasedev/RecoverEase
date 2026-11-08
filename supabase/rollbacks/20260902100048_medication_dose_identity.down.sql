-- ===========================================================================
-- Rollback of migration 48 (medication_dose_identity)
-- ===========================================================================
-- Removes dose identity and clock-change conflicts, and puts back the six
-- functions migration 48 replaced, exactly as migrations 31, 33 and 37 left
-- them. No dose is changed or deleted: every scheduled moment, status,
-- taken_at and reminder stamp stays as it is.
--
-- It REFUSES while any medication_dose_conflict row exists. A conflict is a
-- clinical record - an occurrence held for a doctor, or a doctor's decision
-- about it - and a rollback never deletes one. Rolling back with conflicts in
-- place needs a separately reviewed plan that keeps them.
--
-- After it, the duplicate-dose risk after a time zone change, and the silent
-- skip of a spring-forward dose time, are back. Roll the website back first:
-- from migration 48 it reads medication_dose_conflict.
--
-- Applied as a new migration, with approval
-- (tests/db/medication-dose-identity.test.ts).
-- ===========================================================================

do $$
begin
  if to_regclass('public.medication_dose_conflict') is null then
    raise exception 'Migration 48 is not applied. Nothing was changed.';
  end if;
  if exists (select 1 from public.medication_dose_conflict) then
    raise exception 'Medication dose conflicts exist. They are clinical records and a rollback never deletes them. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid)
       from cron.job j
      where j.jobname = 'recoverease-medication-conflict-alerts';
  end if;
end
$$;

drop function public.dispatch_medication_conflict_alerts();
drop function public.doctor_resolve_medication_conflict(uuid, text, timestamptz, text);

drop trigger medication_schedule_guard_shape on public.medication_schedule;
drop function public.medication_schedule_guard_shape();

drop trigger medication_log_guard_occurrence on public.medication_log;
drop function public.medication_log_guard_occurrence();

create or replace function public.generate_medication_log_slots(
  target_schedule_id uuid,
  horizon_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule    public.medication_schedule%rowtype;
  zone        text;
  today       date;
  window_from date;
  window_to   date;
  inserted    integer;
begin
  select * into schedule
    from public.medication_schedule
   where medication_schedule_id = target_schedule_id;

  if not found then
    return 0;
  end if;

  -- A dose time is a wall-clock time in the patient's clinic.
  zone := app_private.clinic_timezone(
    app_private.clinic_of_patient(
      app_private.patient_of_prescription(schedule.prescription_id)));

  today := (now() at time zone zone)::date;

  window_from := greatest(schedule.medication_schedule_start_date, today);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    today + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  with slots as (
    select ((day::date + dose_time) at time zone zone) as scheduled_at
      from generate_series(window_from, window_to, interval '1 day') as day
      cross join unnest(schedule.medication_schedule_times) as dose_time
  )
  insert into public.medication_log (
    medication_schedule_id, medication_log_scheduled_at
  )
  select target_schedule_id, scheduled_at
    from slots
  on conflict (medication_schedule_id, medication_log_scheduled_at)
    do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function public.medication_schedule_close_ended_doses()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  zone := app_private.clinic_timezone(
    app_private.clinic_of_patient(
      app_private.patient_of_prescription(new.prescription_id)));

  -- Only doses still waiting to come due: pending, and in the future. The end
  -- date is a clinic-local date, so each dose is compared in clinic time.
  delete from public.medication_log
   where medication_schedule_id = new.medication_schedule_id
     and medication_log_status = 'pending'
     and medication_log_scheduled_at > now()
     and (medication_log_scheduled_at at time zone zone)::date
         > new.medication_schedule_end_date;

  return null;
end;
$$;

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
            or (ml.medication_log_scheduled_at at time zone c.clinic_timezone)::date
               <= ms.medication_schedule_end_date)
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
    user_id, notification_type, notification_message
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
         )
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function public.mark_overdue_medication_logs(
  grace_hours integer default 6
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated integer;
begin
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_grace_hours'),
             grace_hours
           ) as grace
      from public.clinic c
  )
  update public.medication_log ml
     set medication_log_status = 'missed'
    from public.medication_schedule ms
    join public.prescription pr on pr.prescription_id = ms.prescription_id
    join public.patient p on p.pat_id = pr.pat_id
    join public.doctor d on d.doc_id = p.doc_id
    join clinic_rule r on r.clinic_id = d.clinic_id
   where ms.medication_schedule_id = ml.medication_schedule_id
     and ml.medication_log_status = 'pending'
     and ml.medication_log_scheduled_at
         < now() - make_interval(hours => r.grace)
     -- Nothing after the course's end date is written off (QA-01).
     and (ms.medication_schedule_end_date is null
          or (ml.medication_log_scheduled_at at time zone r.zone)::date
             <= ms.medication_schedule_end_date);

  get diagnostics updated = row_count;
  return updated;
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
            or (ml.medication_log_scheduled_at at time zone r.zone)::date
               <= ms.medication_schedule_end_date)
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
    user_id, notification_type, notification_message
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
         )
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function app_private.audit_clinic_for(
  entity    text,
  entity_id uuid,
  actor     uuid,
  details   jsonb
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case entity
      when 'clinic' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_settings' then
        (select c.clinic_id from public.clinic c where c.clinic_id = entity_id)
      when 'clinic_admin_account' then
        coalesce((select a.clinic_id from public.admin a where a.admin_id = entity_id),
                 (details ->> 'clinic_id')::uuid)
      when 'doctor' then
        coalesce(app_private.clinic_of_doctor(entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'doctor_account' then app_private.clinic_of_doctor(entity_id)
      when 'doctor_patients' then app_private.clinic_of_doctor(entity_id)
      when 'patient' then app_private.clinic_of_patient(entity_id)
      when 'patient_account' then app_private.clinic_of_patient(entity_id)
      when 'prescription' then
        app_private.clinic_of_patient(app_private.patient_of_prescription(entity_id))
      when 'treatment_plan' then
        app_private.clinic_of_patient(app_private.patient_of_treatment_plan(entity_id))
      when 'appointment' then
        app_private.clinic_of_patient(app_private.patient_of_appointment(entity_id))
      when 'announcement' then
        coalesce((select an.clinic_id from public.announcement an
                   where an.announcement_id = entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'system_setting' then
        coalesce((select s.clinic_id from public.system_setting s
                   where s.system_setting_id = entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'user_account' then app_private.clinic_of_user(entity_id)
      when 'account_password' then app_private.clinic_of_user(entity_id)
    end,
    app_private.clinic_of_user(actor)
  );
$$;

drop function app_private.lock_medication_schedule(uuid);
drop function app_private.medication_clock_policy(text);

drop table public.medication_dose_conflict;
drop type public.medication_conflict_resolution;
drop type public.medication_conflict_reason;

drop index public.medication_log_occurrence_key;
alter table public.medication_log
  drop column medication_log_dose_date,
  drop column medication_log_dose_time;

reset lock_timeout;
