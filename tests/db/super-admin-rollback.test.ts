import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, createSignIn, type Claims } from './helpers/super-admin'

/**
 * The down-scripts for migrations 34 and 33 (supabase/rollbacks), after 37's,
 * 36's and 35's, which go first.
 *
 * Run against a database that has been used - a Super Admin, a clinic's
 * status changed back and forth, a platform announcement written and
 * deleted, a Clinic Admin provisioned, settings saved - and compared, catalog
 * entry by catalog entry, with a database built only up to migration 32.
 * Migration 32's enum value is not rolled back (PostgreSQL cannot drop one);
 * the comparison includes the enum, so it shows that is all that remains.
 */

const ROLLBACK_37 = 'supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql'
const ROLLBACK_36 = 'supabase/rollbacks/20260902100036_doctor_announcements.down.sql'
const ROLLBACK_35 = 'supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql'
const ROLLBACK_34 = 'supabase/rollbacks/20260902100034_lift_single_clinic_gate.down.sql'
const ROLLBACK_33 = 'supabase/rollbacks/20260902100033_super_admin_platform.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** The rows a rollback must leave alone. */
const rows = async (database: TestDatabase) => ({
  accounts: await database.asService('select user_id, user_role::text, user_email from public.user_account order by 1'),
  admins: await database.asService('select admin_id, user_id, clinic_id from public.admin order by 1'),
  clinics: await database.asService('select clinic_id, clinic_name, clinic_status, clinic_timezone from public.clinic order by 1'),
  announcements: await database.asService('select announcement_id, admin_id, clinic_id, announcement_title from public.announcement order by 1'),
  settings: await database.asService('select system_setting_id, clinic_id, system_setting_key, system_setting_value from public.system_setting order by 1'),
  patients: await database.asService('select pat_id, user_id, doc_id from public.patient order by 1'),
  audit: await database.asService(
    `select audit_log_id, user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_scope::text, clinic_id
       from public.audit_log order by 1`,
  ),
})

describe('rolling back migrations 37, 36, 35, 34 and 33 with their down-scripts', () => {
  let used: TestDatabase
  let through32: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[used, through32] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: '20260902100032' }),
    ])
    fx = await seedFixture(used)
    const harborview = await one<string>(used, 'select clinic_id from public.clinic')
    const superAdmin = await assuredSuperAdmin(used)
    const as = (sql: string, params: unknown[] = []) => used.asClaims(superAdmin.claims, sql, params)

    await as(`select * from public.super_admin_set_clinic_status($1, 'inactive')`, [harborview])
    await as(`select * from public.super_admin_set_clinic_status($1, 'active')`, [harborview])
    const [{ id }] = await used.asClaims<{ id: string }>(
      superAdmin.claims,
      `select public.super_admin_create_announcement('Temporary', 'Withdrawn before the rollback', true) as id`,
    )
    await as('select public.super_admin_delete_announcement($1)', [id])
    const login = await createSignIn(used, 'second.admin@harborview.test', {
      provisioned_as: 'clinic_admin',
      provisioned_clinic: harborview,
    })
    await as(`select public.super_admin_attach_clinic_admin($1, $2, 'Second', 'Admin')`, [login, harborview])
    await used.asUser(
      fx.adminUserId,
      `insert into public.system_setting (system_setting_key, system_setting_value) values ('medication.reminder_grace_hours', '4')
       on conflict (clinic_id, system_setting_key) do update set system_setting_value = excluded.system_setting_value`,
    )

    // What the down-script for 33 asks for first: no Super Admin left.
    await used.asService('select app_private.revoke_super_admin($1)', [superAdmin.userId])
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through32?.close()])
  })

  it('returns the schema to exactly what 32 left, and keeps every row', async () => {
    const before = await rows(used)

    await used.db.exec(await script(ROLLBACK_37))
    await used.db.exec(await script(ROLLBACK_36))
    await used.db.exec(await script(ROLLBACK_35))
    await used.db.exec(await script(ROLLBACK_34))
    await used.db.exec(await script(ROLLBACK_33))

    expect(await catalog(used)).toEqual(await catalog(through32))
    expect(await rows(used)).toEqual(before)
    // The provisioned Clinic Admin is an ordinary one, and still works.
    expect(
      await used.asService(`select count(*)::int as n from public.admin a join public.user_account ua using (user_id) where ua.user_role = 'admin'`),
    ).toEqual([{ n: 2 }])
  })
})

describe('the down-scripts refuse, changing nothing, when they cannot be undone safely', () => {
  let database: TestDatabase
  let superAdmin: { userId: string; claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const refusedUnchanged = async (path: string, reason: RegExp) => {
    const before = await catalog(database)
    await expect(database.db.exec(await script(path))).rejects.toThrow(reason)
    expect(await catalog(database)).toEqual(before)
  }

  it('33’s, while 34 is still applied', async () => {
    await refusedUnchanged(ROLLBACK_33, /Roll back migration 34 first/)
  })

  it('34’s, once a second clinic exists', async () => {
    const [created] = await database.asClaims<{ clinic_id: string }>(
      superAdmin.claims,
      `select clinic_id from public.super_admin_create_clinic('Second Clinic', 'UTC')`,
    )
    await refusedUnchanged(ROLLBACK_34, /There are 2 clinics/)
    // Only to let the next test roll 34 back: the test's own database.
    await database.asService('delete from public.system_setting where clinic_id = $1', [created!.clinic_id])
    await database.asService('delete from public.audit_log where clinic_id = $1', [created!.clinic_id])
    await database.asService('delete from public.clinic where clinic_id = $1', [created!.clinic_id])
    await database.db.exec(await script(ROLLBACK_34))
  })

  it('33’s, while a Super Admin or a platform announcement exists', async () => {
    await refusedUnchanged(ROLLBACK_33, /A Super Admin exists/)

    await database.asClaims(superAdmin.claims, `select public.super_admin_create_announcement('Stays', 'Attributed', true)`)
    // A platform announcement keeps its author, so the account cannot be
    // revoked while it exists, and the rollback still refuses.
    await expect(
      database.asService('select app_private.revoke_super_admin($1)', [superAdmin.userId]),
    ).rejects.toMatchObject({ code: '23503' })
    await refusedUnchanged(ROLLBACK_33, /A Super Admin exists/)
  })
})
