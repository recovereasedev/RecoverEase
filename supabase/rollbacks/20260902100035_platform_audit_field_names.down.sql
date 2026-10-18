-- ===========================================================================
-- Rollback of migration 35 (platform_audit_field_names)
-- ===========================================================================
-- Restores migration 33's `super_admin_list_audit`, which returns each
-- platform entry's stored details as they are, values included, and drops
-- the helper 35 added. The schema is then exactly what migration 34 (or 33,
-- where 34 is not applied) left, catalog entry by catalog entry
-- (tests/db/platform-audit-field-names.test.ts). Applied as a new migration,
-- with approval. Roll this back before 34's and 33's.
--
-- No row changes: migration 35 rewrote no audit entry, so there is nothing
-- to put back.
-- ===========================================================================

do $$
begin
  if to_regprocedure('app_private.audit_changed_field_names(jsonb)') is null then
    raise exception 'Migration 35 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Migration 33's function and comment, exactly as it wrote them.
-- The platform entries, newest first, a page at a time. Never an
-- administration or clinical entry: the scope is filtered here, not by the
-- caller.
create or replace function public.super_admin_list_audit(
  page_size        integer default 50,
  before_timestamp timestamptz default null,
  before_id        uuid default null
)
returns table (
  audit_log_id        uuid,
  audit_log_timestamp timestamptz,
  audit_log_action    text,
  audit_log_entity    text,
  audit_log_entity_id uuid,
  clinic_id           uuid,
  actor_user_id       uuid,
  audit_log_details   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app_private.require_super_admin();

  if page_size is null or page_size < 1 or page_size > 200 then
    raise exception 'Ask for between 1 and 200 entries'
      using errcode = 'check_violation';
  end if;

  return query
    select l.audit_log_id, l.audit_log_timestamp, l.audit_log_action,
           l.audit_log_entity, l.audit_log_entity_id, l.clinic_id, l.user_id,
           l.audit_log_details
      from public.audit_log l
     where l.audit_scope = 'platform'
       and (
         before_timestamp is null
         or (l.audit_log_timestamp, l.audit_log_id)
            < (before_timestamp, coalesce(before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
       )
     order by l.audit_log_timestamp desc, l.audit_log_id desc
     limit page_size;
end;
$$;

comment on function public.super_admin_list_audit(integer, timestamptz, uuid) is
  'Platform audit entries only - clinics, Super Admins, Clinic Admin '
  'provisioning, platform announcements - newest first, keyset-paged by '
  'timestamp and id. Super Admin only.';

drop function app_private.audit_changed_field_names(jsonb);
