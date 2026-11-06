import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import {
  assuredSuperAdmin,
  claimsFor,
  createSignIn,
  enrolTotp,
  openSession,
  verifiedSession,
  type Claims,
} from './helpers/super-admin'

/**
 * Clinic details (migration 47): a clinic's Clinic Admins, and renaming a
 * clinic. Renaming only: a clinic's time zone is read-only to the Super
 * Admin until the medication scheduler can follow a zone change without
 * duplicating doses, so the rename must never touch the zone, the legacy
 * app.timezone setting or any clinical row.
 *
 * Called directly, as the Data API would, by an assured Super Admin and by
 * everyone who must be refused. A second clinic (Alder) is created so that
 * each call can be shown to reach the clinic it names and no other. The
 * fixture's people carry names, emails and ids; only Clinic Admin names may
 * come back.
 */

const REFUSED = { code: '42501' }
const NOT_FOUND = { code: 'P0002' }
const INVALID = { code: '23514' }
const DUPLICATE = { code: '23505' }

const MIGRATION_47 = 'supabase/migrations/20260902100047_super_admin_clinic_details.sql'
const ROLLBACK_47 = 'supabase/rollbacks/20260902100047_super_admin_clinic_details.down.sql'
const MISSING_CLINIC = '00000000-0000-4000-8000-0000000000c1'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

type ClinicRow = {
  clinic_id: string
  clinic_name: string
  clinic_status: string
  clinic_timezone: string
  clinic_created_at: string
  clinic_updated_at: string
  clinic_admin_count: number
}

type AdminRow = {
  admin_first_name: string
  admin_last_name: string
  admin_created_at: string
  has_signed_in: boolean
  last_signed_in_at: string | null
}

/** Every clinic as the database has it, plus the legacy time zone alias. */
const clinics = (database: TestDatabase) =>
  database.asService<Record<string, unknown>>(
    `select c.clinic_id, c.clinic_name, c.clinic_status::text as status, c.clinic_timezone,
            c.clinic_created_at::text as created, c.clinic_updated_at::text as updated,
            (select s.system_setting_value from public.system_setting s
              where s.clinic_id = c.clinic_id and s.system_setting_key = 'app.timezone') as alias
       from public.clinic c order by c.clinic_name`,
  )

/** The medication, appointment and dose rows a rename must never touch. */
const clinicalRows = async (database: TestDatabase) =>
  (await database.asService<Record<string, unknown>>(
    `select
       (select coalesce(md5(string_agg(row(l.*)::text, '|' order by l.medication_log_id)), '') from public.medication_log l) as doses,
       (select coalesce(md5(string_agg(row(s.*)::text, '|' order by s.medication_schedule_id)), '') from public.medication_schedule s) as schedules,
       (select coalesce(md5(string_agg(row(p.*)::text, '|' order by p.prescription_id)), '') from public.prescription p) as prescriptions,
       (select coalesce(md5(string_agg(row(a.*)::text, '|' order by a.appointment_id)), '') from public.appointment a) as appointments,
       (select count(*)::int from public.medication_log) as dose_count`,
  ))[0]!

const auditCount = async (database: TestDatabase) =>
  (await database.asService<{ n: number }>('select count(*)::int as n from public.audit_log'))[0]!.n

describe('clinic details', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; superAdminId: string; claims: Claims }
  let harborview: string
  let alder: string

  const listAdmins = (claims: Claims, clinicId: string | null) =>
    database.asClaims<AdminRow>(claims, 'select * from public.super_admin_list_clinic_admins($1)', [clinicId])

  const rename = (claims: Claims, clinicId: string | null, name: string | null) =>
    database.asClaims<ClinicRow>(claims, 'select * from public.super_admin_rename_clinic($1, $2)', [clinicId, name])

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    harborview = (await database.asService<{ id: string }>('select clinic_id as id from public.clinic'))[0]!.id

    // Production still has the legacy app.timezone row (migration 31's
    // alias); the fixture does not, so it is written here as it is there.
    await database.asService(
      `insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
       values ($1, 'app.timezone', 'Asia/Manila')`,
      [harborview],
    )

    const [second] = await database.asClaims<{ clinic_id: string }>(
      superAdmin.claims,
      `select clinic_id from public.super_admin_create_clinic('Alder Clinic', 'Asia/Singapore')`,
    )
    alder = second!.clinic_id
    const login = await createSignIn(database, 'zoe.admin@alder.test', {
      provisioned_as: 'clinic_admin',
      provisioned_clinic: alder,
    })
    await database.asClaims(superAdmin.claims, `select public.super_admin_attach_clinic_admin($1, $2, 'Zoe', 'Abad')`, [
      login,
      alder,
    ])
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('listing a clinic’s Clinic Admins', () => {
    it('lists only the named clinic’s Clinic Admins, with the sign-in Supabase Auth recorded', async () => {
      expect(await listAdmins(superAdmin.claims, harborview)).toEqual([
        expect.objectContaining({ admin_first_name: 'Ada', admin_last_name: 'Reyes', has_signed_in: false, last_signed_in_at: null }),
      ])
      expect(await listAdmins(superAdmin.claims, alder)).toEqual([
        expect.objectContaining({ admin_first_name: 'Zoe', admin_last_name: 'Abad', has_signed_in: false }),
      ])

      await database.asService(`update auth.users set last_sign_in_at = '2026-11-01T02:00:00Z' where id = $1`, [fx.adminUserId])
      const [ada] = await listAdmins(superAdmin.claims, harborview)
      expect(ada!.has_signed_in).toBe(true)
      expect(new Date(ada!.last_signed_in_at!).toISOString()).toBe('2026-11-01T02:00:00.000Z')
    })

    it('returns names and dates only: no email, account id, profile id or anything clinical', async () => {
      const rows = await listAdmins(superAdmin.claims, harborview)
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          ['admin_created_at', 'admin_first_name', 'admin_last_name', 'has_signed_in', 'last_signed_in_at'],
        )
      }
      const text = JSON.stringify([...rows, ...(await listAdmins(superAdmin.claims, alder))])
      const forbidden = await database.asService<{ v: string }>(
        `select v from (
           select user_id::text as v from public.user_account union all select user_email from public.user_account
           union all select admin_id::text from public.admin union all select clinic_id::text from public.clinic
           union all select pat_first_name from public.patient union all select pat_last_name from public.patient
           union all select doc_first_name from public.doctor union all select doc_license_no from public.doctor
           union all select treatment_plan_title from public.treatment_plan
         ) planted where v is not null`,
      )
      expect(forbidden.length).toBeGreaterThan(20)
      for (const { v } of forbidden) expect(text, v).not.toContain(v)
    })

    it('leaves out an account whose role is not Clinic Admin, as the clinic count does', async () => {
      // A profile left on an account whose role is no longer admin is not
      // counted by super_admin_list_clinics, and is not listed either.
      const [counted] = await database.asClaims<ClinicRow>(
        superAdmin.claims,
        'select * from public.super_admin_list_clinics() where clinic_id = $1',
        [harborview],
      )
      expect((await listAdmins(superAdmin.claims, harborview)).length).toBe(counted!.clinic_admin_count)
    })

    it('says an unknown or missing clinic could not be found, rather than listing nobody', async () => {
      await expect(listAdmins(superAdmin.claims, MISSING_CLINIC)).rejects.toMatchObject(NOT_FOUND)
      await expect(listAdmins(superAdmin.claims, null)).rejects.toMatchObject(NOT_FOUND)
    })
  })

  describe('renaming a clinic', () => {
    let before: Record<string, unknown>[]

    beforeEach(async () => {
      before = await clinics(database)
    })

    it('renames a clinic, trimmed, keeping its id, status, time zone and creation time, and audits it as a platform entry', async () => {
      const audits = await auditCount(database)
      const [row] = await rename(superAdmin.claims, harborview, '  Harborview Recovery Centre  ')
      expect(row).toMatchObject({
        clinic_id: harborview,
        clinic_name: 'Harborview Recovery Centre',
        clinic_status: 'active',
        clinic_timezone: 'Asia/Manila',
        clinic_admin_count: 1,
      })

      const after = await clinics(database)
      const was = before.find((c) => c.clinic_id === harborview)!
      const now = after.find((c) => c.clinic_id === harborview)!
      expect(now).toMatchObject({ clinic_name: 'Harborview Recovery Centre', status: was.status, clinic_timezone: 'Asia/Manila', created: was.created, alias: 'Asia/Manila' })
      expect(now.updated).not.toBe(was.updated)
      // The other clinic is exactly as it was.
      expect(after.find((c) => c.clinic_id === alder)).toEqual(before.find((c) => c.clinic_id === alder))

      // One entry, the clinic row's own, under the Super Admin, in the
      // platform's audit trail - and readable there. Only the name changed.
      expect(await auditCount(database)).toBe(audits + 1)
      const [entry] = await database.asService<Record<string, unknown>>(
        `select user_id, audit_log_action as action, audit_log_entity as entity, audit_log_entity_id as entity_id,
                audit_scope::text as scope, clinic_id, audit_log_details as details
           from public.audit_log order by audit_log_timestamp desc, audit_log_id desc limit 1`,
      )
      expect(entry).toMatchObject({
        user_id: superAdmin.userId,
        action: 'update',
        entity: 'clinic',
        entity_id: harborview,
        scope: 'platform',
        clinic_id: harborview,
      })
      expect(entry!.details).toMatchObject({
        before: { clinic_name: was.clinic_name },
        after: { clinic_name: 'Harborview Recovery Centre' },
      })
      const details = entry!.details as { before: Record<string, unknown>; after: Record<string, unknown> }
      expect(details.after.clinic_timezone ?? details.before.clinic_timezone ?? 'Asia/Manila').toBe('Asia/Manila')
      expect(details.before.clinic_status ?? 'active').toBe(details.after.clinic_status ?? 'active')
      const trail = await database.asClaims<{ entity: string; entity_id: string }>(
        superAdmin.claims,
        `select audit_log_entity as entity, audit_log_entity_id as entity_id from public.super_admin_list_audit() where audit_log_entity = 'clinic'`,
      )
      expect(trail.some((e) => e.entity_id === harborview)).toBe(true)
    })

    it('renames an inactive clinic and leaves it inactive', async () => {
      await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'inactive')`, [alder])
      try {
        const [row] = await rename(superAdmin.claims, alder, 'Alder Recovery Clinic')
        expect(row).toMatchObject({ clinic_id: alder, clinic_name: 'Alder Recovery Clinic', clinic_status: 'inactive', clinic_timezone: 'Asia/Singapore' })
      } finally {
        await rename(superAdmin.claims, alder, 'Alder Clinic')
        await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'active')`, [alder])
      }
    })

    it('accepts a change of case to the clinic’s own name', async () => {
      const [row] = await rename(superAdmin.claims, harborview, 'HARBORVIEW Recovery Centre')
      expect(row!.clinic_name).toBe('HARBORVIEW Recovery Centre')
      await rename(superAdmin.claims, harborview, 'Harborview Recovery Centre')
    })

    it('refuses an empty, blank, too long or taken name, changing and auditing nothing', async () => {
      const audits = await auditCount(database)
      const clinical = await clinicalRows(database)
      const cases: [string, string | null, { code: string }][] = [
        ['no name', null, INVALID],
        ['an empty name', '', INVALID],
        ['a blank name', '   ', INVALID],
        ['a name of 121 characters', 'x'.repeat(121), INVALID],
        ['another clinic’s name, in another case', '  alder clinic ', DUPLICATE],
      ]
      for (const [why, name, error] of cases) {
        await expect(rename(superAdmin.claims, harborview, name), why).rejects.toMatchObject(error)
      }
      expect(await clinics(database)).toEqual(before)
      expect(await clinicalRows(database)).toEqual(clinical)
      expect(await auditCount(database)).toBe(audits)
    })

    it('stores a name that looks like SQL as plain text', async () => {
      const odd = `Harbor'; drop table public.clinic; --`
      expect((await rename(superAdmin.claims, harborview, odd))[0]!.clinic_name).toBe(odd)
      expect((await clinics(database)).length).toBe(before.length)
      await rename(superAdmin.claims, harborview, 'Harborview Recovery Centre')
    })

    it('accepts a name of exactly 120 characters', async () => {
      const long = 'H'.repeat(120)
      expect((await rename(superAdmin.claims, harborview, long))[0]!.clinic_name).toBe(long)
      await rename(superAdmin.claims, harborview, 'Harborview Recovery Centre')
    })

    it('says an unknown clinic could not be found, creating nothing', async () => {
      await expect(rename(superAdmin.claims, MISSING_CLINIC, 'Ghost Clinic')).rejects.toMatchObject(NOT_FOUND)
      await expect(rename(superAdmin.claims, null, 'Ghost Clinic')).rejects.toMatchObject(NOT_FOUND)
      expect(await clinics(database)).toEqual(before)
    })

    it('writes and audits nothing when the name does not change', async () => {
      const audits = await auditCount(database)
      const current = before.find((c) => c.clinic_id === harborview)!
      await rename(superAdmin.claims, harborview, `  ${current.clinic_name as string} `)
      expect(await clinics(database)).toEqual(before)
      expect(await auditCount(database)).toBe(audits)
    })
  })

  describe('a clinic’s time zone stays read-only to the Super Admin', () => {
    it('offers no way to change it: no time zone parameter, and no three-argument edit function', async () => {
      expect(
        await database.asService(
          `select to_regprocedure('public.super_admin_update_clinic(uuid, text, text)') is null as no_edit,
                  (select array_agg(n order by n) from unnest(p.proargnames) n) as args, p.pronargs as arity
             from pg_proc p where p.oid = 'public.super_admin_rename_clinic(uuid, text)'::regprocedure`,
        ),
      ).toEqual([{ no_edit: true, args: ['clinic_admin_count', 'clinic_created_at', 'clinic_id', 'clinic_name', 'clinic_status', 'clinic_timezone', 'clinic_updated_at', 'new_clinic_name', 'target_clinic_id'], arity: 2 }])
      // A third argument, as the earlier draft took, is not a function at all.
      await expect(
        database.asClaims(superAdmin.claims, `select * from public.super_admin_rename_clinic($1, 'Harborview Recovery Centre', 'UTC')`, [harborview]),
      ).rejects.toMatchObject({ code: '42883' })
      expect((await clinics(database)).find((c) => c.clinic_id === harborview)).toMatchObject({ clinic_timezone: 'Asia/Manila', alias: 'Asia/Manila' })
    })

    it('never writes the clinic’s time zone or the legacy app.timezone setting, even when they disagree', async () => {
      // Out of step on purpose, written by the owner below the triggers that
      // would otherwise sync it: a rename must leave both exactly as found.
      await database.asService(`alter table public.system_setting disable trigger system_setting_sync_clinic_timezone`)
      await database.asService(
        `update public.system_setting set system_setting_value = 'Asia/Tokyo' where clinic_id = $1 and system_setting_key = 'app.timezone'`,
        [harborview],
      )
      await database.asService(`alter table public.system_setting enable trigger system_setting_sync_clinic_timezone`)
      const settings = async () =>
        database.asService<Record<string, unknown>>(
          `select clinic_id, system_setting_key, system_setting_value, system_setting_updated_at::text as updated
             from public.system_setting order by clinic_id, system_setting_key`,
        )
      try {
        const settingsBefore = await settings()
        const audits = await auditCount(database)
        await rename(superAdmin.claims, harborview, 'Harborview Renamed')
        expect((await clinics(database)).find((c) => c.clinic_id === harborview)).toMatchObject({
          clinic_name: 'Harborview Renamed',
          clinic_timezone: 'Asia/Manila',
          alias: 'Asia/Tokyo',
        })
        expect(await settings()).toEqual(settingsBefore)
        // Only the clinic's own entry: no system_setting entry.
        expect(await auditCount(database)).toBe(audits + 1)
        const [last] = await database.asService<{ entity: string }>(
          `select audit_log_entity as entity from public.audit_log order by audit_log_timestamp desc, audit_log_id desc limit 1`,
        )
        expect(last!.entity).toBe('clinic')
      } finally {
        await rename(superAdmin.claims, harborview, 'Harborview Recovery Centre')
        await database.asService(`alter table public.system_setting disable trigger system_setting_sync_clinic_timezone`)
        await database.asService(
          `update public.system_setting set system_setting_value = 'Asia/Manila' where clinic_id = $1 and system_setting_key = 'app.timezone'`,
          [harborview],
        )
        await database.asService(`alter table public.system_setting enable trigger system_setting_sync_clinic_timezone`)
      }
    })

    it('leaves every scheduled dose, schedule, prescription and appointment exactly as it was', async () => {
      const before = await clinicalRows(database)
      expect(before.dose_count).toBeGreaterThan(0)
      await rename(superAdmin.claims, harborview, 'Harborview Dose Check')
      expect(await clinicalRows(database)).toEqual(before)
      // Nor does the nightly extension afterwards add anything a rename
      // caused: the zone the doses were made in is unchanged.
      await database.asService('select public.extend_all_medication_log_slots(30)')
      const extended = await clinicalRows(database)
      expect(extended.dose_count).toBe(before.dose_count)
      await rename(superAdmin.claims, harborview, 'Harborview Recovery Centre')
      expect(await clinicalRows(database)).toEqual(extended)
    })
  })

  describe('who may call them', () => {
    const everyCall = (clinicId: string): [string, string, unknown[]][] => [
      ['list Clinic Admins', 'select * from public.super_admin_list_clinic_admins($1)', [clinicId]],
      ['rename a clinic', `select * from public.super_admin_rename_clinic($1, 'Refused Name')`, [clinicId]],
    ]

    it('refuses anonymous callers outright', async () => {
      for (const [what, sql, params] of everyCall(harborview)) {
        await expect(database.asAnon(sql, params), what).rejects.toMatchObject(REFUSED)
      }
    })

    it('refuses a patient, a doctor and a Clinic Admin - their own clinic included - changing nothing', async () => {
      const before = await clinics(database)
      const audits = await auditCount(database)
      for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.doctorCUserId, fx.adminUserId]) {
        const claims = await verifiedSession(database, userId)
        for (const [what, sql, params] of everyCall(harborview)) {
          await expect(database.asClaims(claims, sql, params), `${what} as ${userId}`).rejects.toMatchObject(REFUSED)
          await expect(database.asUser(userId, sql, params), `${what} as ${userId}`).rejects.toMatchObject(REFUSED)
        }
      }
      expect(await clinics(database)).toEqual(before)
      expect(await auditCount(database)).toBe(audits)
    })

    it('refuses a Super Admin whose session falls short of a verified authenticator of their own', async () => {
      const userId = superAdmin.userId
      const ownFactor = await enrolTotp(database, userId)
      const someoneElsesFactor = await enrolTotp(database, fx.aliceUserId)
      const raised = (shape: Parameters<typeof openSession>[2] = {}) =>
        openSession(database, userId, { aal: 'aal2', factorId: ownFactor, methods: ['password', 'totp'], ...shape })
      const cases: [string, Claims][] = [
        ['signed in with a password only (aal1)', claimsFor(userId, await openSession(database, userId), 'aal1')],
        ['a token claiming aal2 for a session that is still aal1', claimsFor(userId, await openSession(database, userId), 'aal2')],
        ['no session in the token', claimsFor(userId, null)],
        ['a session past its not_after', claimsFor(userId, await raised({ notAfter: '2020-01-01T00:00:00Z' }))],
        ['a session raised with another user’s factor', claimsFor(userId, await raised({ factorId: someoneElsesFactor }))],
        ['a session never verified with an authenticator code', claimsFor(userId, await raised({ methods: ['password'] }))],
      ]
      const before = await clinics(database)
      for (const [why, claims] of cases) {
        for (const [what, sql, params] of everyCall(harborview)) {
          await expect(database.asClaims(claims, sql, params), `${what}: ${why}`).rejects.toMatchObject(REFUSED)
        }
      }
      expect(await clinics(database)).toEqual(before)
    })

    it('checks the caller before the clinic: an unknown clinic is refused, not reported missing, to anyone else', async () => {
      const claims = await verifiedSession(database, fx.adminUserId)
      for (const [what, sql, params] of everyCall(MISSING_CLINIC)) {
        await expect(database.asClaims(claims, sql, params), what).rejects.toMatchObject(REFUSED)
      }
    })

    it('are SECURITY DEFINER with an empty search_path, refused to anon, granted to signed-in callers', async () => {
      expect(
        await database.asService(
          `select p.proname as name, p.prosecdef as definer, array_to_string(p.proconfig, ',') as path,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('public', p.oid, 'execute') as public,
                  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                  p.provolatile as volatility
             from pg_proc p
            where p.oid in ('public.super_admin_list_clinic_admins(uuid)'::regprocedure,
                            'public.super_admin_rename_clinic(uuid, text)'::regprocedure)
            order by p.proname`,
        ),
      ).toEqual([
        { name: 'super_admin_list_clinic_admins', definer: true, path: 'search_path=""', anon: false, public: false, authenticated: true, volatility: 's' },
        { name: 'super_admin_rename_clinic', definer: true, path: 'search_path=""', anon: false, public: false, authenticated: true, volatility: 'v' },
      ])
    })
  })
})

describe('rolling back migration 47', () => {
  let database: TestDatabase
  let without47: TestDatabase

  beforeAll(async () => {
    ;[database, without47] = await Promise.all([
      createTestDatabase({ stopAfter: '20260902100047' }),
      createTestDatabase({ stopAfter: '20260902100046' }),
    ])
  })

  afterAll(async () => {
    await Promise.all([database?.close(), without47?.close()])
  })

  it('removes both functions and nothing else, keeps a renamed clinic and its audit entry, then refuses a second time', async () => {
    await seedFixture(database)
    const superAdmin = await assuredSuperAdmin(database)
    const [{ id }] = await database.asService<{ id: string }>('select clinic_id as id from public.clinic')
    await database.asClaims(superAdmin.claims, `select * from public.super_admin_rename_clinic($1, 'Renamed Clinic')`, [id])

    await database.db.exec(await script(ROLLBACK_47))
    expect(await catalog(database)).toEqual(await catalog(without47))
    expect(await database.asService('select clinic_name, clinic_timezone from public.clinic')).toEqual([
      { clinic_name: 'Renamed Clinic', clinic_timezone: 'Asia/Manila' },
    ])
    expect(
      await database.asService(`select count(*)::int as n from public.audit_log where audit_log_entity = 'clinic' and audit_log_action = 'update'`),
    ).toEqual([{ n: 1 }])

    const before = await catalog(database)
    await expect(database.db.exec(await script(ROLLBACK_47))).rejects.toThrow(/Migration 47 is not applied/)
    expect(await catalog(database)).toEqual(before)
  })

  it('can be applied again after it, as it was', async () => {
    await database.db.exec(await script(MIGRATION_47))
    expect(
      await database.asService(
        `select to_regprocedure('public.super_admin_rename_clinic(uuid, text)') is not null as rename,
                to_regprocedure('public.super_admin_list_clinic_admins(uuid)') is not null as list`,
      ),
    ).toEqual([{ rename: true, list: true }])
  })
})
