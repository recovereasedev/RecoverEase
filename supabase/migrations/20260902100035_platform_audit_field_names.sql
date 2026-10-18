-- ===========================================================================
-- RecoverEase — 28. The platform audit trail names fields, never their values
-- ===========================================================================
-- After Phase A, PR 5. `super_admin_list_audit` (migration 33) returned each
-- platform entry's stored details as they are: a created or deleted row's
-- values (`record`), an update's `before` and `after`, and whatever a
-- function or Edge Function recorded - a clinic's name, an announcement's
-- title and message, an account's role, a clinic's id. The console shows only
-- the names of the fields an update changed, so the rest reached the browser
-- for nothing, hidden only by the page.
--
-- Now the database returns, in that column, only those names:
-- `{"changed_columns": [...]}`, or NULL when there are none. A name is kept
-- only if it is a string naming a column of a table in `public`, so nothing
-- else written into an entry's details - a value, an object, an address -
-- can come back, wherever it was put.
--
-- Nothing else changes:
--   * the same arguments and columns, so the website already deployed works
--     as it is and needs no redeploy, and the grants stay as they were;
--   * `app_private.require_super_admin()` first, then the same page-size
--     check, the same platform-only filter, newest first, keyset-paged;
--   * the audit log itself: no entry is rewritten or removed, the triggers
--     record what they did, and a Clinic Admin's audit log is untouched.
--
-- Independent of migration 34: neither reads or changes anything the other
-- does, so this goes in before or after it, and the single-clinic gate stays
-- until 34 is separately approved. tests/db/platform-audit-field-names.test.ts
-- applies both orders and compares the schemas.
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql,
-- applied as a new migration with approval. It restores migration 33's
-- function, values and all.
-- ===========================================================================

-- The function this replaces must be there: migration 33 first.
do $$
begin
  if to_regprocedure('public.super_admin_list_audit(integer, timestamptz, uuid)') is null then
    raise exception 'Migration 35 needs migration 33 first. Nothing was applied.';
  end if;
end
$$;

-- The names of the fields an update changed, from an entry's details, and
-- nothing else from them. Only `changed_columns` is read - the list
-- `audit_row_change` writes for an update - and of it only strings that name
-- a column of a table in `public`; anything else, a value placed there
-- included, is dropped. In the order recorded, each once.
create or replace function app_private.audit_changed_field_names(details jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with listed as (
    select e.element #>> '{}' as name, e.ordinal
      from jsonb_array_elements(
             case
               when jsonb_typeof(details -> 'changed_columns') = 'array'
                 then details -> 'changed_columns'
               else '[]'::jsonb
             end
           ) with ordinality as e(element, ordinal)
     where jsonb_typeof(e.element) = 'string'
  ),
  named as (
    select l.name, min(l.ordinal) as ordinal
      from listed l
     where exists (
             select 1
               from pg_catalog.pg_attribute a
               join pg_catalog.pg_class c on c.oid = a.attrelid
               join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public'
                and c.relkind in ('r', 'p')
                and a.attnum > 0
                and not a.attisdropped
                and a.attname = l.name
           )
     group by l.name
  )
  select case
           when count(*) = 0 then null
           else jsonb_build_object('changed_columns', jsonb_agg(named.name order by named.ordinal))
         end
    from named;
$$;

comment on function app_private.audit_changed_field_names(jsonb) is
  'The names of the fields an audit entry''s update changed - only strings in '
  'its changed_columns that name a column of a public table - as '
  '{"changed_columns": [...]}, or NULL. Never a value from the details.';

revoke all on function app_private.audit_changed_field_names(jsonb)
  from public, anon, authenticated, service_role;

-- Migration 33's function, returning names in place of the stored details.
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
           -- Names only, never a stored value.
           app_private.audit_changed_field_names(l.audit_log_details)
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
  'timestamp and id. Super Admin only. audit_log_details carries only the '
  'names of the fields an update changed, never a stored value.';

-- Unchanged from migration 33, restated: refused to anon, for a signed-in
-- caller to try, and the function checks that caller first.
revoke all on function public.super_admin_list_audit(integer, timestamptz, uuid)
  from public, anon;
grant execute on function public.super_admin_list_audit(integer, timestamptz, uuid)
  to authenticated;
