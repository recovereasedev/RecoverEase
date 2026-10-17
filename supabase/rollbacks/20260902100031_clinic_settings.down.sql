-- ===========================================================================
-- Rollback of migration 31 (clinic_settings)
-- ===========================================================================
-- Not a migration: nothing applies this automatically. Should 31 ever need
-- undoing, this is applied as a new migration with apply_migration, after
-- review and approval - never by repairing or deleting history. It returns
-- the schema to exactly what migration 30 left, which
-- tests/db/clinic-rollback.test.ts checks catalog entry by catalog entry.
--
-- Only while there is one clinic. Two clinics' settings - two time zones,
-- two chatbot prompts, two grace periods - cannot be folded back into one
-- set without silently changing one clinic's dose times, reminders, dates
-- and guidance, so with more than one this refuses and changes nothing.
--
-- Release the other way round first: the website from before 31, then
-- chatbot-reply from before 31 (it reads system_setting.clinic_id), then
-- this.
--
-- What it keeps:
--   * every setting, with its current value; the time zone in force is
--     written back to the global app.timezone row (created if it is
--     missing), so nothing that reads it moves;
--   * appointments moved with D8 stay moved, and notifications sent stay
--     sent (move appointments back the same way if needed);
--   * audit entries written since 31 keep their content, scope and clinic.
--
-- Order matters: what reads the new column or helpers is restored first,
-- then the column and helpers go.
-- ===========================================================================

do $$
declare
  clinic_count bigint;
begin
  select count(*) into clinic_count from public.clinic;
  if clinic_count <> 1 then
    raise exception 'Settings cannot be folded back into one set while % clinics exist. Nothing was changed.',
      clinic_count;
  end if;

  if exists (
    select 1 from public.system_setting
     group by system_setting_key having count(*) > 1
  ) then
    raise exception 'A setting key appears more than once. Nothing was changed.';
  end if;
end
$$;

-- D8: the move without appointments, migration 30's text.

drop function if exists public.admin_reassign_doctor_patients(uuid, uuid, integer, integer);
drop function if exists public.admin_doctor_appointment_count(uuid);
drop function if exists public.admin_set_clinic_timezone(text);
drop function if exists app_private.d8_upcoming_appointments(uuid);

create or replace function public.admin_reassign_doctor_patients(
  from_doc_id    uuid,
  to_doc_id      uuid,
  expected_count integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  this_clinic    uuid := (select app_private.admin_clinic_id());
  from_doctor    record;
  to_doctor      record;
  still_assigned integer;
  moved          integer;
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  if from_doc_id is not distinct from to_doc_id then
    raise exception 'Choose a different doctor to take over these patients'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked, so neither doctor can be reactivated, deactivated or edited
  -- between these checks and the move.
  select d.clinic_id, d.doc_is_active into from_doctor
    from public.doctor d
   where d.doc_id = from_doc_id
   for update;

  if not found or from_doctor.clinic_id is distinct from this_clinic then
    raise exception 'That doctor account could not be found'
      using errcode = 'no_data_found';
  end if;

  if from_doctor.doc_is_active then
    raise exception 'Only a deactivated doctor''s patients can be reassigned'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select d.clinic_id, d.doc_is_active into to_doctor
    from public.doctor d
    join public.user_account ua on ua.user_id = d.user_id
   where d.doc_id = to_doc_id
     and ua.user_role = 'doctor'
   for update of d;

  if not found or to_doctor.clinic_id is distinct from this_clinic then
    raise exception 'That doctor account could not be found'
      using errcode = 'no_data_found';
  end if;

  if not to_doctor.doc_is_active then
    raise exception 'Patients can only be moved to an active doctor'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The patients are locked too, then counted: the administrator confirmed a
  -- number, and a different number is not what they confirmed.
  perform 1 from public.patient p where p.doc_id = from_doc_id for update;
  select count(*)::integer into still_assigned
    from public.patient p where p.doc_id = from_doc_id;

  if still_assigned = 0 then
    raise exception 'This doctor has no patients to reassign'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if expected_count is distinct from still_assigned then
    raise exception 'The number of patients has changed since it was shown. Check it and try again.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The doctor is the only column written. Migration 27's and 29's guards
  -- run as for any other move: active doctor, same clinic.
  update public.patient set doc_id = to_doc_id where doc_id = from_doc_id;
  get diagnostics moved = row_count;

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
    audit_log_details
  )
  values (
    (select auth.uid()), 'reassign', 'doctor_patients', from_doc_id,
    jsonb_build_object(
      'from_doc_id', from_doc_id,
      'to_doc_id', to_doc_id,
      'patient_count', moved
    )
  );

  return moved;
end;
$$;

comment on function public.admin_reassign_doctor_patients(uuid, uuid, integer) is
  'D8. Moves every patient of a deactivated doctor in the caller''s clinic to '
  'an active doctor in the same clinic, if the count still matches what the '
  'Clinic Admin confirmed. Audited; authorship of clinical records is kept.';

revoke all on function
  public.admin_reassign_doctor_patients(uuid, uuid, integer)
  from public, anon;

grant execute on function
  public.admin_reassign_doctor_patients(uuid, uuid, integer)
  to authenticated;

-- Audit scope and clinic, migration 30's text.

create or replace function app_private.audit_scope_for(
  entity    text,
  entity_id uuid,
  details   jsonb
)
returns public.audit_scope
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when entity = 'clinic' then 'platform'::public.audit_scope
    when entity in ('doctor', 'doctor_account', 'doctor_patients', 'admin',
                    'announcement', 'system_setting') then 'administration'
    when entity in ('user_account', 'account_password')
         and coalesce(
               details #>> '{record,user_role}',
               details #>> '{after,user_role}',
               details #>> '{before,user_role}',
               (select ua.user_role::text from public.user_account ua
                 where ua.user_id = entity_id)
             ) in ('admin', 'doctor') then 'administration'
    else 'clinical'
  end;
$$;

comment on function app_private.audit_scope_for(text, uuid, jsonb) is
  'The scope of an audit entry, from its entity: clinic is platform; staff, '
  'announcements and settings are administration; everything else, patients '
  'and patients'' accounts included, is clinical.';

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
      when 'announcement' then
        coalesce((select an.clinic_id from public.announcement an
                   where an.announcement_id = entity_id),
                 (details #>> '{record,clinic_id}')::uuid)
      when 'user_account' then app_private.clinic_of_user(entity_id)
      when 'account_password' then app_private.clinic_of_user(entity_id)
    end,
    app_private.clinic_of_user(actor)
  );
$$;

comment on function app_private.audit_clinic_for(text, uuid, uuid, jsonb) is
  'The clinic an audit entry is about, from its entity and id, the recorded '
  'row for a deleted one, or else the actor''s clinic. NULL when none is '
  'known yet.';

drop trigger if exists announcement_author_is_fixed on public.announcement;
drop function if exists public.announcement_guard_author();

-- The ten functions, each in the text of the migration that last wrote it.

create or replace function public.app_today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (
    now() at time zone coalesce(
      (select system_setting_value
         from public.system_setting
        where system_setting_key = 'app.timezone'),
      'UTC'
    )
  )::date;
$$;

comment on function public.app_today() is
  'Current date in the clinic timezone (system_setting app.timezone). Use '
  'this instead of current_date for any user-facing calendar date: the '
  'database runs in UTC and the client sends local dates.';

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

  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  today := public.app_today();

  -- Never backfill doses the patient had no opportunity to record. "Today"
  -- has to be the clinic's today: on the UTC date the patient's current
  -- morning doses would fall before the window and never be created.
  window_from := greatest(schedule.medication_schedule_start_date, today);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    today + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  with slots as (
    -- `day::date` is load-bearing. Without it `day` is a timestamptz and the
    -- conversion below runs backwards. Do not remove it. (Migration 13.)
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

create or replace function public.extend_all_medication_log_slots(
  horizon_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule_id uuid;
  total       integer := 0;
begin
  for schedule_id in
    select ms.medication_schedule_id
      from public.medication_schedule ms
     where ms.medication_schedule_end_date is null
       -- A course ending today is still live for the whole of today, in the
       -- patient's day rather than the server's.
        or ms.medication_schedule_end_date >= public.app_today()
  loop
    total := total
      + public.generate_medication_log_slots(schedule_id, horizon_days);
  end loop;

  return total;
end;
$$;

create or replace function public.patient_validate_birth_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pat_birth_date is null then
    return new;
  end if;

  if new.pat_birth_date > public.app_today() then
    raise exception 'Date of birth cannot be in the future'
      using errcode = 'check_violation';
  end if;

  if new.pat_birth_date <= public.app_today() - interval '130 years' then
    raise exception 'Date of birth is implausibly early'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create or replace function public.recovery_log_validate_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recovery_log_date > public.app_today() then
    raise exception 'A recovery log cannot be dated in the future'
      using errcode = 'check_violation';
  end if;
  return new;
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
  zone       text;
  dispatched integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  with due as (
    select a.appointment_id,
           a.appointment_date,
           d.user_id as doctor_user_id,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
     -- Only an appointment that is still going to happen. A cancelled,
     -- completed or no_show appointment is settled, and reminding anyone
     -- about it would be worse than saying nothing.
     where a.appointment_status in ('scheduled', 'confirmed')
       -- Already reminded. This is the duplicate guard.
       and a.appointment_reminder_sent_at is null
       -- Still ahead of us: never chase an appointment that has passed,
       -- however it got left behind.
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- against the just-updated row and skips it, so two schedulers firing
       -- at once cannot double-notify.
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from due
    -- Only notify for appointments this statement actually stamped.
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message);

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

comment on function public.dispatch_appointment_reminders(integer) is
  'Creates one appointment notification for the assigned clinician and one '
  'for the patient, for each scheduled or confirmed appointment falling '
  'within lead_hours. Returns the number of notifications created (two per '
  'appointment). Idempotent: appointment_reminder_sent_at keeps each '
  'appointment to a single reminder however often this runs.';

create or replace function public.appointment_notify_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from public.patient p
    join public.doctor  d on d.doc_id = new.doc_id
    cross join lateral (
      values
        (
          d.user_id,
          format(
            'The appointment with %s on %s at %s has been cancelled.',
            trim(p.pat_first_name || ' ' || p.pat_last_name),
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          p.user_id,
          format(
            'Your appointment on %s at %s has been cancelled.',
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message)
   where p.pat_id = new.pat_id;

  return null;
end;
$$;

comment on function public.appointment_notify_cancellation() is
  'F-02. Writes one appointment notification to the patient and one to the '
  'appointment''s doctor when an upcoming appointment is cancelled. Run only '
  'by the appointment_on_cancellation trigger; it leaves earlier '
  'notifications and appointment_reminder_sent_at untouched.';

create or replace function public.medication_schedule_close_ended_doses()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

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

comment on function public.medication_schedule_close_ended_doses() is
  'QA-01/QA-02. When a schedule''s end date is set or brought earlier, removes '
  'its doses that are still pending, not yet due, and dated after the end '
  'date. Recorded doses and doses already due are never touched. Run only by '
  'the medication_schedule_close_ended_doses trigger.';

create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone       text;
  dispatched integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in clinic-local
       -- terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone zone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or (ml.medication_log_scheduled_at at time zone zone)::date
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
             due.medication_log_scheduled_at at time zone zone,
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

comment on function public.dispatch_medication_reminders(integer) is
  'Modules 4.2/4.7. Sends one follow-up notification per unrecorded dose, '
  'stamping medication_log_follow_up_sent_at in the same statement so it is '
  'idempotent and safe to run on a schedule. Honours the patient''s '
  'reminder opt-out and preferred time of day, and never chases a dose dated '
  'after its schedule''s end date.';

create or replace function public.mark_overdue_medication_logs(
  grace_hours integer default 6
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone    text;
  stored  text;
  grace   integer := grace_hours;
  updated integer;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  -- The administrator's grace period, when it is one the job can use (QA-03).
  select system_setting_value
    into stored
    from public.system_setting
   where system_setting_key = 'medication.reminder_grace_hours';

  if stored ~ '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$' then
    grace := substring(stored from '^\s*0*([1-9]|1[0-9]|2[0-4])\s*$')::integer;
  end if;

  update public.medication_log ml
     set medication_log_status = 'missed'
    from public.medication_schedule ms
   where ms.medication_schedule_id = ml.medication_schedule_id
     and ml.medication_log_status = 'pending'
     and ml.medication_log_scheduled_at
         < now() - make_interval(hours => grace)
     -- Nothing after the course's end date is written off (QA-01).
     and (ms.medication_schedule_end_date is null
          or (ml.medication_log_scheduled_at at time zone zone)::date
             <= ms.medication_schedule_end_date);

  get diagnostics updated = row_count;
  return updated;
end;
$$;

comment on function public.mark_overdue_medication_logs(integer) is
  'Marks pending doses older than the grace period as missed, except doses '
  'dated after their schedule''s end date. The grace period is the '
  'medication.reminder_grace_hours setting when it is a whole number of hours '
  'from 1 to 24; otherwise grace_hours.';

-- The settings: the time zone in force goes back into the global row, then
-- the policies are migration 06's again and the column goes.

drop trigger if exists system_setting_sync_clinic_timezone on public.system_setting;
drop function if exists public.system_setting_sync_clinic_timezone();
drop trigger if exists system_setting_assign_clinic on public.system_setting;
drop function if exists public.system_setting_assign_clinic();

do $$
declare
  the_clinic uuid;
  zone       text;
begin
  select c.clinic_id, c.clinic_timezone into the_clinic, zone from public.clinic c;

  if exists (select 1 from public.system_setting where system_setting_key = 'app.timezone') then
    update public.system_setting
       set system_setting_value = zone
     where system_setting_key = 'app.timezone'
       and system_setting_value is distinct from zone;
  else
    insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
    values (the_clinic, 'app.timezone', zone);
  end if;
end
$$;

drop policy if exists system_setting_select_admin on public.system_setting;
drop policy if exists system_setting_insert_admin on public.system_setting;
drop policy if exists system_setting_update_admin on public.system_setting;

create policy system_setting_select_admin
  on public.system_setting for select to authenticated
  using ((select app_private.is_admin()));

create policy system_setting_insert_admin
  on public.system_setting for insert to authenticated
  with check ((select app_private.is_admin()));

create policy system_setting_update_admin
  on public.system_setting for update to authenticated
  using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));

drop function if exists app_private.clinic_today(uuid);
drop function if exists app_private.clinic_timezone(uuid);

drop index if exists public.system_setting_clinic_key_unique;
alter table public.system_setting drop column if exists clinic_id;
