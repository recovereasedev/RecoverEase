import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../supabase/migrations', import.meta.url),
)

/**
 * Supabase provides an `auth` schema, an `auth.uid()` function and the
 * `anon` / `authenticated` / `service_role` roles. PGlite is plain
 * PostgreSQL, so this recreates just enough of that surface for the
 * migrations and the RLS policies to behave exactly as they do in production.
 *
 * `auth.uid()` is reimplemented with the same semantics Supabase uses: read
 * the `sub` claim out of the `request.jwt.claims` setting. That is what makes
 * it possible to impersonate a real user below.
 */
const SUPABASE_COMPAT = `
  create schema if not exists auth;

  create table if not exists auth.users (
    id    uuid primary key,
    email text not null
  );

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    -- Returns NULL when there is no session, matching Supabase.
    --
    -- The coalesce to '{}' matters: an unauthenticated request leaves
    -- request.jwt.claims empty, and casting '' to json raises "invalid input
    -- syntax for type json". That error would surface as a thrown query,
    -- which a denial-checking assertion happily accepts — so anonymous tests
    -- would pass without RLS having refused anything. Returning NULL cleanly
    -- forces the policies themselves to do the denying.
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claims', true), ''),
        '{}'
      )::json ->> 'sub',
      ''
    )::uuid;
  $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin bypassrls;
    end if;
  end
  $$;

  grant usage on schema public to anon, authenticated, service_role;

  -- Supabase grants these so that policies and SECURITY INVOKER triggers can
  -- call auth.uid(). Note what is deliberately NOT granted: SELECT on
  -- auth.users. A signed-in role can resolve its own id and nothing more,
  -- which is exactly the production posture.
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`

/**
 * Supabase grants table privileges to `anon` and `authenticated` by default;
 * RLS then decides which rows those roles actually see. Reproduce that, or
 * every policy test would fail on a plain permission error and prove nothing
 * about the policies themselves.
 */
const GRANT_TABLE_PRIVILEGES = `
  grant select, insert, update, delete
    on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
  grant all on all tables in schema public to service_role;
`

export type TestDatabase = {
  readonly db: PGlite
  /** Run SQL as the trusted owner, bypassing RLS. For fixtures and setup. */
  asService: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>
  /** Run SQL as a signed-in user, with every RLS policy applied. */
  asUser: <T = Record<string, unknown>>(
    userId: string,
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>
  /** Run SQL with no session at all, as an unauthenticated visitor. */
  asAnon: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>
  close: () => Promise<void>
}

/** Returns migration files in filename order, which is apply order. */
async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  const files = entries.filter((name) => name.endsWith('.sql')).sort()

  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8'),
    })),
  )
}

/**
 * Boots an in-process PostgreSQL, applies every migration in order, and
 * returns handles for querying it as different principals.
 *
 * Every migration is replayed from the files that ship in the repository, so
 * a test failing here means the migrations themselves are wrong — not a
 * hand-maintained copy of them.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = new PGlite()
  await db.waitReady

  await db.exec(SUPABASE_COMPAT)

  for (const migration of await readMigrations()) {
    try {
      await db.exec(migration.sql)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Migration ${migration.name} failed: ${reason}`)
    }
  }

  await db.exec(GRANT_TABLE_PRIVILEGES)

  const asService = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const result = await db.query<T>(sql, params)
    return result.rows
  }

  /**
   * Impersonation runs inside a transaction so that `set local` reverts
   * automatically, and so a policy denial cannot leave the session in a
   * half-configured state that bleeds into the next assertion.
   */
  const runAs = async <T = Record<string, unknown>>(
    userId: string | null,
    role: 'authenticated' | 'anon',
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    await db.exec('begin')
    try {
      const claims = userId === null ? '' : JSON.stringify({ sub: userId })
      await db.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        claims,
      ])
      await db.exec(`set local role ${role}`)

      const result = await db.query<T>(sql, params)
      await db.exec('commit')
      return result.rows
    } catch (error) {
      await db.exec('rollback')
      throw error
    }
  }

  return {
    db,
    asService,
    asUser: (userId, sql, params) =>
      runAs(userId, 'authenticated', sql, params),
    asAnon: (sql, params) => runAs(null, 'anon', sql, params),
    close: () => db.close(),
  }
}

/**
 * Asserts that a statement is refused. Row Level Security has two distinct
 * refusal shapes and a test that only checks one of them is weak:
 *
 *   - a blocked SELECT or UPDATE returns zero rows, silently;
 *   - a blocked INSERT raises "violates row-level security policy".
 *
 * `expectDenied` treats both as denial, and — importantly — treats a
 * successful statement that returned rows as a failure.
 */
export async function expectDenied(
  run: () => Promise<unknown[]>,
): Promise<void> {
  let rows: unknown[]

  try {
    rows = await run()
  } catch {
    return // Raised: denied.
  }

  if (rows.length > 0) {
    throw new Error(
      `Expected the operation to be denied, but it returned ${rows.length} row(s).`,
    )
  }
}
