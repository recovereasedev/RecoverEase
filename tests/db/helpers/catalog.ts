import type { TestDatabase } from './database'

/**
 * Everything that defines the schema's behaviour, in a comparable form:
 * policies, functions (body, security, volatility, settings and grants),
 * columns, triggers, indexes and enum values. A rollback is correct when it
 * returns this to exactly what the earlier migration left.
 */
export const CATALOG = `
  select 'policy' as kind, tablename || '.' || policyname as name,
         cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '-')
           || ' ' || coalesce(with_check, '-') as detail
    from pg_policies where schemaname = 'public'
  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(p.prosrc) || ' definer=' || p.prosecdef || ' ' || p.provolatile::text
           || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
           || ' acl=' || coalesce(array_to_string(p.proacl, ','), '-')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private')
  union all
  select 'column', table_name || '.' || column_name,
         data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-')
    from information_schema.columns where table_schema = 'public'
  union all
  select 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
  union all
  select 'index', indexname, indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'enum', t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_enum e on e.enumtypid = t.oid
   where t.typnamespace = 'public'::regnamespace
   group by t.typname
  order by 1, 2
`

export const catalog = (database: TestDatabase) =>
  database.asService<{ kind: string; name: string; detail: string }>(CATALOG)
