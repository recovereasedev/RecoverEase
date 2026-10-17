-- ===========================================================================
-- RecoverEase — 24. Settings and time belong to the clinic
-- ===========================================================================
-- Phase A, step 4 (decision D3). Until now the settings were one platform-wide
-- set, and every date and time the database works out - "today", dose slots,
-- reminders, the missed-dose cut-off, the dates in a notification - was in
-- the zone stored there. Each is now the patient's clinic's:
--
--   * `system_setting.clinic_id`: every setting is a clinic's. The three that
--     exist become Harborview's, values untouched. A Clinic Admin reads and
--     writes only their clinic's, and the clinic is set from who is writing,
--     never from the request.
--   * `clinic.clinic_timezone` is the only time zone anything reads. The ten
--     functions that used `app.timezone` resolve the clinic from their own
--     row: a dose through its prescription's patient, an appointment through
--     its doctor, a patient through their doctor.
--   * The missed-dose grace period is read per clinic.
--   * An announcement keeps the author and clinic it was written with.
--   * Decision D8, option A: a deactivated doctor's upcoming appointments
--     move with their patients, or nothing moves.
--
-- What stays, deliberately:
--
--   * The single-clinic gate. It is lifted only by the later migration that
--     creates clinics, once everything reading a setting is known to be
--     clinic-aware - the deployed chatbot among them.
--   * `system_setting_key_unique`. The deployed settings screen saves with
--     ON CONFLICT on the key alone; it goes when the gate does.
--   * The `app.timezone` row, as an alias read by nothing: the deployed
--     settings screen still edits the time zone there, so a save to it is
--     passed through to the clinic. It goes when the gate does.
--   * `doctor_assign_single_clinic`, migration 29's default for a doctor
--     inserted without a clinic. It refuses once there are two.
--
-- The data step runs once and changes nothing but the new column: it refuses
-- to start if the time zone setting and the clinic disagree, and compares
-- every setting before and after.
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100031_clinic_settings.down.sql, applied as a new
-- migration with approval, and only while there is one clinic: two clinics'
-- settings cannot be folded back into one set. tests/db/clinic-rollback.test.ts
-- proves it returns the schema to exactly what migration 30 left.
-- ===========================================================================

-- Before anything is created: 30 must be in, and 31 not yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'audit_log' and column_name = 'audit_scope'
  ) then
    raise exception 'Migration 31 needs migration 30 first. Nothing was applied.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 31 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The data step: every existing setting becomes the one clinic's
-- ---------------------------------------------------------------------------
-- The column is added with the clinic as its default, so the existing rows
-- take it without being updated: no setting is rewritten, no trigger fires
-- and nothing is audited. The default is then dropped.

do $$
declare
  the_clinic     uuid;
  clinic_count   bigint;
  clinic_zone    text;
  setting_zone   text;
  before_rows    text;
  before_count   bigint;
begin
  lock table public.system_setting in access exclusive mode;
  lock table public.clinic in share row exclusive mode;

  select count(*) into clinic_count from public.clinic;
  if clinic_count <> 1 then
    raise exception 'Migration 31 expects exactly one clinic, found %. Nothing was applied.',
      clinic_count;
  end if;
  select c.clinic_id, c.clinic_timezone into the_clinic, clinic_zone from public.clinic c;

  -- From here the clinic's zone is the only one. If the setting said
  -- something else, the dates the application works out would move.
  select btrim(s.system_setting_value) into setting_zone
    from public.system_setting s
   where s.system_setting_key = 'app.timezone';

  if setting_zone is not null and setting_zone <> clinic_zone then
    raise exception 'The time zone setting (%) and the clinic''s time zone (%) differ. Migration 31 changed nothing.',
      setting_zone, clinic_zone;
  end if;

  select count(*),
         md5(coalesce(string_agg(row(s.system_setting_id, s.admin_id, s.system_setting_key,
                                     s.system_setting_value, s.system_setting_updated_at)::text,
                                 '|' order by s.system_setting_id), ''))
    into before_count, before_rows
    from public.system_setting s;

  execute format(
    'alter table public.system_setting
       add column clinic_id uuid not null default %L
         references public.clinic (clinic_id) on delete restrict',
    the_clinic
  );
  alter table public.system_setting alter column clinic_id drop default;

  if (select count(*) from public.system_setting) <> before_count
     or (select md5(coalesce(string_agg(row(s.system_setting_id, s.admin_id, s.system_setting_key,
                                            s.system_setting_value, s.system_setting_updated_at)::text,
                                        '|' order by s.system_setting_id), ''))
           from public.system_setting s) <> before_rows
     or exists (select 1 from public.system_setting s where s.clinic_id is distinct from the_clinic) then
    raise exception 'Migration 31 would have changed a setting. Nothing was applied.';
  end if;
end;
$$;

-- One of each setting per clinic. The key-only index stays beside it until
-- the gate is lifted (above).
create unique index if not exists system_setting_clinic_key_unique
  on public.system_setting (clinic_id, system_setting_key);

comment on column public.system_setting.clinic_id is
  'The clinic the setting belongs to, set from the Clinic Admin who writes '
  'it, never from the request. ON DELETE RESTRICT: a clinic with settings is '
  'deactivated, never deleted.';

-- ---------------------------------------------------------------------------
-- A clinic's time zone, and its "today"
-- ---------------------------------------------------------------------------

create or replace function app_private.clinic_timezone(target_clinic_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  select c.clinic_timezone into zone
    from public.clinic c
   where c.clinic_id = target_clinic_id;

  -- Never a fallback zone: a date worked out in the wrong one is a dose at
  -- the wrong hour.
  if zone is null then
    raise exception 'The clinic''s time zone could not be found'
      using errcode = 'no_data_found';
  end if;

  return zone;
end;
$$;

comment on function app_private.clinic_timezone(uuid) is
  'A clinic''s time zone, the only one any date or time is worked out in. '
  'Raises rather than guessing when the clinic is unknown.';

create or replace function app_private.clinic_today(target_clinic_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone app_private.clinic_timezone(target_clinic_id))::date;
$$;

comment on function app_private.clinic_today(uuid) is
  'The current date in a clinic''s time zone.';

revoke all on function app_private.clinic_timezone(uuid) from public;
revoke all on function app_private.clinic_today(uuid) from public;
grant execute on function app_private.clinic_timezone(uuid) to authenticated, service_role;
grant execute on function app_private.clinic_today(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A setting takes its clinic from whoever writes it
-- ---------------------------------------------------------------------------
-- A Clinic Admin's setting is their clinic's, whatever the request says. A
-- server-side write - the service key, a migration - names its clinic, and
-- may leave it out only while there is a single clinic to mean.
--
-- `app.timezone` is the alias described above: a value saved there by the
-- deployed settings screen is passed on to the clinic, where
-- clinic_validate_timezone refuses a zone that does not exist - and with it
-- the save.

create or replace function public.system_setting_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_clinic uuid := app_private.admin_clinic_id();
  clinic_count  bigint;
begin
  if tg_op = 'INSERT' then
    if caller_clinic is not null then
      new.clinic_id := caller_clinic;
    elsif new.clinic_id is null and (select auth.uid()) is null then
      -- Anyone else signed in gets no clinic, and the policy refuses them.
      select count(*) into clinic_count from public.clinic;
      if clinic_count <> 1 then
        raise exception
          'A setting needs a clinic, and with % clinics none can be assumed',
          clinic_count
          using errcode = 'not_null_violation';
      end if;
      select c.clinic_id into new.clinic_id from public.clinic c;
    end if;
  elsif new.clinic_id is distinct from old.clinic_id then
    raise exception 'A setting stays with the clinic it belongs to'
      using errcode = 'insufficient_privilege';
  end if;

  if new.system_setting_key = 'app.timezone' then
    new.system_setting_value := btrim(new.system_setting_value);

    if tg_op = 'INSERT'
       or new.system_setting_value is distinct from old.system_setting_value then
      update public.clinic
         set clinic_timezone = new.system_setting_value
       where clinic_id = new.clinic_id
         and clinic_timezone is distinct from new.system_setting_value;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.system_setting_assign_clinic() is
  'Gives a new setting its clinic - the writing Clinic Admin''s, or the only '
  'one for a server-side write - keeps it there, and passes a time zone saved '
  'as app.timezone on to the clinic. Run only by its trigger.';

drop trigger if exists system_setting_assign_clinic on public.system_setting;
create trigger system_setting_assign_clinic
  before insert or update on public.system_setting
  for each row execute function public.system_setting_assign_clinic();

revoke all on function public.system_setting_assign_clinic() from public, anon, authenticated;

-- The three settings policies: the caller's clinic, where they were every
-- administrator's.
drop policy if exists system_setting_select_admin on public.system_setting;
create policy system_setting_select_admin
  on public.system_setting for select to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()));

drop policy if exists system_setting_insert_admin on public.system_setting;
create policy system_setting_insert_admin
  on public.system_setting for insert to authenticated
  with check (clinic_id = (select app_private.admin_clinic_id()));

drop policy if exists system_setting_update_admin on public.system_setting;
create policy system_setting_update_admin
  on public.system_setting for update to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()))
  with check (clinic_id = (select app_private.admin_clinic_id()));

-- ---------------------------------------------------------------------------
-- The Clinic Admin sets their clinic's time zone
-- ---------------------------------------------------------------------------
-- The settings screen's way to change it. Audited as an administration entry
-- the Clinic Admin can read; the clinic row's own audit entry is a platform
-- one. While the alias exists it is kept in step, so the screen deployed
-- before this migration shows the same zone.

create or replace function public.admin_set_clinic_timezone(new_timezone text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  this_clinic uuid := (select app_private.admin_clinic_id());
  zone        text := btrim(new_timezone);
  previous    text;
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  if zone is null or zone = '' then
    raise exception 'Enter a time zone, such as Asia/Manila'
      using errcode = 'check_violation';
  end if;

  select c.clinic_timezone into previous
    from public.clinic c
   where c.clinic_id = this_clinic
   for update;

  if previous is distinct from zone then
    -- clinic_validate_timezone refuses a zone that does not exist.
    update public.clinic set clinic_timezone = zone where clinic_id = this_clinic;

    insert into public.audit_log (
      user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
      audit_log_details
    )
    values (
      (select auth.uid()), 'update', 'clinic_settings', this_clinic,
      jsonb_build_object(
        'changed_columns', jsonb_build_array('clinic_timezone'),
        'before', jsonb_build_object('clinic_timezone', previous),
        'after', jsonb_build_object('clinic_timezone', zone)
      )
    );
  end if;

  -- The alias, kept in step - or brought back into it - whether or not the
  -- zone changed.
  update public.system_setting
     set system_setting_value = zone,
         admin_id = (select app_private.current_admin_id())
   where clinic_id = this_clinic
     and system_setting_key = 'app.timezone'
     and system_setting_value is distinct from zone;

  return zone;
end;
$$;

comment on function public.admin_set_clinic_timezone(text) is
  'Sets the caller''s clinic''s time zone, for Clinic Admins only. Audited.';

-- ---------------------------------------------------------------------------
-- The ten functions that work out a date or a time
-- ---------------------------------------------------------------------------
-- Same signatures, same privileges, same results for a clinic in the zone
-- app.timezone named. Only where the zone comes from changes.

-- "Today" for whoever is asking: their clinic's. With no member asking - a
-- cron job, the service key, a migration - there is one answer only while
-- there is one clinic; with more, the caller must say whose day it means.
create or replace function public.app_today()
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  this_clinic  uuid := app_private.current_clinic_id();
  clinic_count bigint;
begin
  if this_clinic is null then
    select count(*) into clinic_count from public.clinic;
    if clinic_count <> 1 then
      raise exception
        'With % clinics, app_today() needs a signed-in member; use app_private.clinic_today()',
        clinic_count
        using errcode = 'invalid_parameter_value';
    end if;
    select c.clinic_id into this_clinic from public.clinic c;
  end if;

  return app_private.clinic_today(this_clinic);
end;
$$;

comment on function public.app_today() is
  'Current date in the caller''s clinic''s time zone. Use this instead of '
  'current_date for any user-facing "today". Without a signed-in member it '
  'answers only while there is a single clinic.';

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
  -- Each schedule's end date is a date in its own patient's clinic.
  for schedule_id in
    select ms.medication_schedule_id
      from public.medication_schedule ms
      join public.prescription pr on pr.prescription_id = ms.prescription_id
      join public.patient p on p.pat_id = pr.pat_id
      join public.doctor d on d.doc_id = p.doc_id
      join public.clinic c on c.clinic_id = d.clinic_id
     where ms.medication_schedule_end_date is null
        or ms.medication_schedule_end_date >= (now() at time zone c.clinic_timezone)::date
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
declare
  today date;
begin
  if new.pat_birth_date is null then
    return new;
  end if;

  -- The patient's clinic's today: their doctor's.
  today := app_private.clinic_today(app_private.clinic_of_doctor(new.doc_id));

  if new.pat_birth_date > today then
    raise exception 'Date of birth cannot be in the future'
      using errcode = 'check_violation';
  end if;

  if new.pat_birth_date <= today - interval '130 years' then
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
  if new.recovery_log_date
     > app_private.clinic_today(app_private.clinic_of_patient(new.pat_id)) then
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
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from due
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message);

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

create or replace function public.appointment_notify_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  zone := app_private.clinic_timezone(app_private.clinic_of_doctor(new.doc_id));

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

-- The grace period is each clinic's own (QA-03): its setting when it is one
-- the job can use, the cron job's argument otherwise.
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

comment on function public.mark_overdue_medication_logs(integer) is
  'Marks pending doses older than their clinic''s grace period as missed, '
  'except doses dated after their course''s end date. The grace period is the '
  'clinic''s medication.reminder_grace_hours when it is a whole number from 1 '
  'to 24, and grace_hours otherwise.';

-- ---------------------------------------------------------------------------
-- An announcement keeps its author and clinic
-- ---------------------------------------------------------------------------
-- Before a second clinic can exist: an administrator could otherwise put a
-- colleague's name, or another clinic, on an announcement they can edit.

create or replace function public.announcement_guard_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.admin_id is distinct from old.admin_id
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'An announcement keeps the author and clinic it was written with'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.announcement_guard_author() is
  'Refuses any change to an announcement''s author or clinic. Run only by the '
  'announcement_author_is_fixed trigger.';

drop trigger if exists announcement_author_is_fixed on public.announcement;
create trigger announcement_author_is_fixed
  before update of admin_id, clinic_id on public.announcement
  for each row execute function public.announcement_guard_author();

revoke all on function public.announcement_guard_author() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit entries for what this migration adds
-- ---------------------------------------------------------------------------
-- A setting, a moved appointment and a clinic's time zone each resolve to
-- their own clinic. A clinic's settings are administration; an appointment,
-- like anything else about a patient, stays clinical.

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
                    'announcement', 'system_setting', 'clinic_settings') then 'administration'
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
  'announcements and a clinic''s settings are administration; everything '
  'else, patients and patients'' accounts included, is clinical.';

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

comment on function app_private.audit_clinic_for(text, uuid, uuid, jsonb) is
  'The clinic an audit entry is about, from its entity and id, the recorded '
  'row for a deleted one, or else the actor''s clinic. NULL when none is '
  'known yet.';

-- ---------------------------------------------------------------------------
-- D8, option A: upcoming appointments move with their patients
-- ---------------------------------------------------------------------------
-- Moving a deactivated doctor's patients used to leave their upcoming
-- appointments booked with that doctor: reminders went to an account that
-- can no longer act, and the patient was expected by someone who will not be
-- there. Now each scheduled or confirmed appointment still to come moves to
-- the new doctor in the same transaction. Past, completed, cancelled and
-- no-show appointments keep the doctor they were with: they are history.
--
-- The Clinic Admin confirms both numbers, and both are re-checked under lock.
-- Nothing moves if any appointment would clash - the new doctor already has
-- a booking at that time, the patient has another, or two of the moving
-- appointments are at the same time. There is no duration yet, so a clash is
-- the same start time. Reminders already sent are not sent again; pending
-- reschedule requests stay with their appointment, for the new doctor to
-- decide. The patient and the new doctor are told about each appointment.

-- Which appointments move: the deactivated doctor's patients' appointments
-- still booked with that doctor, scheduled or confirmed, still to come. One
-- definition, so the number the Clinic Admin confirms is the set that moves.
create or replace function app_private.d8_upcoming_appointments(from_doc_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.appointment_id
    from public.appointment a
    join public.patient p on p.pat_id = a.pat_id
   where p.doc_id = from_doc_id
     and a.doc_id = from_doc_id
     and a.appointment_status in ('scheduled', 'confirmed')
     and a.appointment_date > now();
$$;

comment on function app_private.d8_upcoming_appointments(uuid) is
  'D8. The appointments that move with a deactivated doctor''s patients.';

revoke all on function app_private.d8_upcoming_appointments(uuid) from public;

create or replace function public.admin_doctor_appointment_count(target_doc_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  this_clinic uuid := (select app_private.admin_clinic_id());
  doctor_row  record;
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  select d.clinic_id, d.doc_is_active into doctor_row
    from public.doctor d
   where d.doc_id = target_doc_id;

  if not found or doctor_row.clinic_id is distinct from this_clinic then
    raise exception 'That doctor account could not be found'
      using errcode = 'no_data_found';
  end if;

  if doctor_row.doc_is_active then
    raise exception 'Only a deactivated doctor''s patients can be reassigned'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return (select count(*)::integer
            from app_private.d8_upcoming_appointments(target_doc_id));
end;
$$;

comment on function public.admin_doctor_appointment_count(uuid) is
  'D8. How many upcoming appointments would move with a deactivated doctor''s '
  'patients. A count only, for Clinic Admins only.';

-- A fourth argument, the appointment count the Clinic Admin confirmed. The
-- reassignment dialog deployed before this migration does not send it; for
-- that dialog the move goes ahead only when there are no appointments to
-- move, so none is ever moved without being confirmed.
drop function if exists public.admin_reassign_doctor_patients(uuid, uuid, integer);

create or replace function public.admin_reassign_doctor_patients(
  from_doc_id                uuid,
  to_doc_id                  uuid,
  expected_count             integer,
  expected_appointment_count integer default null
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
  moving         uuid[];
  clashes        integer;
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
  -- between these checks and the move. Locking the new doctor also holds
  -- back any appointment being booked with them meanwhile.
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

  -- Their upcoming appointments with this doctor, locked the same way, and
  -- the new doctor's, so neither side's diary changes under the check.
  perform 1
     from public.appointment a
    where a.appointment_id in (select id from app_private.d8_upcoming_appointments(from_doc_id) as id)
      for update;
  perform 1
     from public.appointment a
    where a.doc_id = to_doc_id
      and a.appointment_status in ('scheduled', 'confirmed')
      and a.appointment_date > now()
      for update;

  select coalesce(array_agg(a.appointment_id order by a.appointment_date, a.appointment_id), '{}')
    into moving
    from public.appointment a
   where a.appointment_id in (select id from app_private.d8_upcoming_appointments(from_doc_id) as id);

  if expected_appointment_count is null then
    if cardinality(moving) > 0 then
      raise exception 'This doctor has upcoming appointments to move as well. Reload the page to review them, then try again.'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  elsif expected_appointment_count <> cardinality(moving) then
    raise exception 'The number of upcoming appointments has changed since it was shown. Check it and try again.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select count(*)::integer into clashes
    from public.appointment m
   where m.appointment_id = any (moving)
     and exists (
       select 1
         from public.appointment b
        where b.appointment_id <> m.appointment_id
          and b.appointment_status in ('scheduled', 'confirmed')
          and b.appointment_date = m.appointment_date
          and (b.doc_id = to_doc_id
               or b.pat_id = m.pat_id
               or b.appointment_id = any (moving))
     );

  if clashes > 0 then
    raise exception '% of the upcoming appointments would clash with another booking at the same time, so nothing was moved. Choose a different doctor, or have the clashing booking moved first.',
      clashes
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The doctor is the only column written. Migration 27's and 29's guards
  -- run as for any other move: active doctor, same clinic.
  update public.patient set doc_id = to_doc_id where doc_id = from_doc_id;
  get diagnostics moved = row_count;

  -- Each patient's doctor is now the new one, which is what an appointment's
  -- doctor must be. The reminder stamp is left as it is.
  update public.appointment
     set doc_id = to_doc_id
   where appointment_id = any (moving);

  -- The patient learns who they will see; the new doctor, who is coming.
  -- Both in the clinic's time.
  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from public.appointment a
    join public.patient p on p.pat_id = a.pat_id
    join public.doctor nd on nd.doc_id = a.doc_id
    join public.clinic c on c.clinic_id = nd.clinic_id
    cross join lateral (
      values
        (
          p.user_id,
          format(
            'Your appointment on %s at %s will now be with Dr %s.',
            to_char(a.appointment_date at time zone c.clinic_timezone, 'FMDay, FMDD FMMonth'),
            to_char(a.appointment_date at time zone c.clinic_timezone, 'HH24:MI'),
            trim(nd.doc_first_name || ' ' || nd.doc_last_name)
          )
        ),
        (
          nd.user_id,
          format(
            'The appointment with %s on %s at %s has been transferred to you.',
            trim(p.pat_first_name || ' ' || p.pat_last_name),
            to_char(a.appointment_date at time zone c.clinic_timezone, 'FMDay, FMDD FMMonth'),
            to_char(a.appointment_date at time zone c.clinic_timezone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message)
   where a.appointment_id = any (moving);

  -- One clinical entry per appointment, recording that its doctor changed
  -- and not to whom - as the patient trigger does for each patient.
  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
    audit_log_details
  )
  select (select auth.uid()), 'update', 'appointment', moved_id,
         jsonb_build_object('changed_columns', jsonb_build_array('doc_id'))
    from unnest(moving) as moved_id;

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
    audit_log_details
  )
  values (
    (select auth.uid()), 'reassign', 'doctor_patients', from_doc_id,
    jsonb_build_object(
      'from_doc_id', from_doc_id,
      'to_doc_id', to_doc_id,
      'patient_count', moved,
      'appointment_count', cardinality(moving)
    )
  );

  return moved;
end;
$$;

comment on function public.admin_reassign_doctor_patients(uuid, uuid, integer, integer) is
  'D8. Moves every patient of a deactivated doctor in the caller''s clinic, '
  'with their upcoming appointments, to an active doctor in the same clinic, '
  'if both counts still match what the Clinic Admin confirmed and no '
  'appointment would clash. Audited; authorship of clinical records is kept.';

-- Called over RPC, like the other administrator functions: refused to anon,
-- and each one checks its caller in its own body.
revoke all on function
  public.admin_set_clinic_timezone(text),
  public.admin_doctor_appointment_count(uuid),
  public.admin_reassign_doctor_patients(uuid, uuid, integer, integer)
  from public, anon;

grant execute on function
  public.admin_set_clinic_timezone(text),
  public.admin_doctor_appointment_count(uuid),
  public.admin_reassign_doctor_patients(uuid, uuid, integer, integer)
  to authenticated;
