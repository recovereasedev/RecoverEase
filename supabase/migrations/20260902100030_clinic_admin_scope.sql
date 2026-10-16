-- ===========================================================================
-- RecoverEase — 23. A Clinic Admin sees and manages only their own clinic
-- ===========================================================================
-- Phase A, step 3. Until now every administration policy asked only "is the
-- caller an administrator?". Each now asks "is the caller this clinic's
-- administrator?":
--
--   * Accounts, doctors, announcements, reports and the audit log: ten
--     policies, each scoped to the caller's clinic. A Clinic Admin still sees
--     account emails within their clinic (decision D5), and still has no
--     access to any patient record.
--   * `announcement.clinic_id` and `report.clinic_id`, taken from the author
--     and the patient, never from the request.
--   * `audit_log.clinic_id` and `audit_log.audit_scope` - platform,
--     administration or clinical - set as each entry is written, from what
--     the entry is about. Anything not recognised is "clinical", the most
--     restricted. A Clinic Admin reads their clinic's administration and
--     clinical entries, as today; no one reads platform entries yet, and
--     only clinic entries are platform (migration 33 gives the Super Admin
--     those, and nothing else).
--   * The dashboard and chatbot usage counts cover the caller's clinic only.
--   * Decision D8: a deactivated doctor's patients can be moved, all at once,
--     to an active doctor in the same clinic. The Clinic Admin sees how many,
--     never who. The move is audited; every plan, prescription and note keeps
--     the doctor who wrote it.
--
-- Settings stay platform-wide until migration 31 (decision D3), and the
-- single-clinic gate stays until then, so no second clinic can share them.
--
-- The data step is one block: it requires migration 29, snapshots every id,
-- backfills, and compares, and stops with nothing applied on any difference.
-- It runs once: it refuses to start if the columns already exist.
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100030_clinic_admin_scope.down.sql, applied as a
-- new migration with approval. tests/db/clinic-rollback.test.ts proves it
-- returns the schema to exactly what migration 29 left, with every row kept.
-- No clinical row is touched; patients moved with D8 stay moved (move them
-- back the same way), and entries written in between lose their scope and
-- clinic with the columns.
-- ===========================================================================

-- Before anything is created: 29 must be in, and 30 not yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'admin' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 30 needs migration 29 first. Nothing was applied.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'audit_log' and column_name = 'audit_scope'
  ) then
    raise exception 'Migration 30 has already been applied. Nothing was changed.';
  end if;
end
$$;

do $$
begin
  create type public.audit_scope as enum ('platform', 'administration', 'clinical');
exception
  when duplicate_object then null;
end
$$;

comment on type public.audit_scope is
  'Who an audit entry is for. platform: clinics themselves, for the Super '
  'Admin. administration: staff and clinic operations, for the Clinic Admin. '
  'clinical: anything about a patient, for the Clinic Admin and never the '
  'Super Admin. Unknown entities are clinical.';

-- ---------------------------------------------------------------------------
-- What an audit entry is about
-- ---------------------------------------------------------------------------
-- An entry's scope follows from its entity alone, so no writer can make a
-- patient's entry look like a platform one. Account entries follow the
-- account's role: a patient's account is clinical information.

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

revoke all on function app_private.audit_scope_for(text, uuid, jsonb) from public;
grant execute on function app_private.audit_scope_for(text, uuid, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Snapshots for the data step
-- ---------------------------------------------------------------------------
-- Temporary, as in migration 29: defined once, read before and after.

-- Every id, link and recorded value the migration must not change: the audit
-- entries that existed before it, and the rows of every table it alters or
-- reads from. Hashed, so the comparison stays small however long the trail.
create function pg_temp.clinic_scope_identities(audit_ids uuid[])
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'announcements', (select md5(coalesce(string_agg(row(
                         an.announcement_id, an.admin_id, an.announcement_title,
                         an.announcement_content, an.announcement_published_at,
                         an.announcement_created_at)::text, '|'
                         order by an.announcement_id), ''))
                        from public.announcement an),
    'reports',       (select md5(coalesce(string_agg(row(
                         r.report_id, r.pat_id, r.user_id, r.report_type,
                         r.report_generated_at, r.report_file_path)::text, '|'
                         order by r.report_id), ''))
                        from public.report r),
    'audit',         (select md5(coalesce(string_agg(row(
                         l.audit_log_id, l.user_id, l.audit_log_action,
                         l.audit_log_entity, l.audit_log_entity_id,
                         l.audit_log_timestamp, l.audit_log_details)::text, '|'
                         order by l.audit_log_id), ''))
                        from public.audit_log l
                       where l.audit_log_id = any (audit_ids)),
    'accounts',      (select md5(coalesce(string_agg(row(
                         ua.user_id, ua.user_role, ua.user_email)::text, '|'
                         order by ua.user_id), ''))
                        from public.user_account ua),
    'doctors',       (select md5(coalesce(string_agg(row(
                         d.doc_id, d.user_id, d.clinic_id, d.doc_is_active)::text, '|'
                         order by d.doc_id), ''))
                        from public.doctor d),
    'admins',        (select md5(coalesce(string_agg(row(
                         a.admin_id, a.user_id, a.clinic_id)::text, '|'
                         order by a.admin_id), ''))
                        from public.admin a),
    'patients',      (select md5(coalesce(string_agg(row(
                         p.pat_id, p.user_id, p.doc_id, p.pat_status)::text, '|'
                         order by p.pat_id), ''))
                        from public.patient p)
  );
$$;

create function pg_temp.clinic_scope_row_counts()
returns jsonb
language plpgsql
stable
as $$
declare
  counts jsonb := '{}'::jsonb;
  tbl    text;
  n      bigint;
begin
  for tbl in
    select c.relname
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
     order by c.relname
  loop
    execute format('select count(*) from public.%I', tbl) into n;
    counts := counts || jsonb_build_object(tbl, n);
  end loop;
  return counts;
end;
$$;

-- ---------------------------------------------------------------------------
-- The data step: clinic and scope on announcements, reports and the audit log
-- ---------------------------------------------------------------------------

do $$
declare
  the_clinic        uuid;
  clinic_count      bigint;
  audit_ids_before  uuid[];
  identities_before jsonb;
  counts_before     jsonb;
  counts_after      jsonb;
  announcements_assigned bigint;
begin
  -- The tables altered are locked outright; the ones read only for writes.
  lock table public.announcement, public.report, public.audit_log
    in access exclusive mode;
  lock table public.clinic, public.admin, public.doctor, public.patient,
             public.user_account in share row exclusive mode;

  -- Everything recorded so far happened in the one clinic there has been.
  select count(*) into clinic_count from public.clinic;
  if clinic_count <> 1 then
    raise exception 'Migration 30 expects exactly one clinic, found %. Nothing was applied.',
      clinic_count;
  end if;
  select c.clinic_id into the_clinic from public.clinic c;

  if exists (select 1 from public.admin a where a.clinic_id is distinct from the_clinic)
     or exists (select 1 from public.doctor d where d.clinic_id is distinct from the_clinic) then
    raise exception 'A doctor or admin is outside the clinic. Migration 30 changed nothing.';
  end if;

  select coalesce(array_agg(l.audit_log_id), '{}') into audit_ids_before
    from public.audit_log l;
  identities_before := pg_temp.clinic_scope_identities(audit_ids_before);
  counts_before := pg_temp.clinic_scope_row_counts();

  alter table public.announcement
    add column clinic_id uuid references public.clinic (clinic_id) on delete restrict;
  alter table public.report
    add column clinic_id uuid references public.clinic (clinic_id) on delete restrict;

  -- An announcement is its author's clinic's; a report is its patient's, or
  -- for a system-wide report its author's. Each announcement's change is
  -- audited by the existing announcement trigger.
  update public.announcement an
     set clinic_id = a.clinic_id
    from public.admin a
   where a.admin_id = an.admin_id;
  get diagnostics announcements_assigned = row_count;

  update public.report r
     set clinic_id = case
       when r.report_type = 'patient_recovery' then app_private.clinic_of_patient(r.pat_id)
       else app_private.clinic_of_user(r.user_id)
     end;

  -- Added after the announcements, so the entries their backfill just wrote
  -- are classified with everything else.
  alter table public.audit_log
    add column audit_scope public.audit_scope,
    add column clinic_id uuid references public.clinic (clinic_id) on delete restrict;

  update public.audit_log l
     set audit_scope = app_private.audit_scope_for(
           l.audit_log_entity, l.audit_log_entity_id, l.audit_log_details),
         clinic_id = the_clinic;

  if pg_temp.clinic_scope_identities(audit_ids_before) <> identities_before then
    raise exception 'Migration 30 would have changed an existing id, link or audit entry. Nothing was applied.';
  end if;

  if exists (select 1 from public.announcement where clinic_id is distinct from the_clinic)
     or exists (select 1 from public.report where clinic_id is distinct from the_clinic)
     or exists (select 1 from public.audit_log
                 where clinic_id is distinct from the_clinic or audit_scope is null) then
    raise exception 'Migration 30 left a row without its clinic or scope. Nothing was applied.';
  end if;

  -- Nothing in the existing trail is about a clinic except the clinic's own
  -- entries, so nothing else may have become platform.
  if exists (select 1 from public.audit_log
              where audit_scope = 'platform' and audit_log_entity <> 'clinic') then
    raise exception 'Migration 30 classified a non-clinic entry as platform. Nothing was applied.';
  end if;

  -- Only the audit trail may have grown, by one entry per announcement.
  counts_after := pg_temp.clinic_scope_row_counts();
  if counts_after <> (counts_before || jsonb_build_object(
       'audit_log', (counts_before ->> 'audit_log')::bigint + announcements_assigned
     )) then
    raise exception 'Migration 30 changed row counts it should not have: before %, after %. Nothing was applied.',
      counts_before, counts_after;
  end if;

  alter table public.report alter column clinic_id set not null;
  alter table public.audit_log alter column audit_scope set not null;
end;
$$;

drop function pg_temp.clinic_scope_identities(uuid[]);
drop function pg_temp.clinic_scope_row_counts();

create index if not exists announcement_clinic_id_idx on public.announcement (clinic_id);
create index if not exists report_clinic_id_idx on public.report (clinic_id);
create index if not exists audit_log_clinic_id_timestamp_idx
  on public.audit_log (clinic_id, audit_log_timestamp desc);

comment on column public.announcement.clinic_id is
  'The clinic whose members see the announcement: its author''s. Empty for a '
  'platform announcement (migration 33).';
comment on column public.report.clinic_id is
  'The report''s clinic: its patient''s, or its author''s for a system-wide '
  'report.';
comment on column public.audit_log.clinic_id is
  'The clinic the entry is about, set as it is written. Empty when that '
  'cannot be known yet (an account written before its profile); the Clinic '
  'Admin policy then resolves it as the entry is read. ON DELETE RESTRICT: a '
  'clinic with history is deactivated, never deleted.';
comment on column public.audit_log.audit_scope is
  'platform, administration or clinical, from the entry''s entity. Set as '
  'the entry is written; no writer chooses it.';

-- ---------------------------------------------------------------------------
-- Every new audit entry is classified as it is written
-- ---------------------------------------------------------------------------
-- The clinic comes from the row the entry is about: its own clinic_id, its
-- patient's doctor's, or its account's profile's. For a row already deleted,
-- from the copy the audit trigger recorded. Failing all of those, the clinic
-- of whoever acted.

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

revoke all on function app_private.audit_clinic_for(text, uuid, uuid, jsonb) from public;
grant execute on function app_private.audit_clinic_for(text, uuid, uuid, jsonb)
  to authenticated, service_role;

-- SECURITY DEFINER: it reads the rows an entry is about whoever wrote it, and
-- the scope is always recomputed, never taken from the writer.
create or replace function public.audit_log_classify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.audit_scope := app_private.audit_scope_for(
    new.audit_log_entity, new.audit_log_entity_id, new.audit_log_details);

  if new.clinic_id is null then
    new.clinic_id := app_private.audit_clinic_for(
      new.audit_log_entity, new.audit_log_entity_id, new.user_id,
      new.audit_log_details);
  end if;

  return new;
end;
$$;

comment on function public.audit_log_classify() is
  'Sets every new audit entry''s scope from its entity, and its clinic when '
  'the writer did not. Run only by the audit_log_classify trigger.';

drop trigger if exists audit_log_classify on public.audit_log;
create trigger audit_log_classify
  before insert on public.audit_log
  for each row execute function public.audit_log_classify();

-- ---------------------------------------------------------------------------
-- An announcement and a report take their clinic from their source
-- ---------------------------------------------------------------------------
-- Always, whatever the request says: an administrator cannot address another
-- clinic, and a report cannot be filed under one. The website deployed today
-- sends no clinic at all, and keeps working.

create or replace function public.announcement_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.clinic_id := (select a.clinic_id from public.admin a
                     where a.admin_id = new.admin_id);
  return new;
end;
$$;

comment on function public.announcement_assign_clinic() is
  'Gives a new announcement its author''s clinic. Run only by the '
  'announcement_assign_clinic trigger.';

drop trigger if exists announcement_assign_clinic on public.announcement;
create trigger announcement_assign_clinic
  before insert on public.announcement
  for each row execute function public.announcement_assign_clinic();

create or replace function public.report_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.clinic_id := case
    when new.report_type = 'patient_recovery'
      then app_private.clinic_of_patient(new.pat_id)
    else app_private.clinic_of_user(new.user_id)
  end;
  return new;
end;
$$;

comment on function public.report_assign_clinic() is
  'Gives a new report its patient''s clinic, or its author''s for a '
  'system-wide report. Run only by the report_assign_clinic trigger.';

drop trigger if exists report_assign_clinic on public.report;
create trigger report_assign_clinic
  before insert on public.report
  for each row execute function public.report_assign_clinic();

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.audit_log_classify() from public, anon, authenticated;
revoke all on function public.announcement_assign_clinic() from public, anon, authenticated;
revoke all on function public.report_assign_clinic() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The ten administration policies, scoped to the caller's clinic
-- ---------------------------------------------------------------------------
-- Same names, same roles, same ownership predicates. Only the administrator
-- branch changes: `is_admin()` becomes "this row is in the clinic I
-- administer", through admin_clinic_id(), which is empty for anyone who is
-- not a Clinic Admin.

-- user_account: the accounts of the caller's clinic, emails included (D5).
drop policy if exists user_account_select on public.user_account;
create policy user_account_select
  on public.user_account for select to authenticated
  using (
    user_id = (select auth.uid())
    or app_private.clinic_of_user(user_id) = (select app_private.admin_clinic_id())
    or (select app_private.is_user_my_patient(user_id))
  );

-- doctor: the caller's clinic's doctors, to list and to manage.
drop policy if exists doctor_select on public.doctor;
create policy doctor_select
  on public.doctor for select to authenticated
  using (
    user_id = (select auth.uid())
    or clinic_id = (select app_private.admin_clinic_id())
    or (select app_private.is_my_doctor(doc_id))
  );

drop policy if exists doctor_update_self_or_admin on public.doctor;
create policy doctor_update_self_or_admin
  on public.doctor for update to authenticated
  using (
    user_id = (select auth.uid())
    or clinic_id = (select app_private.admin_clinic_id())
  )
  with check (
    user_id = (select auth.uid())
    or clinic_id = (select app_private.admin_clinic_id())
  );

-- announcement: published ones reach the members of their clinic, and a
-- platform one (no clinic) everyone; drafts only their clinic's admins.
drop policy if exists announcement_select_published on public.announcement;
create policy announcement_select_published
  on public.announcement for select to authenticated
  using (
    (
      announcement_published_at is not null
      and (clinic_id is null or clinic_id = (select app_private.current_clinic_id()))
    )
    or clinic_id = (select app_private.admin_clinic_id())
  );

drop policy if exists announcement_insert_admin on public.announcement;
create policy announcement_insert_admin
  on public.announcement for insert to authenticated
  with check (
    clinic_id = (select app_private.admin_clinic_id())
    and admin_id = (select app_private.current_admin_id())
  );

drop policy if exists announcement_update_admin on public.announcement;
create policy announcement_update_admin
  on public.announcement for update to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()))
  with check (clinic_id = (select app_private.admin_clinic_id()));

drop policy if exists announcement_delete_admin on public.announcement;
create policy announcement_delete_admin
  on public.announcement for delete to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()));

-- report: your own, plus your clinic's system-wide ones.
drop policy if exists report_select on public.report;
create policy report_select
  on public.report for select to authenticated
  using (
    user_id = (select auth.uid())
    or (
      report_type = 'system_wide'
      and clinic_id = (select app_private.admin_clinic_id())
    )
  );

drop policy if exists report_insert on public.report;
create policy report_insert
  on public.report for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      (
        report_type = 'patient_recovery'
        and (select app_private.is_my_patient(pat_id))
      )
      or (
        report_type = 'system_wide'
        and clinic_id = (select app_private.admin_clinic_id())
      )
    )
  );

-- audit_log: the caller's clinic's administration and clinical entries, which
-- is what an administrator saw before, within one clinic. Never platform
-- entries. An entry whose clinic was not known when written - an account,
-- written a moment before its profile - is resolved as it is read.
drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
  on public.audit_log for select to authenticated
  using (
    audit_scope in ('administration', 'clinical')
    and (
      clinic_id = (select app_private.admin_clinic_id())
      or (
        clinic_id is null
        and app_private.audit_clinic_for(
              audit_log_entity, audit_log_entity_id, user_id, audit_log_details)
            = (select app_private.admin_clinic_id())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- The dashboard and usage counts, for the caller's clinic
-- ---------------------------------------------------------------------------
-- Same shapes, same refusal for anyone else. Patients, appointments and chat
-- sessions are counted through the patient's doctor's clinic.

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result      jsonb;
  this_clinic uuid := (select app_private.admin_clinic_id());
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'patients', jsonb_build_object(
      'total',  (select count(*) from public.patient p
                   join public.doctor d on d.doc_id = p.doc_id
                  where d.clinic_id = this_clinic),
      'active', (select count(*) from public.patient p
                   join public.doctor d on d.doc_id = p.doc_id
                  where d.clinic_id = this_clinic
                    and p.pat_status = 'active')
    ),
    'doctors', jsonb_build_object(
      'total',  (select count(*) from public.doctor d
                  where d.clinic_id = this_clinic),
      'active', (select count(*) from public.doctor d
                  where d.clinic_id = this_clinic and d.doc_is_active)
    ),
    'accounts', (
      select jsonb_object_agg(user_role, role_count)
        from (select ua.user_role, count(*) as role_count
                from public.user_account ua
               where app_private.clinic_of_user(ua.user_id) = this_clinic
               group by ua.user_role) counts
    ),
    'appointments', jsonb_build_object(
      'upcoming', (select count(*) from public.appointment ap
                     join public.patient p on p.pat_id = ap.pat_id
                     join public.doctor d on d.doc_id = p.doc_id
                    where d.clinic_id = this_clinic
                      and ap.appointment_date >= now()
                      and ap.appointment_status in ('scheduled', 'confirmed'))
    ),
    'generated_at', now()
  ) into result;

  return result;
end;
$$;

comment on function public.admin_dashboard_stats() is
  'Modules 10.1 and 10.2, for the caller''s clinic. Returns counts only: '
  'administrators have no row access to patient data.';

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
  result      jsonb;
  since       timestamptz;
  this_clinic uuid := (select app_private.admin_clinic_id());
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  since := now() - make_interval(days => window_days);

  -- Counts and timings only. No transcript, no summary, no patient
  -- identifier: module 8.6 is "Monitor Chatbot Usage Logs", not read the
  -- conversations.
  select jsonb_build_object(
    'window_days', window_days,
    'sessions', (select count(*) from public.chat_session s
                   join public.patient p on p.pat_id = s.pat_id
                   join public.doctor d on d.doc_id = p.doc_id
                  where d.clinic_id = this_clinic
                    and s.chat_session_started_at >= since),
    'sessions_flagged_critical', (
      select count(*) from public.chat_session s
        join public.patient p on p.pat_id = s.pat_id
        join public.doctor d on d.doc_id = p.doc_id
       where d.clinic_id = this_clinic
         and s.chat_session_started_at >= since
         and s.chat_session_has_critical_flag
    ),
    'messages', (
      select count(*)
        from public.chat_message m
        join public.chat_session s on s.chat_session_id = m.chat_session_id
        join public.patient p on p.pat_id = s.pat_id
        join public.doctor d on d.doc_id = p.doc_id
       where d.clinic_id = this_clinic
         and s.chat_session_started_at >= since
    ),
    'generated_at', now()
  ) into result;

  return result;
end;
$$;

comment on function public.admin_chatbot_usage(integer) is
  'Module 8.6, for the caller''s clinic. Usage statistics only. Deliberately '
  'returns no transcript, summary or patient identifier.';

-- ---------------------------------------------------------------------------
-- D8: moving a deactivated doctor's patients
-- ---------------------------------------------------------------------------
-- Deactivating a doctor withdraws their access at once, and their patients
-- are left with no clinician who can see them. These let the Clinic Admin
-- move them, all together, to an active doctor in the same clinic.
--
-- The Clinic Admin learns how many patients, never who: no name, no id, no
-- record. The move rewrites only each patient's doctor; every plan,
-- prescription, note and appointment keeps the doctor who wrote it. It is
-- audited twice over: one administration entry with the doctors and the
-- count, and the patient trigger's usual clinical entry per patient, which
-- records that `doc_id` changed and not its value.

create or replace function public.admin_doctor_patient_count(target_doc_id uuid)
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

  -- Another clinic's doctor is reported exactly as a doctor that does not
  -- exist, so the answer reveals nothing about other clinics.
  if not found or doctor_row.clinic_id is distinct from this_clinic then
    raise exception 'That doctor account could not be found'
      using errcode = 'no_data_found';
  end if;

  if doctor_row.doc_is_active then
    raise exception 'Only a deactivated doctor''s patients can be reassigned'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return (select count(*)::integer from public.patient p
           where p.doc_id = target_doc_id);
end;
$$;

comment on function public.admin_doctor_patient_count(uuid) is
  'D8. How many patients a deactivated doctor in the caller''s clinic has. '
  'A count only, for Clinic Admins only.';

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

-- Called over RPC, like the other administrator functions: refused to anon,
-- and each one checks its caller in its own body.
revoke all on function
  public.admin_dashboard_stats(),
  public.admin_chatbot_usage(integer),
  public.admin_doctor_patient_count(uuid),
  public.admin_reassign_doctor_patients(uuid, uuid, integer)
  from public, anon;

grant execute on function
  public.admin_dashboard_stats(),
  public.admin_chatbot_usage(integer),
  public.admin_doctor_patient_count(uuid),
  public.admin_reassign_doctor_patients(uuid, uuid, integer)
  to authenticated;
