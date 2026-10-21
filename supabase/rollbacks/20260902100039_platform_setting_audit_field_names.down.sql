-- ===========================================================================
-- Rollback of migration 39 (platform_setting_audit_field_names)
-- ===========================================================================
-- Restores migration 35's `app_private.audit_changed_field_names`, which
-- keeps only the names of columns of tables in `public`, returning the schema
-- to exactly what 38 left (tests/db/platform-setting-audit-field-names.test.ts).
-- Applied as a new migration, with approval. Roll this back before 38's and
-- 35's.
--
-- No code goes back: the website and the Edge Functions work with either
-- version. Once this has run, a change of the platform's guidance assistant
-- switch is listed for the Super Admin with no field names again - the
-- entry, and never a value. No row changes: migration 39 rewrote no audit
-- entry.
-- ===========================================================================

-- 39 is installed when the function lists the platform's settings table.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = to_regprocedure('app_private.audit_changed_field_names(jsonb)')
       and p.prosrc like '%(''app_private'', ''platform_setting'')%'
  ) then
    raise exception 'Migration 39 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Migration 35's function and comment, exactly as it wrote them.
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
