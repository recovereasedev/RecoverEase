-- ===========================================================================
-- RecoverEase — 39. The platform switch's audit entries name what changed
-- ===========================================================================
-- Migration 35 made `super_admin_list_audit` return, of an entry's details,
-- only the names of the fields an update changed, keeping a name only if it
-- is a column of a table in `public`. Migration 38 then put the platform's
-- guidance assistant switch in `app_private.platform_setting`, outside
-- `public`, so every change of that switch came back with no field names at
-- all: the entry was there, with nothing saying what changed, and the
-- console's label for `platform_setting_value` ('on or off') could never
-- show. No value reached anyone; the entry was incomplete.
--
-- Now `app_private.audit_changed_field_names` also keeps the names of the
-- columns of the tables it lists by name outside `public`: only
-- `app_private.platform_setting`, not the rest of `app_private`. Everything
-- else is as migration 35 left it:
--   * only `changed_columns` is read, only strings naming a real column of
--     one of those tables are kept, in the order recorded, each once - never
--     a value, so the switch's 'true' and 'false' still never come back;
--   * `super_admin_list_audit` itself, its arguments, columns, grants,
--     filter, order and paging, so the website already deployed works as it
--     is and no Edge Function changes;
--   * the audit log: no entry is rewritten. An entry written before this is
--     read through the same function, so its field names show from now on.
--
-- Needs migrations 35 and 38 and refuses to run without them. Independent of
-- 34 (tests/db/platform-setting-audit-field-names.test.ts applies it after
-- 38 with 34 unapplied, as production has them). It takes no lock on a
-- table: it replaces one function that no job and no policy calls.
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100039_platform_setting_audit_field_names.down.sql,
-- applied as a new migration with approval. It restores migration 35's
-- function.
-- ===========================================================================

-- The function this replaces, and the table it adds, must be there:
-- migrations 35 and 38 first.
do $$
begin
  if to_regprocedure('app_private.audit_changed_field_names(jsonb)') is null then
    raise exception 'Migration 39 needs migration 35 first. Nothing was applied.';
  end if;

  if to_regclass('app_private.platform_setting') is null then
    raise exception 'Migration 39 needs migration 38 first. Nothing was applied.';
  end if;
end
$$;

-- Migration 35's function, with one table added by name. A name is kept if
-- it is a column of a table in `public`, or of a table listed here - the
-- platform's own settings, which a Super Admin changes and the platform
-- audit trail records - and nothing else in `app_private`. Matched by name,
-- not by reference, so this keeps working, keeping nothing for it, should
-- the table be removed.
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
              where (
                      n.nspname = 'public'
                      -- Outside public, these tables only.
                      or (n.nspname, c.relname) in (('app_private', 'platform_setting'))
                    )
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
  'its changed_columns that name a column of a public table or of '
  'app_private.platform_setting - as {"changed_columns": [...]}, or NULL. '
  'Never a value from the details.';

-- Unchanged from migration 35, restated: no API role calls it.
revoke all on function app_private.audit_changed_field_names(jsonb)
  from public, anon, authenticated, service_role;
