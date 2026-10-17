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

  -- The columns of Supabase's auth.users that the migrations read. Supabase
  -- keeps app_metadata in raw_app_meta_data, writable only with the service
  -- key.
  create table if not exists auth.users (
    id                uuid primary key,
    email             text not null,
    raw_app_meta_data jsonb not null default '{}'::jsonb,
    created_at        timestamptz not null default now(),
    banned_until      timestamptz,
    deleted_at        timestamptz
  );

  -- Supabase Auth's sessions and MFA records, as far as the Super Admin
  -- checks (migration 33) read them. Same names, types and enum labels as
  -- production (read from kwsezszstdagzllbyjuk on 2026-10-17); GoTrue itself
  -- is not here, so tests write these rows the way it would.
  create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
  create type auth.factor_type as enum ('totp', 'webauthn', 'phone', 'recovery_code');
  create type auth.factor_status as enum ('unverified', 'verified');

  create table if not exists auth.mfa_factors (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users (id) on delete cascade,
    friendly_name text,
    factor_type   auth.factor_type not null,
    status        auth.factor_status not null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
  );

  create table if not exists auth.sessions (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    factor_id  uuid,
    aal        auth.aal_level,
    not_after  timestamptz
  );

  create table if not exists auth.mfa_amr_claims (
    id                    uuid primary key default gen_random_uuid(),
    session_id            uuid not null references auth.sessions (id) on delete cascade,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    authentication_method text not null
  );

  -- Supabase's definition: the verified JWT's claims, as PostgREST sets them.
  create or replace function auth.jwt()
  returns jsonb
  language sql
  stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb;
  $$;

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
  grant execute on function auth.jwt() to anon, authenticated, service_role;
`

/**
 * Supabase grants table privileges to `anon` and `authenticated` by default;
 * RLS then decides which rows those roles actually see. Reproduce that, or
 * every policy test would fail on a plain permission error and prove nothing
 * about the policies themselves.
 *
 * Granted as default privileges before the migrations run, which is how
 * Supabase does it: each table gets them when it is created, so a migration
 * that later revokes one (migration 27 revokes writes on `user_account`) is
 * tested as it behaves in production. Granting after the migrations would
 * silently undo every such revoke.
 */
const GRANT_TABLE_PRIVILEGES = `
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
  alter default privileges in schema public
    grant usage, select on sequences to authenticated;
  alter default privileges in schema public
    grant all on tables to service_role;
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
  /**
   * Run SQL as `authenticated` with exactly these JWT claims - a session id,
   * an assurance level, or a `sub` that disagrees with them - for the checks
   * that read more of the token than its subject.
   */
  asClaims: <T = Record<string, unknown>>(
    claims: Record<string, unknown>,
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>
  /**
   * Applies one migration file, named by its version prefix, exactly as the
   * replay does. For a database built with `stopAfter`; the error is the
   * migration's own, so a test can assert why it refused.
   */
  applyMigration: (version: string) => Promise<void>
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
 *
 * `anonTablePrivileges` additionally gives `anon` what Supabase gives it on
 * every public table — every table privilege, with RLS deciding the rows —
 * so a test can prove that a migration's REVOKE from `anon` really holds.
 * It is opt-in because several suites assert that an anonymous UPDATE
 * raises, which is only true while `anon` holds no UPDATE privilege.
 *
 * `stopAfter` (a version prefix such as '20260902100028') stops the replay
 * after that migration, so a test can describe an earlier schema, or seed
 * data before the next migration and watch what it does to it.
 */
export async function createTestDatabase(
  options: { anonTablePrivileges?: boolean; stopAfter?: string } = {},
): Promise<TestDatabase> {
  const db = new PGlite()
  await db.waitReady

  await db.exec(SUPABASE_COMPAT)
  await db.exec(GRANT_TABLE_PRIVILEGES)
  if (options.anonTablePrivileges) {
    await db.exec('alter default privileges in schema public grant all on tables to anon;')
  }

  const migrations = await readMigrations()
  const replayed =
    options.stopAfter === undefined
      ? migrations
      : migrations.filter((migration) => migrationVersion(migration.name) <= options.stopAfter!)

  for (const migration of replayed) {
    try {
      await db.exec(migration.sql)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Migration ${migration.name} failed: ${reason}`)
    }
  }

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
    who: string | Record<string, unknown> | null,
    role: 'authenticated' | 'anon',
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    await db.exec('begin')
    try {
      const claims =
        who === null ? '' : JSON.stringify(typeof who === 'string' ? { sub: who } : who)
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

  const applyMigration = async (version: string): Promise<void> => {
    const migration = migrations.find((m) => migrationVersion(m.name) === version)
    if (!migration) throw new Error(`No migration with version ${version}`)
    await db.exec(migration.sql)
  }

  return {
    db,
    asService,
    asUser: (userId, sql, params) =>
      runAs(userId, 'authenticated', sql, params),
    asAnon: (sql, params) => runAs(null, 'anon', sql, params),
    asClaims: (claims, sql, params) => runAs(claims, 'authenticated', sql, params),
    applyMigration,
    close: () => db.close(),
  }
}

/** The version prefix of a migration file: everything before the first `_`. */
function migrationVersion(name: string): string {
  return name.split('_', 1)[0]!
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
