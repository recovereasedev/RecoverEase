import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'

/**
 * These tests run every migration in the repository against a real PostgreSQL
 * and then assert structural facts about the result. They exist to catch the
 * two failure modes that reviewing SQL by eye does not: a migration that does
 * not apply at all, and a table that was added without Row Level Security.
 */
describe('database schema', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.close()
  })

  it('applies every migration cleanly', async () => {
    const tables = await database.asService<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )

    // 19 entities from the ERD plus chat_message, the one documented addition.
    expect(tables.map((row) => row.table_name)).toEqual([
      'admin',
      'announcement',
      'appointment',
      'audit_log',
      'chat_message',
      'chat_session',
      'doctor',
      'doctor_note',
      'medication_log',
      'medication_schedule',
      'notification',
      'patient',
      'prescription',
      'recovery_log',
      'report',
      'reschedule_request',
      'system_setting',
      'treatment_goal',
      'treatment_plan',
      'user_account',
    ])
  })

  it('enables row level security on every public table', async () => {
    const unprotected = await database.asService<{ tablename: string }>(
      `select tablename
         from pg_tables
        where schemaname = 'public' and not rowsecurity
        order by tablename`,
    )

    // A table in an exposed schema without RLS is readable by anyone holding
    // the publishable key. There is no acceptable exception.
    expect(unprotected.map((row) => row.tablename)).toEqual([])
  })

  it('defines at least one policy for every protected table', async () => {
    const withoutPolicies = await database.asService<{ tablename: string }>(
      `select t.tablename
         from pg_tables t
         left join pg_policies p
           on p.schemaname = t.schemaname and p.tablename = t.tablename
        where t.schemaname = 'public' and p.policyname is null
        order by t.tablename`,
    )

    expect(withoutPolicies.map((row) => row.tablename)).toEqual([])
  })

  it('keeps the audit log append-only for every role', async () => {
    const writePolicies = await database.asService<{ cmd: string }>(
      `select cmd
         from pg_policies
        where schemaname = 'public'
          and tablename = 'audit_log'
          and cmd in ('INSERT', 'UPDATE', 'DELETE')`,
    )

    // Rows are written by SECURITY DEFINER triggers only. If a policy ever
    // appears here, someone can forge or erase audit history.
    expect(writePolicies).toEqual([])
  })

  it('does not expose trigger functions as callable API endpoints', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC on every new function, and
    // PostgREST publishes anything in `public` as /rest/v1/rpc/<name>. That
    // turned every trigger function into a reachable endpoint — flagged by
    // the live Supabase advisor, three of them SECURITY DEFINER.
    //
    // Revoking does not stop triggers firing: PostgreSQL checks EXECUTE only
    // on a direct call, which is exactly the call being removed.
    const callable = await database.asService<{
      signature: string
      role: string
    }>(
      `select p.oid::regprocedure::text as signature, r.rolname as role
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join (values ('anon'), ('authenticated')) as r(rolname)
        where n.nspname = 'public'
          and p.prorettype = 'pg_catalog.trigger'::regtype
          and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
        order by 1, 2`,
    )

    expect(callable).toEqual([])
  })

  it('keeps a single INSERT policy per role on report', async () => {
    // Two permissive policies for the same role and action are both evaluated
    // on every insert. Flagged by the live performance advisor and merged
    // into one equivalent policy.
    const [row] = await database.asService<{ count: string }>(
      `select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'report' and cmd = 'INSERT'`,
    )

    expect(Number(row?.count)).toBe(1)
  })

  it('does not expose the authorization helper schema to the API', async () => {
    const granted = await database.asService<{ has_access: boolean }>(
      `select has_schema_privilege('anon', 'app_private', 'USAGE')
                as has_access`,
    )

    expect(granted[0]?.has_access).toBe(false)
  })

  it('indexes every foreign key whose parent rows can be deleted', async () => {
    // An unindexed foreign key makes PostgreSQL sequentially scan the child
    // table on every parent delete, and turns ownership lookups into scans.
    //
    // Indexing *every* foreign key regardless is cargo cult: an index that is
    // never read still costs a write on every insert and update. These
    // columns are exempt because their parent is never deleted (doctors and
    // administrators are deactivated, per module 11.3, not removed) and
    // because no module queries through them.
    const exemptions = new Set([
      'announcement.admin_id',
      'doctor_note.doc_id',
      'prescription.doc_id',
      'system_setting.admin_id',
      'treatment_plan.doc_id',
    ])

    const unindexed = await database.asService<{
      table_name: string
      column_name: string
    }>(
      `select cl.relname as table_name, att.attname as column_name
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
         join unnest(con.conkey) as fk_col on true
         join pg_attribute att
           on att.attrelid = con.conrelid and att.attnum = fk_col
        where con.contype = 'f'
          and ns.nspname = 'public'
          and not exists (
            select 1
              from pg_index idx
             where idx.indrelid = con.conrelid
               and idx.indkey[0] = fk_col
          )
        order by 1, 2`,
    )

    const offenders = unindexed
      .map((row) => `${row.table_name}.${row.column_name}`)
      .filter((key) => !exemptions.has(key))

    expect(offenders).toEqual([])
  })
})
