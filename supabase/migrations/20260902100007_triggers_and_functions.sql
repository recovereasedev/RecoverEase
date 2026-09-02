-- ===========================================================================
-- RecoverEase — 08. Guards, auditing and generated data
-- ===========================================================================
-- Row Level Security decides which ROWS a caller may touch. It cannot express
-- "this role may edit these COLUMNS but not those". The guards below close
-- that gap, because several of the columns RLS lets a user write are the very
-- columns that decide their own privileges.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Guard: patient may not edit the columns that govern their own access
-- ---------------------------------------------------------------------------
-- The patient UPDATE policy exists for module 2.7 (update your own profile).
-- Without this guard that same policy would also let a patient reassign
-- themselves to a different doctor — handing their record to a clinician who
-- has no relationship with them — or flip their own status back to active
-- after discharge.

create or replace function public.patient_guard_protected_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The link to the auth account is immutable for everyone. Re-pointing it
  -- would transfer an entire medical history to a different login.
  if new.user_id is distinct from old.user_id then
    raise exception 'The linked account of a patient record cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  -- Everything below applies only when the patient is editing their own row.
  -- Their assigned doctor legitimately changes these fields.
  if (select auth.uid()) = old.user_id then
    if new.doc_id is distinct from old.doc_id then
      raise exception 'You cannot change your assigned doctor'
        using errcode = 'insufficient_privilege';
    end if;

    if new.pat_status is distinct from old.pat_status then
      raise exception 'You cannot change your own patient status'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger patient_protect_columns
  before update on public.patient
  for each row execute function public.patient_guard_protected_columns();

-- ---------------------------------------------------------------------------
-- Guard: doctor may not grant themselves privileges
-- ---------------------------------------------------------------------------
-- `doc_is_active` is an administrator control (module 11.3). The doctor
-- UPDATE policy exists for module 2.6 (edit your own profile); without this
-- guard a deactivated doctor could simply reactivate themselves and restore
-- their access to every assigned patient.

create or replace function public.doctor_guard_protected_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'The linked account of a doctor record cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  if not (select app_private.is_admin()) then
    if new.doc_is_active is distinct from old.doc_is_active then
      raise exception
        'Only an administrator can activate or deactivate a doctor account'
        using errcode = 'insufficient_privilege';
    end if;

    -- A licence number is an identity claim, not a preference.
    if new.doc_license_no is distinct from old.doc_license_no then
      raise exception 'Only an administrator can change a licence number'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger doctor_protect_columns
  before update on public.doctor
  for each row execute function public.doctor_guard_protected_columns();

-- ---------------------------------------------------------------------------
-- Guard: appointment transitions available to a patient
-- ---------------------------------------------------------------------------
-- Module 6.6 gives the patient exactly one appointment action: confirm
-- attendance. Cancelling is the reasonable companion. Marking an appointment
-- 'completed' is a clinical assertion and stays with the doctor, and moving
-- the date is what the reschedule-request flow (6.5) is for.

create or replace function public.appointment_guard_patient_transitions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- True only for the patient: a doctor is never their own patient record.
  if (select app_private.is_own_patient_record(new.pat_id)) then
    if new.appointment_date is distinct from old.appointment_date then
      raise exception
        'Submit a reschedule request instead of changing the appointment time'
        using errcode = 'insufficient_privilege';
    end if;

    if new.appointment_status is distinct from old.appointment_status
       and new.appointment_status not in ('confirmed', 'cancelled') then
      raise exception 'You may only confirm or cancel an appointment'
        using errcode = 'insufficient_privilege';
    end if;

    if new.pat_id is distinct from old.pat_id
       or new.doc_id is distinct from old.doc_id then
      raise exception 'An appointment cannot be reassigned'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger appointment_protect_transitions
  before update on public.appointment
  for each row
  execute function public.appointment_guard_patient_transitions();

-- ---------------------------------------------------------------------------
-- Guard: a dose slot is immutable except for its outcome
-- ---------------------------------------------------------------------------
-- Module 4.6 lets the patient mark a dose as taken. It does not let anyone
-- move when the dose was due, which would make the adherence history in
-- module 4.8 meaningless.

create or replace function public.medication_log_guard_slot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.medication_schedule_id is distinct from old.medication_schedule_id
     or new.medication_log_scheduled_at
        is distinct from old.medication_log_scheduled_at then
    raise exception 'A scheduled dose cannot be moved or reassigned'
      using errcode = 'insufficient_privilege';
  end if;

  -- Keep the timestamp consistent with the status without making every
  -- caller remember to set it.
  if new.medication_log_status = 'taken'
     and new.medication_log_taken_at is null then
    new.medication_log_taken_at := now();
  elsif new.medication_log_status <> 'taken' then
    new.medication_log_taken_at := null;
  end if;

  return new;
end;
$$;

create trigger medication_log_protect_slot
  before update on public.medication_log
  for each row execute function public.medication_log_guard_slot();

-- ---------------------------------------------------------------------------
-- Reschedule decisions move the appointment
-- ---------------------------------------------------------------------------
-- Module 6.4 "Approve or Decline Reschedule Request". Approving is only
-- meaningful if the appointment actually moves, so that happens here rather
-- than relying on the client to remember a second write.

create or replace function public.reschedule_request_apply_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reschedule_request_status = old.reschedule_request_status then
    return new;
  end if;

  if new.reschedule_request_responded_at is null then
    new.reschedule_request_responded_at := now();
  end if;

  if new.reschedule_request_status = 'approved' then
    update public.appointment
       set appointment_date   = new.reschedule_request_date,
           appointment_status = 'scheduled'
     where appointment_id = new.appointment_id;
  end if;

  return new;
end;
$$;

create trigger reschedule_request_on_decision
  before update of reschedule_request_status on public.reschedule_request
  for each row execute function public.reschedule_request_apply_decision();

-- ===========================================================================
-- Audit logging
-- ===========================================================================
-- Administrators can read audit_log (module 13.1) but deliberately cannot
-- read patient records. Writing a patient row into audit details would
-- therefore leak protected health information straight back to the role the
-- access model excludes — through the audit trail itself.
--
-- The trigger takes a disclosure mode to prevent exactly that:
--
--   'values'    record what changed and to what. For administrative entities
--               (doctor accounts, announcements, system settings) whose
--               contents an administrator may legitimately see.
--
--   'keys_only' record only WHICH columns changed, never their contents. For
--               anything touching a patient. An administrator can still see
--               that a clinician edited a record and when — which is what an
--               audit trail is for — without being handed the clinical data.

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity_name     text := tg_argv[0];
  id_column       text := tg_argv[1];
  disclosure_mode text := coalesce(tg_argv[2], 'keys_only');
  row_json        jsonb;
  old_json        jsonb;
  target_id       uuid;
  details         jsonb;
  changed_keys    text[];
begin
  row_json := to_jsonb(coalesce(new, old));
  target_id := (row_json ->> id_column)::uuid;

  if tg_op = 'UPDATE' then
    old_json := to_jsonb(old);

    select coalesce(array_agg(key order by key), '{}')
      into changed_keys
      from jsonb_each(row_json) AS each_new(key, value)
     where value is distinct from (old_json -> each_new.key);

    -- Nothing actually changed; do not manufacture an audit entry.
    if cardinality(changed_keys) = 0 then
      return coalesce(new, old);
    end if;

    if disclosure_mode = 'values' then
      details := jsonb_build_object(
        'changed_columns', to_jsonb(changed_keys),
        'before', (select jsonb_object_agg(k, old_json -> k)
                     from unnest(changed_keys) as k),
        'after',  (select jsonb_object_agg(k, row_json -> k)
                     from unnest(changed_keys) as k)
      );
    else
      details := jsonb_build_object('changed_columns', to_jsonb(changed_keys));
    end if;

  elsif disclosure_mode = 'values' then
    details := jsonb_build_object('record', row_json);
  else
    details := jsonb_build_object(
      'columns', to_jsonb(array(select jsonb_object_keys(row_json) order by 1))
    );
  end if;

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity,
    audit_log_entity_id, audit_log_details
  )
  values (
    (select auth.uid()), lower(tg_op), entity_name, target_id, details
  );

  return coalesce(new, old);
end;
$$;

comment on function public.audit_row_change() is
  'Generic audit trigger. Arguments: entity name, primary key column, and '
  'disclosure mode (''values'' or ''keys_only''). Patient-touching tables '
  'must use ''keys_only'': administrators can read audit_log but not patient '
  'records, so recording values there would leak PHI through the audit trail.';

-- Administrative entities: an administrator may see these contents.
create trigger doctor_audit
  after insert or update or delete on public.doctor
  for each row execute function
    public.audit_row_change('doctor', 'doc_id', 'values');

create trigger announcement_audit
  after insert or update or delete on public.announcement
  for each row execute function
    public.audit_row_change('announcement', 'announcement_id', 'values');

create trigger system_setting_audit
  after insert or update or delete on public.system_setting
  for each row execute function
    public.audit_row_change('system_setting', 'system_setting_id', 'values');

create trigger user_account_audit
  after insert or update or delete on public.user_account
  for each row execute function
    public.audit_row_change('user_account', 'user_id', 'values');

-- Patient-touching entities: metadata only, never contents.
create trigger patient_audit
  after insert or update on public.patient
  for each row execute function
    public.audit_row_change('patient', 'pat_id', 'keys_only');

create trigger prescription_audit
  after insert or update on public.prescription
  for each row execute function
    public.audit_row_change('prescription', 'prescription_id', 'keys_only');

create trigger treatment_plan_audit
  after insert or update on public.treatment_plan
  for each row execute function
    public.audit_row_change('treatment_plan', 'treatment_plan_id', 'keys_only');

-- ===========================================================================
-- Medication dose-slot generation
-- ===========================================================================
-- Module 4.1 sets a schedule; modules 4.6, 4.7 and 4.8 need one concrete row
-- per due dose so a patient can mark it taken and adherence can be counted.
--
-- Times are wall-clock times in the deployment's local timezone, read from
-- the `app.timezone` system setting (module 14.1). A dose written at 08:00
-- must mean 08:00 where the patient lives, not 08:00 UTC.

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

  -- Never backfill doses the patient had no opportunity to record.
  window_from := greatest(schedule.medication_schedule_start_date,
                          current_date);
  window_to := least(
    coalesce(schedule.medication_schedule_end_date, 'infinity'::date),
    current_date + make_interval(days => horizon_days)
  );

  if window_from > window_to then
    return 0;
  end if;

  with slots as (
    select (day + dose_time) at time zone zone as scheduled_at
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

comment on function public.generate_medication_log_slots(uuid, integer) is
  'Materialises one medication_log row per due dose within the horizon. '
  'Idempotent: the unique slot index makes repeat runs no-ops, so it is safe '
  'to call from both a schedule trigger and a scheduled job.';

-- Generate slots as soon as a schedule is created or its shape changes.
create or replace function public.medication_schedule_generate_slots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.generate_medication_log_slots(new.medication_schedule_id);
  return new;
end;
$$;

create trigger medication_schedule_fill_slots
  after insert or update of
    medication_schedule_times,
    medication_schedule_start_date,
    medication_schedule_end_date
  on public.medication_schedule
  for each row execute function public.medication_schedule_generate_slots();

-- Extends every live schedule. Intended to be called daily by pg_cron or a
-- scheduled Edge Function; see docs/deployment.md.
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
        or ms.medication_schedule_end_date >= current_date
  loop
    total := total
      + public.generate_medication_log_slots(schedule_id, horizon_days);
  end loop;

  return total;
end;
$$;

-- Doses that came and went unrecorded are missed, not perpetually pending.
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
  update public.medication_log
     set medication_log_status = 'missed'
   where medication_log_status = 'pending'
     and medication_log_scheduled_at
         < now() - make_interval(hours => grace_hours);

  get diagnostics updated = row_count;
  return updated;
end;
$$;

-- These run as scheduled jobs with elevated privilege, never from a browser.
revoke all on function
  public.generate_medication_log_slots(uuid, integer),
  public.extend_all_medication_log_slots(integer),
  public.mark_overdue_medication_logs(integer)
  from public, anon, authenticated;

grant execute on function
  public.extend_all_medication_log_slots(integer),
  public.mark_overdue_medication_logs(integer)
  to service_role;

-- ===========================================================================
-- Administrator aggregates
-- ===========================================================================
-- Modules 10.1, 10.2 and 8.6 give administrators counts and usage statistics.
-- They do NOT give administrators access to patient records or chat
-- transcripts, and the RLS policies reflect that.
--
-- These functions therefore return aggregates and never rows. They are
-- SECURITY DEFINER because they must count rows the caller cannot read, and
-- they live in `public` because they are called over RPC — so each one
-- re-checks the caller's role in its own body rather than trusting the
-- schema's obscurity.

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not (select app_private.is_admin()) then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'patients', jsonb_build_object(
      'total',  (select count(*) from public.patient),
      'active', (select count(*) from public.patient
                  where pat_status = 'active')
    ),
    'doctors', jsonb_build_object(
      'total',  (select count(*) from public.doctor),
      'active', (select count(*) from public.doctor where doc_is_active)
    ),
    'accounts', (
      select jsonb_object_agg(user_role, role_count)
        from (select user_role, count(*) as role_count
                from public.user_account
               group by user_role) counts
    ),
    'appointments', jsonb_build_object(
      'upcoming', (select count(*) from public.appointment
                    where appointment_date >= now()
                      and appointment_status in ('scheduled', 'confirmed'))
    ),
    'generated_at', now()
  ) into result;

  return result;
end;
$$;

comment on function public.admin_dashboard_stats() is
  'Modules 10.1 and 10.2. Returns counts only. Administrators have no row '
  'access to patient data, so this is how the dashboard gets its numbers.';

create or replace function public.admin_chatbot_usage(
  window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  since  timestamptz;
begin
  if not (select app_private.is_admin()) then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  since := now() - make_interval(days => window_days);

  -- Counts and timings only. No transcript, no summary, no patient
  -- identifier: module 8.6 is "Monitor Chatbot Usage Logs", not read the
  -- conversations.
  select jsonb_build_object(
    'window_days', window_days,
    'sessions', (select count(*) from public.chat_session
                  where chat_session_started_at >= since),
    'sessions_flagged_critical', (
      select count(*) from public.chat_session
       where chat_session_started_at >= since
         and chat_session_has_critical_flag
    ),
    'messages', (
      select count(*)
        from public.chat_message m
        join public.chat_session s on s.chat_session_id = m.chat_session_id
       where s.chat_session_started_at >= since
    ),
    'generated_at', now()
  ) into result;

  return result;
end;
$$;

comment on function public.admin_chatbot_usage(integer) is
  'Module 8.6. Usage statistics only. Deliberately returns no transcript, '
  'summary or patient identifier.';

revoke all on function
  public.admin_dashboard_stats(),
  public.admin_chatbot_usage(integer)
  from public, anon;

grant execute on function
  public.admin_dashboard_stats(),
  public.admin_chatbot_usage(integer)
  to authenticated;
