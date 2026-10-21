import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture } from './helpers/fixtures'
import { assuredSuperAdmin, type Claims } from './helpers/super-admin'

/**
 * Migration 39: a change of the platform's guidance assistant switch is
 * listed for the Super Admin with the name of the field it changed.
 *
 * Migration 35 keeps a changed field's name only if it is a column of a table
 * in `public`, and migration 38 put the switch in
 * `app_private.platform_setting`, so every update of it came back with no
 * names at all. These tests turn the switch off and on again through
 * `super_admin_set_guidance_assistant`, read the trail through
 * `super_admin_list_audit` as the Data API would, and look for the field's
 * name - and for its values, 'true' and 'false', which must never come back.
 * The rest of `app_private` stays out, and so does anything planted in an
 * entry's details.
 */

const MIGRATION_33 = '20260902100033'
const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'
const MIGRATION_38 = '20260902100038'
const MIGRATION_39 = '20260902100039'
const ROLLBACK_39 = 'supabase/rollbacks/20260902100039_platform_setting_audit_field_names.down.sql'

type Entry = {
  audit_log_id: string
  audit_log_action: string
  audit_log_entity: string
  audit_log_details: unknown
}

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const list = (database: TestDatabase, claims: Claims) =>
  database.asClaims<Entry>(claims, 'select * from public.super_admin_list_audit(200)')

/** Off, then on again: the switch's row is created, then its value updated. */
async function switchOffAndOn(database: TestDatabase, claims: Claims) {
  await database.asClaims(claims, 'select public.super_admin_set_guidance_assistant(false)')
  await database.asClaims(claims, 'select public.super_admin_set_guidance_assistant(true)')
}

/** The switch's entries in the Super Admin's read, oldest first. */
const switchEntries = async (database: TestDatabase, claims: Claims) =>
  (await list(database, claims)).filter((entry) => entry.audit_log_entity === 'platform_setting').reverse()

/** An entry's details as stored, values and all. */
const stored = async (database: TestDatabase, auditLogId: string) =>
  (
    await database.asService<{ details: Record<string, unknown> | null }>(
      'select audit_log_details as details from public.audit_log where audit_log_id = $1',
      [auditLogId],
    )
  )[0]!.details

/** Every audit row as stored, details and all. */
const auditRows = (database: TestDatabase) =>
  database.asService(
    `select audit_log_id, user_id, audit_log_action, audit_log_entity, audit_log_entity_id,
            audit_log_timestamp, audit_log_details, audit_scope::text as scope, clinic_id
       from public.audit_log order by audit_log_id`,
  )

/** Neither of the switch's values, as a string or as a boolean, anywhere in what the read returned. */
function expectNoSwitchValue(entries: Entry[]) {
  expect(JSON.stringify(entries.map((entry) => entry.audit_log_details))).not.toMatch(/true|false/)
}

describe('the platform switch in the Super Admin’s audit read, after migration 39', () => {
  let database: TestDatabase
  let superAdmin: { claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    superAdmin = await assuredSuperAdmin(database)
    await switchOffAndOn(database, superAdmin.claims)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('names platform_setting_value among the fields the update changed, and never its value', async () => {
    const entries = await switchEntries(database, superAdmin.claims)
    expect(entries.map((entry) => entry.audit_log_action)).toEqual(['insert', 'update'])
    const [created, update] = entries

    // The values are in the audit log itself - the test would prove nothing otherwise.
    expect(await stored(database, created!.audit_log_id)).toMatchObject({
      record: { platform_setting_value: 'false' },
    })
    const recorded = await stored(database, update!.audit_log_id)
    expect(recorded).toMatchObject({
      before: { platform_setting_value: 'false' },
      after: { platform_setting_value: 'true' },
    })

    // The created row is listed with no details; the update with the names
    // the trigger recorded - the value's among them - and nothing else.
    expect(created!.audit_log_details).toBeNull()
    expect(update!.audit_log_details).toEqual({ changed_columns: recorded!['changed_columns'] })
    expect((update!.audit_log_details as { changed_columns: string[] }).changed_columns).toContain(
      'platform_setting_value',
    )

    expectNoSwitchValue(entries)
    expectNoSwitchValue(await list(database, superAdmin.claims))
  })

  it('names the columns of the switch’s table, and of no other table in app_private, and no value written there', async () => {
    // A column that exists only in app_private, outside the allow-list.
    await database.asService('create table app_private.audit_probe (probe_private_only text)')
    try {
      const [planted] = await database.asService<{ id: string; scope: string }>(
        `insert into public.audit_log (user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details)
         values (null, 'update', 'platform_setting', gen_random_uuid(), $1::jsonb)
         returning audit_log_id as id, audit_scope::text as scope`,
        [
          JSON.stringify({
            changed_columns: [
              'platform_setting_value',
              'probe_private_only',
              'true',
              'false',
              true,
              false,
              'guidance_assistant.enabled',
              { platform_setting_value: 'true' },
              'platform_setting_id',
              'platform_setting_key',
              'platform_setting_updated_by',
              'platform_setting_updated_at',
              'platform_setting_value',
            ],
            before: { platform_setting_value: 'true' },
            after: { platform_setting_value: 'false' },
          }),
        ],
      )
      expect(planted!.scope).toBe('platform')

      const entry = (await list(database, superAdmin.claims)).find((row) => row.audit_log_id === planted!.id)
      expect(entry!.audit_log_details).toEqual({
        changed_columns: [
          'platform_setting_value',
          'platform_setting_id',
          'platform_setting_key',
          'platform_setting_updated_by',
          'platform_setting_updated_at',
        ],
      })
      expectNoSwitchValue([entry!])
    } finally {
      await database.asService('drop table app_private.audit_probe')
    }
  })

  it('is still no API role’s to call', async () => {
    expect(
      await database.asService(
        `select r.rolname as role,
                has_function_privilege(r.rolname, 'app_private.audit_changed_field_names(jsonb)', 'EXECUTE') as helper
           from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
          order by 1`,
      ),
    ).toEqual([
      { role: 'anon', helper: false },
      { role: 'authenticated', helper: false },
      { role: 'service_role', helper: false },
    ])
  })
})

describe('migration 39 beside the others', () => {
  it('refuses to run without migration 35, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: MIGRATION_34 })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_39)).rejects.toThrow(/needs migration 35 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('refuses to run without migration 38, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: MIGRATION_37 })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_39)).rejects.toThrow(/needs migration 38 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('goes in after 38 with 34 still unapplied, as production has them: earlier entries gain their names, none is rewritten; then the same schema once 34 follows', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      // The repository's order, up to 39: what this test compares is 34 and 39.
      createTestDatabase({ stopAfter: MIGRATION_39 }),
    ])
    try {
      await seedFixture(production)
      await production.applyMigration(MIGRATION_35)
      await production.applyMigration(MIGRATION_36)
      await production.applyMigration(MIGRATION_37)
      await production.applyMigration(MIGRATION_38)
      const superAdmin = await assuredSuperAdmin(production)
      await switchOffAndOn(production, superAdmin.claims)

      // What production returns today: the update, with no field names.
      const [, before] = await switchEntries(production, superAdmin.claims)
      expect(before!.audit_log_action).toBe('update')
      expect(before!.audit_log_details).toBeNull()
      const rowsBefore = await auditRows(production)

      await production.applyMigration(MIGRATION_39)

      expect(await auditRows(production)).toEqual(rowsBefore)
      const entries = await switchEntries(production, superAdmin.claims)
      expect(entries.map((entry) => entry.audit_log_id)).toEqual([expect.any(String), before!.audit_log_id])
      expect((entries[1]!.audit_log_details as { changed_columns: string[] }).changed_columns).toContain(
        'platform_setting_value',
      )
      expectNoSwitchValue(await list(production, superAdmin.claims))

      await production.applyMigration(MIGRATION_34)
      expect(await catalog(production)).toEqual(await catalog(repository))
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})

describe('the down-script for migration 39', () => {
  let used: TestDatabase
  let through38: TestDatabase
  let superAdmin: { claims: Claims }

  beforeAll(async () => {
    ;[used, through38] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_39 }),
      createTestDatabase({ stopAfter: MIGRATION_38 }),
    ])
    superAdmin = await assuredSuperAdmin(used)
    await switchOffAndOn(used, superAdmin.claims)
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through38?.close()])
  })

  it('returns the schema to exactly what 38 left, with migration 35’s function, and keeps every row', async () => {
    const rowsBefore = await auditRows(used)

    await used.db.exec(await script(ROLLBACK_39))

    // The catalog covers app_private's functions: body, settings and grants.
    expect(await catalog(used)).toEqual(await catalog(through38))
    expect(await auditRows(used)).toEqual(rowsBefore)
    // As before 39: the update listed, with no field names and no value.
    const [, update] = await switchEntries(used, superAdmin.claims)
    expect(update!.audit_log_action).toBe('update')
    expect(update!.audit_log_details).toBeNull()
    expectNoSwitchValue(await list(used, superAdmin.claims))
  })

  it('refuses, changing nothing, where migration 39 is not applied', async () => {
    const before = await catalog(through38)
    await expect(through38.db.exec(await script(ROLLBACK_39))).rejects.toThrow(/Migration 39 is not applied/)
    expect(await catalog(through38)).toEqual(before)
  })
})
