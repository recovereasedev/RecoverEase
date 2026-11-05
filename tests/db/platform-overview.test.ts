import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import {
  assuredSuperAdmin,
  claimsFor,
  enrolTotp,
  openSession,
  verifiedSession,
  type Claims,
} from './helpers/super-admin'

/**
 * The platform overview (migration 46): how many clinics, Clinic Admins,
 * doctors, patients and platform announcements there are - platform totals
 * only, never broken out by clinic, and never who.
 *
 * Called directly, as the Data API would, by an assured Super Admin and by
 * everyone who must be refused. The fixture's people all carry names, emails
 * and licence numbers, and its clinics names and ids; none of them may come
 * back.
 */

const REFUSED = { code: '42501' }
const MIGRATION_46 = 'supabase/migrations/20260902100046_super_admin_platform_overview.sql'
const ROLLBACK_46 = 'supabase/rollbacks/20260902100046_super_admin_platform_overview.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

type Overview = {
  clinics: { total: number; active: number; inactive: number }
  clinic_admins: number
  doctors: { total: number; active: number }
  patients: { total: number; active: number }
  announcements: { published: number; drafts: number }
  generated_at: string
}

const overview = async (database: TestDatabase, claims: Claims): Promise<Overview> =>
  (await database.asClaims<{ o: Overview }>(claims, 'select public.super_admin_platform_overview() as o'))[0]!.o

/** Everything a call must leave as it was: it writes nothing, audits nothing. */
const counts = (database: TestDatabase) =>
  database.asService(
    `select (select count(*) from public.clinic) as clinics, (select count(*) from public.announcement) as announcements,
            (select count(*) from public.user_account) as accounts, (select count(*) from public.patient) as patients,
            (select count(*) from public.doctor) as doctors, (select count(*) from public.audit_log) as audit`,
  )

describe('the platform overview', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; superAdminId: string; claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('counts the platform’s people as its one clinic’s Clinic Admin dashboard does', async () => {
    // The fixture: one Clinic Admin; doctors A and B active, C deactivated;
    // Alice and Bob with A, Carol with B, Dave with C - all four active.
    const result = await overview(database, superAdmin.claims)
    expect(result).toMatchObject({
      clinics: { total: 1, active: 1, inactive: 0 },
      clinic_admins: 1,
      doctors: { total: 3, active: 2 },
      patients: { total: 4, active: 4 },
      announcements: { published: 0, drafts: 0 },
    })
    expect(Number.isNaN(Date.parse(result.generated_at))).toBe(false)

    // With one clinic, the same figures its own Clinic Admin is shown.
    const [stats] = await database.asUser<{ s: { patients: { total: number; active: number }; doctors: { total: number; active: number } } }>(
      fx.adminUserId,
      'select public.admin_dashboard_stats() as s',
    )
    expect(stats!.s.patients).toEqual(result.patients)
    expect(stats!.s.doctors).toEqual(result.doctors)
  })

  it('totals every clinic together, with platform announcements counted apart from a clinic’s', async () => {
    const as = (sql: string, params: unknown[] = []) => database.asClaims(superAdmin.claims, sql, params)
    const [second] = await database.asClaims<{ clinic_id: string }>(
      superAdmin.claims,
      `select clinic_id from public.super_admin_create_clinic('Alder Clinic', 'Asia/Manila')`,
    )
    const alder = second!.clinic_id

    // One active and one deactivated doctor at Alder; one active and one
    // discharged patient with the active one. Written by the owner: what is
    // counted, not how it got there, is the subject here.
    const doctorUser = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'alder.doctor@alder.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'alder.doctor@alder.test', 'doctor')`,
      [doctorUser[0]!.id],
    )
    const alderDoctor = await one<string>(
      database,
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Ines', 'Ocampo', 'LIC-ALDER-1', $2) returning doc_id`,
      [doctorUser[0]!.id, alder],
    )
    const idleUser = await database.asService<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'alder.idle@alder.test') returning id`,
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'alder.idle@alder.test', 'doctor')`,
      [idleUser[0]!.id],
    )
    await database.asService(
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id, doc_is_active)
       values ($1, 'Jun', 'Vela', 'LIC-ALDER-2', $2, false)`,
      [idleUser[0]!.id, alder],
    )
    for (const [email, first, status] of [
      ['erin@alder.test', 'Erin', 'active'],
      ['finn@alder.test', 'Finn', 'discharged'],
    ] as const) {
      const user = await database.asService<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
        [email],
      )
      await database.asService(
        `insert into public.user_account (user_id, user_email, user_role) values ($1, $2, 'patient')`,
        [user[0]!.id, email],
      )
      await database.asService(
        `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at, pat_status)
         values ($1, $2, $3, 'Navarro', now(), $4)`,
        [user[0]!.id, alderDoctor, first, status],
      )
    }

    await as(`select * from public.super_admin_set_clinic_status($1, 'inactive')`, [alder])
    await as(`select public.super_admin_create_announcement('Maintenance', 'Tonight at ten', true)`)
    await as(`select public.super_admin_create_announcement('Draft', 'Not yet', false)`)
    // A clinic's own announcement is not a platform one.
    await database.asUser(
      fx.adminUserId,
      `insert into public.announcement (admin_id, announcement_title, announcement_content, announcement_published_at)
       values ($1, 'Clinic notice', 'For Harborview', now())`,
      [fx.adminId],
    )

    // Both clinics' people in one total each - Alder's inactive status and
    // all - and nothing said of either clinic on its own.
    expect(await overview(database, superAdmin.claims)).toMatchObject({
      clinics: { total: 2, active: 1, inactive: 1 },
      clinic_admins: 1,
      doctors: { total: 5, active: 3 },
      patients: { total: 6, active: 5 },
      announcements: { published: 1, drafts: 1 },
    })
  })

  it('returns platform totals only: no clinic broken out, and no person’s name, email, licence or id', async () => {
    const result = await overview(database, superAdmin.claims)
    // Exactly these fields, each a count (or the time it counted) - no list,
    // no per-clinic entry.
    expect(Object.keys(result).sort()).toEqual(
      ['announcements', 'clinic_admins', 'clinics', 'doctors', 'generated_at', 'patients'],
    )
    expect(Object.keys(result.clinics).sort()).toEqual(['active', 'inactive', 'total'])
    expect(Object.keys(result.doctors).sort()).toEqual(['active', 'total'])
    expect(Object.keys(result.patients).sort()).toEqual(['active', 'total'])
    expect(Object.keys(result.announcements).sort()).toEqual(['drafts', 'published'])
    const counts = [
      ...Object.values(result.clinics),
      result.clinic_admins,
      ...Object.values(result.doctors),
      ...Object.values(result.patients),
      ...Object.values(result.announcements),
    ]
    for (const count of counts) expect(Number.isInteger(count)).toBe(true)

    const text = JSON.stringify(result)
    // No clinic's id or name: the second test's Alder Clinic and Harborview
    // are both here by now.
    const clinics = await database.asService<{ id: string; name: string }>(
      'select clinic_id::text as id, clinic_name as name from public.clinic',
    )
    expect(clinics).toHaveLength(2)
    for (const clinic of clinics) {
      expect(text, clinic.name).not.toContain(clinic.id)
      expect(text, clinic.name).not.toContain(clinic.name)
    }
    expect(text).not.toMatch(/clinic_(id|name|status)/)

    const people = await database.asService<Record<string, string>>(
      `select ua.user_id::text as user_id, ua.user_email as email from public.user_account ua`,
    )
    const names = await database.asService<{ v: string }>(
      `select v from (
         select pat_id::text as v from public.patient union all select pat_first_name from public.patient
         union all select pat_last_name from public.patient
         union all select doc_id::text from public.doctor union all select doc_first_name from public.doctor
         union all select doc_last_name from public.doctor union all select doc_license_no from public.doctor
         union all select admin_id::text from public.admin union all select admin_first_name from public.admin
         union all select admin_last_name from public.admin
         union all select super_admin_id::text from public.super_admin
         union all select treatment_plan_title from public.treatment_plan
         union all select announcement_title from public.announcement
       ) planted where v is not null`,
    )
    const forbidden = [...people.flatMap((row) => [row.user_id!, row.email!]), ...names.map((row) => row.v)]
    expect(forbidden.length).toBeGreaterThan(20)
    for (const value of forbidden) {
      expect(text, value).not.toContain(value)
    }
  })

  it('writes nothing and records no audit entry', async () => {
    const before = await counts(database)
    await overview(database, superAdmin.claims)
    await overview(database, superAdmin.claims)
    expect(await counts(database)).toEqual(before)
    expect(
      await database.asService(
        `select provolatile as v from pg_proc where oid = 'public.super_admin_platform_overview()'::regprocedure`,
      ),
    ).toEqual([{ v: 's' }])
  })

  it('refuses anonymous callers outright', async () => {
    await expect(database.asAnon('select public.super_admin_platform_overview()')).rejects.toMatchObject(REFUSED)
  })

  it('refuses a patient, a doctor and a Clinic Admin, each with aal2 and a verified authenticator of their own', async () => {
    const before = await counts(database)
    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.doctorCUserId, fx.adminUserId]) {
      const claims = await verifiedSession(database, userId)
      await expect(overview(database, claims), userId).rejects.toMatchObject(REFUSED)
      // And as their ordinary selves, without a raised session.
      await expect(
        database.asUser(userId, 'select public.super_admin_platform_overview()'),
        userId,
      ).rejects.toMatchObject(REFUSED)
    }
    expect(await counts(database)).toEqual(before)
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
      ['a session that was signed out', claimsFor(userId, '00000000-0000-4000-8000-000000000001')],
      ['a session past its not_after', claimsFor(userId, await raised({ notAfter: '2020-01-01T00:00:00Z' }))],
      ['a session raised with another user’s factor', claimsFor(userId, await raised({ factorId: someoneElsesFactor }))],
      ['a session never verified with an authenticator code', claimsFor(userId, await raised({ methods: ['password'] }))],
      ['a token for another user with the Super Admin’s session', claimsFor(fx.aliceUserId, superAdmin.claims.session_id as string)],
    ]
    for (const [why, claims] of cases) {
      await expect(overview(database, claims), why).rejects.toMatchObject(REFUSED)
    }
  })

  it('refuses a banned Super Admin mid-session', async () => {
    const banned = await assuredSuperAdmin(database, 'banned.overview@platform.test')
    expect((await overview(database, banned.claims)).clinics.total).toBeGreaterThan(0)
    await database.asService(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [banned.userId])
    await expect(overview(database, banned.claims)).rejects.toMatchObject(REFUSED)
  })

  it('is SECURITY DEFINER with an empty search_path, refused to anon and service_role, granted to signed-in callers', async () => {
    expect(
      await database.asService(
        `select p.prosecdef as definer, array_to_string(p.proconfig, ',') as path,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated
           from pg_proc p where p.oid = 'public.super_admin_platform_overview()'::regprocedure`,
      ),
    ).toEqual([{ definer: true, path: 'search_path=""', anon: false, authenticated: true }])
  })
})

describe('rolling back migration 46', () => {
  let database: TestDatabase
  let without46: TestDatabase

  beforeAll(async () => {
    ;[database, without46] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: '20260902100045' }),
    ])
  })

  afterAll(async () => {
    await Promise.all([database?.close(), without46?.close()])
  })

  it('removes the function and nothing else, then refuses a second time, changing nothing', async () => {
    await database.db.exec(await script(ROLLBACK_46))
    expect(await catalog(database)).toEqual(await catalog(without46))

    const before = await catalog(database)
    await expect(database.db.exec(await script(ROLLBACK_46))).rejects.toThrow(/Migration 46 is not applied/)
    expect(await catalog(database)).toEqual(before)
  })

  it('can be applied again after it, as it was', async () => {
    await database.db.exec(await script(MIGRATION_46))
    expect(
      await database.asService(`select to_regprocedure('public.super_admin_platform_overview()') is not null as present`),
    ).toEqual([{ present: true }])
  })
})
