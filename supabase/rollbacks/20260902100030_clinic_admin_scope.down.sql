-- ===========================================================================
-- Rollback of migration 30 (clinic_admin_scope)
-- ===========================================================================
-- Not a migration: nothing applies this automatically. Should 30 ever need
-- undoing, this is applied as a new migration with apply_migration, after
-- review and approval - never by repairing or deleting history. It returns
-- the schema to exactly what migration 29 left, which
-- tests/db/clinic-rollback.test.ts checks catalog entry by catalog entry.
--
-- No clinical row is touched. Patients moved with D8 stay with their new
-- doctor (move them back the same way if needed). Audit entries written
-- since 30 lose their scope and clinic with the columns; their content is
-- unchanged.
--
-- Order matters: the policies and functions that read the new columns go
-- first, then the columns.
-- ===========================================================================

drop function if exists public.admin_reassign_doctor_patients(uuid, uuid, integer);
drop function if exists public.admin_doctor_patient_count(uuid);

-- The dashboard and usage counts, platform-wide again: migration 07's text.

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

-- The ten administration policies: migration 06's text, and 11's for
-- report_insert.

drop policy if exists user_account_select on public.user_account;
create policy user_account_select
  on public.user_account for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
    or (select app_private.is_user_my_patient(user_id))
  );

drop policy if exists doctor_select on public.doctor;
create policy doctor_select
  on public.doctor for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
    or (select app_private.is_my_doctor(doc_id))
  );

drop policy if exists doctor_update_self_or_admin on public.doctor;
create policy doctor_update_self_or_admin
  on public.doctor for update to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
  )
  with check (
    user_id = (select auth.uid())
    or (select app_private.is_admin())
  );

drop policy if exists announcement_select_published on public.announcement;
create policy announcement_select_published
  on public.announcement for select to authenticated
  using (
    announcement_published_at is not null
    or (select app_private.is_admin())
  );

drop policy if exists announcement_insert_admin on public.announcement;
create policy announcement_insert_admin
  on public.announcement for insert to authenticated
  with check (
    (select app_private.is_admin())
    and admin_id = (select app_private.current_admin_id())
  );

drop policy if exists announcement_update_admin on public.announcement;
create policy announcement_update_admin
  on public.announcement for update to authenticated
  using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));

drop policy if exists announcement_delete_admin on public.announcement;
create policy announcement_delete_admin
  on public.announcement for delete to authenticated
  using ((select app_private.is_admin()));

drop policy if exists report_select on public.report;
create policy report_select
  on public.report for select to authenticated
  using (
    user_id = (select auth.uid())
    or (
      report_type = 'system_wide'
      and (select app_private.is_admin())
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
        and (select app_private.is_admin())
      )
    )
  );

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
  on public.audit_log for select to authenticated
  using ((select app_private.is_admin()));

drop trigger if exists report_assign_clinic on public.report;
drop trigger if exists announcement_assign_clinic on public.announcement;
drop trigger if exists audit_log_classify on public.audit_log;
drop function if exists public.report_assign_clinic();
drop function if exists public.announcement_assign_clinic();
drop function if exists public.audit_log_classify();
drop function if exists app_private.audit_clinic_for(text, uuid, uuid, jsonb);
drop function if exists app_private.audit_scope_for(text, uuid, jsonb);

alter table public.audit_log
  drop column if exists audit_scope,
  drop column if exists clinic_id;
alter table public.announcement drop column if exists clinic_id;
alter table public.report drop column if exists clinic_id;

drop type if exists public.audit_scope;
