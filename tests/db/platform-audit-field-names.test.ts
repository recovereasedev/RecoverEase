import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, createSignIn, verifiedSession, type Claims } from './helpers/super-admin'

/**
 * Migration 35: the Super Admin's audit read returns the names of the fields
 * an update changed, never a value from an entry's details.
 *
 * Migration 33's `super_admin_list_audit` returned each platform entry's
 * stored details - a created row's values, an update's before and after -
 * and the console hid them. These tests call the function directly, as the
 * Data API would, so nothing the page does or does not show comes into it.
 * They also hold everything else as it was: the other columns, the
 * platform-only filter, the order and the paging, the Super Admin check, the
 * audit log's own rows, and migration 34 still to come, in either order.
 */

const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const ROLLBACK_35 = 'supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql'
const REFUSED = { code: '42501' }

/** Migration 33's body of super_admin_list_audit: what production runs before 35. */
const MIGRATION_33_BODY_MD5 = '24daddb05a2151878d8a9fc51fd84f86'

type Entry = {
  audit_log_id: string
  audit_log_timestamp: string
  audit_log_action: string
  audit_log_entity: string
  audit_log_entity_id: string | null
  clinic_id: string | null
  actor_user_id: string | null
  audit_log_details: unknown
}

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const list = (
  database: TestDatabase,
  claims: Claims,
  size = 200,
  beforeTimestamp: unknown = null,
  beforeId: string | null = null,
) =>
  database.asClaims<Entry>(claims, 'select * from public.super_admin_list_audit($1, $2, $3)', [
    size,
    beforeTimestamp,
    beforeId,
  ])

/** Every audit row as stored, details and all. */
const auditRows = (database: TestDatabase) =>
  database.asService(
    `select audit_log_id, user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
            audit_log_timestamp, audit_log_details, audit_scope::text as scope, clinic_id
       from public.audit_log order by audit_log_id`,
  )

const listBodyMd5 = (database: TestDatabase) =>
  one<string>(
    database,
    `select md5(prosrc) from pg_proc
      where oid = 'public.super_admin_list_audit(integer, timestamptz, uuid)'::regprocedure`,
  )

/**
 * Platform entries of every kind the Super Admin makes - a clinic's status
 * changed and back, a platform announcement drafted, edited and published, a
 * Clinic Admin provisioned - with a clinical and an administration entry
 * beside them, which the Super Admin never sees.
 */
async function platformActivity(database: TestDatabase, fx: Fixture, superAdmin: { claims: Claims }) {
  const clinic = (
    await database.asService<{ id: string; name: string; zone: string }>(
      'select clinic_id as id, clinic_name as name, clinic_timezone as zone from public.clinic',
    )
  )[0]!
  const as = (sql: string, params: unknown[] = []) => database.asClaims(superAdmin.claims, sql, params)

  await as(`select * from public.super_admin_set_clinic_status($1, 'inactive')`, [clinic.id])
  await as(`select * from public.super_admin_set_clinic_status($1, 'active')`, [clinic.id])
  const [{ id: announcementId }] = await database.asClaims<{ id: string }>(
    superAdmin.claims,
    `select public.super_admin_create_announcement('Maintenance window', 'Planned downtime on Sunday', false) as id`,
  )
  await as(`select public.super_admin_update_announcement($1, 'Maintenance moved', 'Planned downtime on Monday')`, [
    announcementId,
  ])
  await as('select public.super_admin_set_announcement_published($1, true)', [announcementId])
  const login = await createSignIn(database, 'second.admin@harborview.test', {
    provisioned_as: 'clinic_admin',
    provisioned_clinic: clinic.id,
  })
  await as(`select public.super_admin_attach_clinic_admin($1, $2, 'Second', 'Admin')`, [login, clinic.id])

  await database.asUser(fx.doctorAUserId, `update public.patient set pat_last_name = 'Reyes' where pat_id = $1`, [
    fx.alicePatId,
  ])
  await database.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Singapore')`)

  return { clinic, announcementId }
}

/** What the Super Admin's read may carry in place of an entry's details. */
function expectNamesOnly(details: unknown): string[] {
  if (details === null) return []
  expect(details).toEqual({ changed_columns: expect.any(Array) })
  const names = (details as { changed_columns: unknown[] }).changed_columns
  for (const name of names) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/)
  return names as string[]
}

describe('the Super Admin’s platform audit read, after migration 35', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; claims: Claims }
  let activity: Awaited<ReturnType<typeof platformActivity>>

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    activity = await platformActivity(database, fx, superAdmin)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('returns the names of the fields each update changed, and no stored value', async () => {
    const entries = await list(database, superAdmin.claims)
    const stored = new Map(
      (
        await database.asService<{ id: string; details: Record<string, unknown> | null }>(
          `select audit_log_id as id, audit_log_details as details from public.audit_log where audit_scope = 'platform'`,
        )
      ).map((row) => [row.id, row.details]),
    )

    // The values are in the audit log - the test would prove nothing otherwise.
    const storedText = JSON.stringify([...stored.values()])
    for (const value of ['Maintenance moved', 'Planned downtime on Monday', 'inactive', activity.clinic.name]) {
      expect(storedText).toContain(value)
    }

    for (const entry of entries) {
      const names = expectNamesOnly(entry.audit_log_details)
      const recorded = stored.get(entry.audit_log_id)?.['changed_columns']
      expect(names).toEqual(Array.isArray(recorded) ? recorded : [])
    }

    const statusChanges = entries.filter(
      (entry) =>
        entry.audit_log_entity === 'clinic' &&
        entry.audit_log_action === 'update' &&
        expectNamesOnly(entry.audit_log_details).includes('clinic_status'),
    )
    expect(statusChanges).toHaveLength(2)
    const edit = entries.find(
      (entry) =>
        entry.audit_log_entity === 'announcement' &&
        entry.audit_log_action === 'update' &&
        expectNamesOnly(entry.audit_log_details).includes('announcement_title'),
    )
    expect(expectNamesOnly(edit!.audit_log_details)).toEqual(
      expect.arrayContaining(['announcement_content', 'announcement_title']),
    )

    // Created rows are listed with no details at all: none of their values.
    for (const entry of entries.filter((entry) => ['insert', 'create'].includes(entry.audit_log_action))) {
      expect(entry.audit_log_details).toBeNull()
    }

    const payload = JSON.stringify(entries)
    for (const value of [
      'Maintenance window',
      'Maintenance moved',
      'Planned downtime on Sunday',
      'Planned downtime on Monday',
      'inactive',
      activity.clinic.name,
      activity.clinic.zone,
      'Asia/Singapore',
      'second.admin@harborview.test',
      'super.admin@platform.test',
      '"record"',
      '"before"',
      '"after"',
    ]) {
      expect(payload).not.toContain(value)
    }
  })

  it('never returns a value written into an entry’s details, wherever it was put', async () => {
    const written = await database.asService<{ id: string; scope: string }>(
      `insert into public.audit_log (user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details)
       values
         (null, 'update', 'clinic', $1, $2::jsonb),
         (null, 'update', 'clinic', $1, '"SENTINEL-scalar"'::jsonb),
         (null, 'update', 'clinic', $1, '["SENTINEL-array", "clinic_status"]'::jsonb),
         (null, 'update', 'clinic', $1, '{"changed_columns": "SENTINEL-not-a-list"}'::jsonb)
       returning audit_log_id as id, audit_scope::text as scope`,
      [
        activity.clinic.id,
        JSON.stringify({
          changed_columns: [
            'clinic_status',
            'SENTINEL in the list',
            'sentinel_identifier_shaped_value',
            'sentinel@example.invalid',
            42,
            true,
            null,
            { clinic_status: 'SENTINEL-object' },
            ['SENTINEL-nested-list'],
            'clinic_status',
            'clinic_name',
          ],
          before: { clinic_status: 'SENTINEL-before', clinic_name: 'SENTINEL-before-name' },
          after: { clinic_status: 'SENTINEL-after' },
          record: { clinic_name: 'SENTINEL-record' },
          columns: ['SENTINEL-columns'],
          note: 'SENTINEL-note',
          nested: { deeper: ['SENTINEL-deeper'] },
          'SENTINEL-key': 'SENTINEL-under-a-key',
        }),
      ],
    )
    expect(written.map((row) => row.scope)).toEqual(['platform', 'platform', 'platform', 'platform'])

    const entries = await list(database, superAdmin.claims)
    const byId = new Map(entries.map((entry) => [entry.audit_log_id, entry]))
    const [planted, scalar, array, notAList] = written.map((row) => byId.get(row.id)!)

    // Only real column names come back, each once, in the order recorded.
    expect(planted!.audit_log_details).toEqual({ changed_columns: ['clinic_status', 'clinic_name'] })
    expect(scalar!.audit_log_details).toBeNull()
    expect(array!.audit_log_details).toBeNull()
    expect(notAList!.audit_log_details).toBeNull()

    expect(JSON.stringify(entries)).not.toMatch(/sentinel/i)
    // Still in the audit log itself: nothing was rewritten.
    expect(JSON.stringify(await auditRows(database))).toMatch(/SENTINEL-record/)
  })

  it('keeps every other column, the platform-only filter, newest first and the paging', async () => {
    const entries = await list(database, superAdmin.claims)
    const direct = await database.asService(
      `select audit_log_id, audit_log_timestamp, audit_log_action, audit_log_entity, audit_log_entity_id,
              clinic_id, user_id as actor_user_id
         from public.audit_log
        where audit_scope = 'platform'
        order by audit_log_timestamp desc, audit_log_id desc`,
    )
    expect(entries.map(({ audit_log_details: _details, ...rest }) => rest)).toEqual(direct)
    expect(
      await one<number>(database, `select count(*)::int from public.audit_log where audit_scope <> 'platform'`),
    ).toBeGreaterThan(0)
    expect(new Set(entries.map((entry) => entry.audit_log_entity))).toEqual(
      new Set(['announcement', 'clinic', 'clinic_admin_account', 'super_admin', 'user_account']),
    )

    // One entry at a time, each page continuing after the last: the same
    // entries in the same order, none skipped or repeated.
    const walked: string[] = []
    let cursor: Entry | undefined
    for (;;) {
      const page = await list(database, superAdmin.claims, 1, cursor?.audit_log_timestamp ?? null, cursor?.audit_log_id ?? null)
      if (page.length === 0) break
      for (const entry of page) expectNamesOnly(entry.audit_log_details)
      walked.push(...page.map((entry) => entry.audit_log_id))
      cursor = page.at(-1)
    }
    expect(walked).toEqual(entries.map((entry) => entry.audit_log_id))

    const first = await list(database, superAdmin.claims, 3)
    const rest = await list(database, superAdmin.claims, 200, first.at(-1)!.audit_log_timestamp, first.at(-1)!.audit_log_id)
    expect([...first, ...rest]).toEqual(entries)

    await expect(list(database, superAdmin.claims, 0)).rejects.toMatchObject({ code: '23514' })
    await expect(list(database, superAdmin.claims, 201)).rejects.toMatchObject({ code: '23514' })
  })

  it('is still the Super Admin’s alone, in a session raised with their own authenticator', async () => {
    await expect(database.asAnon('select * from public.super_admin_list_audit()')).rejects.toMatchObject(REFUSED)
    const clinicAdmin = await verifiedSession(database, fx.adminUserId)
    await expect(list(database, clinicAdmin)).rejects.toMatchObject(REFUSED)
    await expect(list(database, { ...superAdmin.claims, aal: 'aal1' })).rejects.toMatchObject(REFUSED)
    await expect(list(database, { sub: superAdmin.userId, role: 'authenticated', aal: 'aal2' })).rejects.toMatchObject(
      REFUSED,
    )

    // The grants migration 33 made, and a helper no API role may call.
    expect(
      await database.asService(
        `select r.rolname as role,
                has_function_privilege(r.rolname, 'public.super_admin_list_audit(integer, timestamptz, uuid)', 'EXECUTE') as list,
                has_function_privilege(r.rolname, 'app_private.audit_changed_field_names(jsonb)', 'EXECUTE') as helper
           from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
          order by 1`,
      ),
    ).toEqual([
      { role: 'anon', list: false, helper: false },
      { role: 'authenticated', list: true, helper: false },
      { role: 'service_role', list: expect.any(Boolean), helper: false },
    ])
  })

  it('leaves a Clinic Admin’s audit log as it was: their clinic’s entries, values where it recorded them, no platform entry', async () => {
    const own = await database.asUser<{ entity: string; scope: string; details: Record<string, unknown> | null }>(
      fx.adminUserId,
      `select audit_log_entity as entity, audit_scope::text as scope, audit_log_details as details
         from public.audit_log`,
    )
    expect(own.length).toBeGreaterThan(0)
    expect(own.some((row) => row.scope === 'platform')).toBe(false)
    const zone = own.find((row) => row.entity === 'clinic_settings')
    expect(zone?.details).toMatchObject({ after: { clinic_timezone: 'Asia/Singapore' } })
  })
})

describe('migration 35 beside migration 34', () => {
  it('refuses to run without migration 33, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: '20260902100032' })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_35)).rejects.toThrow(/needs migration 33 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('goes in before 34, as production will have it: no entry rewritten, the gate still standing, then the same schema once 34 follows', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: '20260902100033' }),
      createTestDatabase(),
    ])
    try {
      const fx = await seedFixture(production)
      const superAdmin = await assuredSuperAdmin(production)
      await platformActivity(production, fx, superAdmin)
      expect(await listBodyMd5(production)).toBe(MIGRATION_33_BODY_MD5)
      const valuesBefore = JSON.stringify(await list(production, superAdmin.claims))
      expect(valuesBefore).toContain('Planned downtime on Monday')
      const rowsBefore = await auditRows(production)

      await production.applyMigration(MIGRATION_35)

      expect(await auditRows(production)).toEqual(rowsBefore)
      const after = await list(production, superAdmin.claims)
      for (const entry of after) expectNamesOnly(entry.audit_log_details)
      expect(JSON.stringify(after)).not.toContain('Planned downtime on Monday')
      expect(
        await one<number>(production, `select count(*)::int from pg_indexes where indexname = 'clinic_single_clinic_gate'`),
      ).toBe(1)
      await expect(
        production.asClaims(superAdmin.claims, `select * from public.super_admin_create_clinic('Second Clinic', 'UTC')`),
      ).rejects.toThrow(/clinic_single_clinic_gate/)

      await production.applyMigration(MIGRATION_34)

      expect(await catalog(production)).toEqual(await catalog(repository))
      for (const entry of await list(production, superAdmin.claims)) expectNamesOnly(entry.audit_log_details)
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})

describe('the down-script for migration 35', () => {
  let used: TestDatabase
  let through34: TestDatabase
  let superAdmin: { claims: Claims }

  beforeAll(async () => {
    ;[used, through34] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: MIGRATION_34 }),
    ])
    const fx = await seedFixture(used)
    superAdmin = await assuredSuperAdmin(used)
    await platformActivity(used, fx, superAdmin)
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through34?.close()])
  })

  it('returns the schema to exactly what 34 left, with migration 33’s function, and keeps every row', async () => {
    const rowsBefore = await auditRows(used)

    await used.db.exec(await script(ROLLBACK_35))

    expect(await catalog(used)).toEqual(await catalog(through34))
    expect(await listBodyMd5(used)).toBe(MIGRATION_33_BODY_MD5)
    expect(await auditRows(used)).toEqual(rowsBefore)
    expect(JSON.stringify(await list(used, superAdmin.claims))).toContain('Planned downtime on Monday')
  })

  it('refuses, changing nothing, where migration 35 is not applied', async () => {
    const before = await catalog(through34)
    await expect(through34.db.exec(await script(ROLLBACK_35))).rejects.toThrow(/Migration 35 is not applied/)
    expect(await catalog(through34)).toEqual(before)
  })
})
