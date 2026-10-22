import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import {
  assuredSuperAdmin,
  claimsFor,
  createSignIn,
  enrolTotp,
  openSession,
  provisionSuperAdmin,
  verifiedSession,
  type Claims,
} from './helpers/super-admin'

/**
 * The Super Admin (migrations 32 and 33): the platform, never patient care.
 *
 * Every Super Admin operation is a SECURITY DEFINER function that asks
 * app_private.require_super_admin() first. These tests call those functions
 * directly, as the Data API would - not through any screen - with sessions
 * that each lack one of the things the check requires.
 */

const REFUSED = { code: '42501' }

/** Runs SQL as the service role, which bypasses RLS but not the guards. */
async function asServiceRole<T = Record<string, unknown>>(
  database: TestDatabase,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await database.db.exec('begin')
  try {
    await database.db.exec('set local role service_role')
    const result = await database.db.query<T>(sql, params)
    await database.db.exec('commit')
    return result.rows
  } catch (error) {
    await database.db.exec('rollback')
    throw error
  }
}

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** Every Super Admin RPC, with arguments that would otherwise be valid. */
function everyOperation(clinicId: string, someUserId: string, announcementId: string): [string, string, unknown[]][] {
  return [
    ['list clinics', 'select * from public.super_admin_list_clinics()', []],
    ['create a clinic', `select * from public.super_admin_create_clinic('Refused Clinic', 'UTC')`, []],
    ['set a clinic’s status',`select * from public.super_admin_set_clinic_status($1, 'inactive')`, [clinicId]],
    ['check a clinic for an admin', 'select public.super_admin_check_clinic_for_admin($1)', [clinicId]],
    ['attach a Clinic Admin', `select public.super_admin_attach_clinic_admin($1, $2, 'A', 'B')`, [someUserId, clinicId]],
    ['list announcements', 'select * from public.super_admin_list_announcements()', []],
    ['create an announcement', `select public.super_admin_create_announcement('T', 'C', true)`, []],
    ['edit an announcement', `select public.super_admin_update_announcement($1, 'T', 'C')`, [announcementId]],
    ['publish an announcement', 'select public.super_admin_set_announcement_published($1, false)', [announcementId]],
    ['delete an announcement', 'select public.super_admin_delete_announcement($1)', [announcementId]],
    ['read the platform audit', 'select * from public.super_admin_list_audit()', []],
  ]
}

describe('the super_admin role', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('exists, held by no one until it is given', async () => {
    expect(
      await database.asService(
        `select enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'user_role' order by e.enumsortorder`,
      ),
    ).toEqual([{ v: 'patient' }, { v: 'doctor' }, { v: 'admin' }, { v: 'super_admin' }])
    expect(await one<number>(database, `select count(*)::int from public.user_account where user_role = 'super_admin'`)).toBe(0)
  })

  it('cannot be taken by any Data API caller, the service role included', async () => {
    // A patient, a doctor and a Clinic Admin promoting themselves.
    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asUser(userId, `update public.user_account set user_role = 'super_admin' where user_id = $1`, [userId]),
      ).rejects.toMatchObject(REFUSED)
    }
    // An unauthenticated caller writing an account.
    const stranger = await createSignIn(database, 'stranger@nowhere.test')
    await expect(
      database.asAnon(
        `insert into public.user_account (user_id, user_email, user_role) values ($1, 'stranger@nowhere.test', 'super_admin')`,
        [stranger],
      ),
    ).rejects.toMatchObject(REFUSED)

    // The service role, which create-account uses: a new account, and a
    // fresh account with no profile yet, whose role it could otherwise fix.
    await expect(
      asServiceRole(
        database,
        `insert into public.user_account (user_id, user_email, user_role) values ($1, 'stranger@nowhere.test', 'super_admin')`,
        [stranger],
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('provisioning procedure') })
    await asServiceRole(
      database,
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'stranger@nowhere.test', 'patient')`,
      [stranger],
    )
    await expect(
      asServiceRole(database, `update public.user_account set user_role = 'super_admin' where user_id = $1`, [stranger]),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('provisioning procedure') })

    // Nor the owner, writing the row directly rather than through the procedure.
    await expect(
      database.asService(`update public.user_account set user_role = 'super_admin' where user_id = $1`, [stranger]),
    ).rejects.toMatchObject({ code: '42501' })

    // And no profile without the procedure, by anyone.
    await expect(
      asServiceRole(
        database,
        `insert into public.super_admin (user_id, super_admin_first_name, super_admin_last_name) values ($1, 'X', 'Y')`,
        [stranger],
      ),
    ).rejects.toMatchObject(REFUSED)
    await expect(
      database.asService(
        `insert into public.super_admin (user_id, super_admin_first_name, super_admin_last_name) values ($1, 'X', 'Y')`,
        [stranger],
      ),
    ).rejects.toMatchObject(REFUSED)

    expect(await one<number>(database, `select count(*)::int from public.user_account where user_role = 'super_admin'`)).toBe(0)
  })

  it('is given only by the owner-only procedure, which no API role may call', async () => {
    const privileges = await database.asService<{ who: string; can: boolean }>(
      `select r.rolname as who,
              has_function_privilege(r.rolname, 'app_private.provision_super_admin(uuid, text, text)', 'execute')
                or has_function_privilege(r.rolname, 'app_private.revoke_super_admin(uuid)', 'execute') as can
         from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1`,
    )
    expect(privileges).toEqual([
      { who: 'anon', can: false },
      { who: 'authenticated', can: false },
      { who: 'service_role', can: false },
    ])
    const target = await createSignIn(database, 'not.through.the.api@platform.test')
    await expect(
      database.asUser(fx.adminUserId, `select app_private.provision_super_admin($1, 'A', 'B')`, [target]),
    ).rejects.toMatchObject(REFUSED)
    await expect(
      asServiceRole(database, `select app_private.provision_super_admin($1, 'A', 'B')`, [target]),
    ).rejects.toMatchObject(REFUSED)
  })

  it('is never given to an existing account, so no patient, doctor or Clinic Admin brings their access with it', async () => {
    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      await expect(
        database.asService(`select app_private.provision_super_admin($1, 'A', 'B')`, [userId]),
      ).rejects.toMatchObject({ code: '23505' })
    }
    await expect(
      database.asService(`select app_private.provision_super_admin(gen_random_uuid(), 'A', 'B')`),
    ).rejects.toMatchObject({ code: 'P0002' })
    const blank = await createSignIn(database, 'blank.name@platform.test')
    await expect(
      database.asService(`select app_private.provision_super_admin($1, ' ', 'B')`, [blank]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('makes an account and profile, audited as platform entries without the email', async () => {
    const before = await one<number>(database, 'select count(*)::int from public.audit_log')
    const { userId, superAdminId } = await provisionSuperAdmin(database, 'First.Super@Platform.test')

    expect(
      await database.asService(
        `select ua.user_role::text as role, ua.user_email as email, sa.super_admin_id as id
           from public.user_account ua join public.super_admin sa using (user_id) where ua.user_id = $1`,
        [userId],
      ),
    ).toEqual([{ role: 'super_admin', email: 'first.super@platform.test', id: superAdminId }])

    const entries = await database.asService<{ entity: string; scope: string; clinic: string | null; details: unknown }>(
      `select audit_log_entity as entity, audit_scope::text as scope, clinic_id as clinic, audit_log_details as details
         from public.audit_log order by audit_log_timestamp, audit_log_entity offset $1`,
      [before],
    )
    expect(entries.map(({ entity, scope, clinic }) => ({ entity, scope, clinic }))).toEqual([
      { entity: 'super_admin', scope: 'platform', clinic: null },
      { entity: 'user_account', scope: 'platform', clinic: null },
    ])
    expect(JSON.stringify(entries)).not.toContain('first.super')

    // Fixed from then on: not even the owner changes a Super Admin's role.
    await expect(
      database.asService(`update public.user_account set user_role = 'admin' where user_id = $1`, [userId]),
    ).rejects.toMatchObject(REFUSED)
    // And their profile stays theirs.
    await expect(
      database.asService(`update public.super_admin set user_id = $1 where super_admin_id = $2`, [fx.aliceUserId, superAdminId]),
    ).rejects.toMatchObject(REFUSED)
  })

  it('can be revoked by the owner, audited, unless platform announcements carry their name', async () => {
    const author = await assuredSuperAdmin(database, 'author.super@platform.test')
    await database.asClaims(author.claims, `select public.super_admin_create_announcement('Kept', 'Attributed', false)`)
    await expect(
      database.asService('select app_private.revoke_super_admin($1)', [author.userId]),
    ).rejects.toMatchObject({ code: '23503' })

    const leaving = await provisionSuperAdmin(database, 'leaving.super@platform.test')
    await database.asService('select app_private.revoke_super_admin($1)', [leaving.userId])
    expect(await database.asService('select 1 from public.user_account where user_id = $1', [leaving.userId])).toEqual([])
    expect(
      await database.asService(
        `select audit_scope::text as scope from public.audit_log
          where audit_log_entity = 'super_admin' and audit_log_action = 'delete' and audit_log_entity_id = $1`,
        [leaving.superAdminId],
      ),
    ).toEqual([{ scope: 'platform' }])
  })
})

describe('every Super Admin operation needs a live session verified with the caller’s own authenticator', () => {
  let database: TestDatabase
  let fx: Fixture
  let clinicId: string
  let superAdmin: { userId: string; superAdminId: string; claims: Claims }
  let platformAnnouncementId: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    clinicId = await one<string>(database, 'select clinic_id from public.clinic')
    superAdmin = await assuredSuperAdmin(database)
    platformAnnouncementId = (
      await database.asClaims<{ id: string }>(
        superAdmin.claims,
        `select public.super_admin_create_announcement('Platform notice', 'For everyone', false) as id`,
      )
    )[0]!.id
  })

  afterAll(async () => {
    await database?.close()
  })

  const listClinics = (claims: Claims) =>
    database.asClaims(claims, 'select clinic_name from public.super_admin_list_clinics()')
  const assured = async (claims: Claims) =>
    (await database.asClaims<{ ok: boolean }>(claims, 'select public.super_admin_assured() as ok'))[0]!.ok

  it('lets a Super Admin in a session raised to aal2 with their own verified TOTP factor', async () => {
    expect(await listClinics(superAdmin.claims)).toEqual([{ clinic_name: 'Harborview Recovery Clinic' }])
    expect(await assured(superAdmin.claims)).toBe(true)
  })

  it('refuses anonymous callers outright', async () => {
    await expect(database.asAnon('select * from public.super_admin_list_clinics()')).rejects.toMatchObject(REFUSED)
    await expect(database.asAnon('select public.super_admin_assured()')).rejects.toMatchObject(REFUSED)
  })

  it('refuses a patient, a doctor and a Clinic Admin, each with aal2 and a verified TOTP factor', async () => {
    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      const claims = await verifiedSession(database, userId)
      await expect(listClinics(claims)).rejects.toMatchObject(REFUSED)
      expect(await assured(claims)).toBe(false)
    }
  })

  it('refuses a Super Admin whose session or token falls short in any one way', async () => {
    const userId = superAdmin.userId
    const ownFactor = await enrolTotp(database, userId)
    const unverified = await enrolTotp(database, userId, 'unverified')
    const someoneElsesFactor = await enrolTotp(database, fx.aliceUserId)
    const someoneElsesSession = await openSession(database, fx.aliceUserId, {
      aal: 'aal2',
      factorId: someoneElsesFactor,
      methods: ['password', 'totp'],
    })
    const raised = (shape: Parameters<typeof openSession>[2] = {}) =>
      openSession(database, userId, { aal: 'aal2', factorId: ownFactor, methods: ['password', 'totp'], ...shape })

    const cases: [string, Claims][] = [
      ['signed in with a password only (aal1)', claimsFor(userId, await openSession(database, userId), 'aal1')],
      ['a token claiming aal2 for a session that is still aal1', claimsFor(userId, await openSession(database, userId), 'aal2')],
      ['an aal1 token for a session since raised to aal2', claimsFor(userId, await raised(), 'aal1')],
      ['no session in the token', claimsFor(userId, null)],
      ['a session id that is not an id', { ...claimsFor(userId, null), session_id: 'not-a-uuid' }],
      ['a session that was signed out', claimsFor(userId, '00000000-0000-4000-8000-000000000001')],
      ['a session past its not_after', claimsFor(userId, await raised({ notAfter: '2020-01-01T00:00:00Z' }))],
      ['a session raised with an unverified factor', claimsFor(userId, await raised({ factorId: unverified }))],
      ['a session raised with another user’s factor', claimsFor(userId, await raised({ factorId: someoneElsesFactor }))],
      ['a session with no factor recorded', claimsFor(userId, await raised({ factorId: null }))],
      ['a session never verified with an authenticator code', claimsFor(userId, await raised({ methods: ['password'] }))],
      ['another user’s aal2 session', claimsFor(userId, someoneElsesSession)],
      ['a token for another user with the Super Admin’s session', claimsFor(fx.aliceUserId, superAdmin.claims.session_id as string)],
    ]

    for (const [why, claims] of cases) {
      await expect(listClinics(claims), why).rejects.toMatchObject(REFUSED)
      expect(await assured(claims), why).toBe(false)
    }

    // The same sign-out, really: GoTrue deletes the session row.
    const signedOut = await verifiedSession(database, userId)
    await database.asService('delete from auth.sessions where id = $1', [signedOut.session_id])
    await expect(listClinics(signedOut)).rejects.toMatchObject(REFUSED)
  })

  it('refuses a banned or deleted sign-in, even mid-session', async () => {
    const banned = await assuredSuperAdmin(database, 'banned.super@platform.test')
    await database.asService(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [banned.userId])
    await expect(listClinics(banned.claims)).rejects.toMatchObject(REFUSED)

    const deleted = await assuredSuperAdmin(database, 'deleted.super@platform.test')
    await database.asService('update auth.users set deleted_at = now() where id = $1', [deleted.userId])
    await expect(listClinics(deleted.claims)).rejects.toMatchObject(REFUSED)
  })

  it('applies to every operation, called directly, before it reads or changes anything', async () => {
    const notSuperAdmin = await verifiedSession(database, fx.adminUserId)
    const superAdminAal1 = claimsFor(superAdmin.userId, await openSession(database, superAdmin.userId), 'aal1')
    const before = await database.asService(
      `select (select count(*) from public.clinic) as clinics, (select count(*) from public.announcement) as announcements,
              (select count(*) from public.user_account) as accounts, (select count(*) from public.audit_log) as audit`,
    )
    for (const [what, sql, params] of everyOperation(clinicId, fx.aliceUserId, platformAnnouncementId)) {
      for (const claims of [notSuperAdmin, superAdminAal1]) {
        await expect(database.asClaims(claims, sql, params), what).rejects.toMatchObject(REFUSED)
      }
    }
    expect(
      await database.asService(
        `select (select count(*) from public.clinic) as clinics, (select count(*) from public.announcement) as announcements,
                (select count(*) from public.user_account) as accounts, (select count(*) from public.audit_log) as audit`,
      ),
    ).toEqual(before)
  })

  it('keeps the checks themselves out of reach of every API role', async () => {
    const helpers = await database.asService<{ fn: string; callable: boolean }>(
      `select p.proname as fn,
              bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) as callable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join pg_roles r
        where n.nspname = 'app_private'
          and p.proname in ('assured_super_admin', 'require_super_admin', 'require_active_clinic',
                            'provision_super_admin', 'revoke_super_admin',
                            'validate_announcement_text', 'platform_announcement_for_update')
          and r.rolname in ('anon', 'authenticated', 'service_role')
        group by p.proname order by 1`,
    )
    expect(helpers.every((row) => !row.callable)).toBe(true)
    expect(helpers).toHaveLength(7)
    // Every public Super Admin function is SECURITY DEFINER with an empty
    // search_path, and refused to anon.
    const definers = await database.asService<{ fn: string; definer: boolean; path: string | null; anon: boolean }>(
      `select p.proname as fn, p.prosecdef as definer, array_to_string(p.proconfig, ',') as path,
              has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'super_admin\\_%' and p.prorettype <> 'trigger'::regtype
        order by 1`,
    )
    // 12 from migration 33, and migration 38's two for the guidance
    // assistant's platform switch.
    expect(definers).toHaveLength(14)
    for (const row of definers) {
      expect(row, row.fn).toMatchObject({ definer: true, path: 'search_path=""', anon: false })
    }
  })
})

describe('clinics', () => {
  let database: TestDatabase
  let fx: Fixture
  let harborview: string
  let superAdmin: { userId: string; claims: Claims }

  const counts = () =>
    database.asService(
      `select (select count(*)::int from public.clinic) as clinics,
              (select count(*)::int from public.system_setting) as settings,
              (select count(*)::int from public.audit_log) as audit`,
    )
  const create = (name: string, zone: string) =>
    database.asClaims<Record<string, unknown>>(
      superAdmin.claims,
      'select * from public.super_admin_create_clinic($1, $2)',
      [name, zone],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    harborview = await one<string>(database, 'select clinic_id from public.clinic')
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('lists each clinic’s administration details and Clinic Admin count, and nothing about patients', async () => {
    const [row] = await database.asClaims<Record<string, unknown>>(superAdmin.claims, 'select * from public.super_admin_list_clinics()')
    expect(Object.keys(row!).sort()).toEqual([
      'clinic_admin_count', 'clinic_created_at', 'clinic_id', 'clinic_name',
      'clinic_status', 'clinic_timezone', 'clinic_updated_at',
    ])
    expect(row).toMatchObject({
      clinic_id: harborview,
      clinic_name: 'Harborview Recovery Clinic',
      clinic_status: 'active',
      clinic_timezone: 'Asia/Manila',
      clinic_admin_count: 1,
    })
  })

  it('refuses a missing, overlong or duplicate name and a missing or unknown time zone, creating nothing', async () => {
    const before = await counts()
    for (const [name, zone, code] of [
      ['   ', 'UTC', '23514'],
      ['x'.repeat(121), 'UTC', '23514'],
      ['A Clinic', '  ', '23514'],
      ['A Clinic', 'Mars/Olympus_Mons', '23514'],
      ['  harborview recovery CLINIC ', 'UTC', '23505'],
    ] as const) {
      await expect(create(name, zone), `${name} / ${zone}`).rejects.toMatchObject({ code })
    }
    expect(await counts()).toEqual(before)
  })

  it('creates a clinic with its own default settings - none of another clinic’s - audited as platform', async () => {
    const harborviewSettings = await database.asService(
      `select system_setting_id, system_setting_key, system_setting_value from public.system_setting where clinic_id = $1 order by 1`,
      [harborview],
    )
    const [created] = await create('  Northshore Rehabilitation Centre ', 'America/New_York')
    expect(created).toMatchObject({
      clinic_name: 'Northshore Rehabilitation Centre',
      clinic_status: 'active',
      clinic_timezone: 'America/New_York',
      clinic_admin_count: 0,
    })
    const northshore = created!.clinic_id as string

    expect(
      await database.asService(
        `select system_setting_key as key, system_setting_value as value, admin_id
           from public.system_setting where clinic_id = $1 order by 1`,
        [northshore],
      ),
    ).toEqual([{ key: 'medication.reminder_grace_hours', value: '6', admin_id: null }])
    // No chatbot guidance and no app.timezone alias: the chatbot uses the
    // built-in guidance, and the zone lives on the clinic.
    expect(
      await database.asService(
        `select 1 from public.system_setting
          where clinic_id = $1 and system_setting_key in ('chatbot.system_prompt', 'app.timezone')`,
        [northshore],
      ),
    ).toEqual([])
    expect(
      await database.asService(
        `select system_setting_id, system_setting_key, system_setting_value from public.system_setting where clinic_id = $1 order by 1`,
        [harborview],
      ),
    ).toEqual(harborviewSettings)

    expect(
      await database.asService(
        `select audit_log_action as action, audit_scope::text as scope, user_id as actor
           from public.audit_log where audit_log_entity = 'clinic' and audit_log_entity_id = $1`,
        [northshore],
      ),
    ).toEqual([{ action: 'insert', scope: 'platform', actor: superAdmin.userId }])
  })

  it('creates nothing at all when any part of creating a clinic fails', async () => {
    // Make the settings step fail, after the clinic row has been written.
    await database.db.exec(`
      create function pg_temp.refuse_setting() returns trigger language plpgsql as $$
      begin raise exception 'settings are down'; end $$;
      create trigger refuse_setting before insert on public.system_setting
        for each row execute function pg_temp.refuse_setting();
    `)
    const before = await counts()
    try {
      await expect(create('Half Made Clinic', 'UTC')).rejects.toThrow(/settings are down/)
    } finally {
      await database.db.exec('drop trigger refuse_setting on public.system_setting')
    }
    expect(await counts()).toEqual(before)
    expect(await database.asService(`select 1 from public.clinic where clinic_name = 'Half Made Clinic'`)).toEqual([])
  })

  it('moves a clinic between active and inactive only, changing no one’s data, audited', async () => {
    const people = () =>
      database.asService(
        `select (select md5(string_agg(row(d.*)::text, '|' order by doc_id)) from public.doctor d) as doctors,
                (select md5(string_agg(row(p.*)::text, '|' order by pat_id)) from public.patient p) as patients,
                (select md5(string_agg(row(a.*)::text, '|' order by admin_id)) from public.admin a) as admins`,
      )
    const peopleBefore = await people()
    const setStatus = (clinic: string, status: string | null) =>
      database.asClaims<{ clinic_status: string }>(
        superAdmin.claims,
        'select clinic_status from public.super_admin_set_clinic_status($1, $2)',
        [clinic, status],
      )

    expect(await setStatus(harborview, 'inactive')).toEqual([{ clinic_status: 'inactive' }])
    await expect(setStatus(harborview, 'inactive')).rejects.toMatchObject({ code: '55000' })
    await expect(setStatus(harborview, 'closed')).rejects.toMatchObject({ code: '23514' })
    await expect(setStatus(harborview, null)).rejects.toMatchObject({ code: '23514' })
    await expect(setStatus('00000000-0000-4000-8000-00000000c1c1', 'active')).rejects.toMatchObject({ code: 'P0002' })
    expect(await setStatus(harborview, ' active ')).toEqual([{ clinic_status: 'active' }])

    expect(await people()).toEqual(peopleBefore)
    const changes = await database.asService<{ scope: string; after: unknown }>(
      `select audit_scope::text as scope, audit_log_details -> 'after' as after
         from public.audit_log where audit_log_entity = 'clinic' and audit_log_entity_id = $1
          and audit_log_action = 'update' order by audit_log_timestamp`,
      [harborview],
    )
    expect(changes.map((row) => row.scope)).toEqual(['platform', 'platform'])
    expect(changes.map((row) => (row.after as { clinic_status: string }).clinic_status)).toEqual(['inactive', 'active'])
  })

  it('cannot be written by a Clinic Admin, directly or through their own functions', async () => {
    await expectDenied(() =>
      database.asUser(fx.adminUserId, `update public.clinic set clinic_status = 'inactive' returning clinic_id`),
    )
    await expect(
      database.asUser(fx.adminUserId, `insert into public.clinic (clinic_name) values ('Rogue Clinic')`),
    ).rejects.toMatchObject(REFUSED)
  })
})

describe('Clinic Admins, provisioned by a Super Admin', () => {
  let database: TestDatabase
  let harborview: string
  let superAdmin: { userId: string; claims: Claims }

  const markedSignIn = (email: string, clinicId: string, as = 'clinic_admin') =>
    createSignIn(database, email, { provisioned_as: as, provisioned_clinic: clinicId, must_change_password: false })
  const attach = (userId: string, clinicId: string, first = 'Clara', last = 'Mendez') =>
    database.asClaims<{ id: string }>(
      superAdmin.claims,
      'select public.super_admin_attach_clinic_admin($1, $2, $3, $4) as id',
      [userId, clinicId, first, last],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    await seedFixture(database)
    harborview = await one<string>(database, 'select clinic_id from public.clinic')
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('checks the clinic before any sign-in is created', async () => {
    expect(
      await database.asClaims(superAdmin.claims, 'select public.super_admin_check_clinic_for_admin($1) as ok', [harborview]),
    ).toEqual([{ ok: true }])
    await expect(
      database.asClaims(superAdmin.claims, 'select public.super_admin_check_clinic_for_admin(gen_random_uuid())'),
    ).rejects.toMatchObject({ code: 'P0002' })
  })

  it('attaches only a sign-in create-account made for that clinic’s administrator', async () => {
    const accounts = () => database.asService('select count(*)::int as n from public.user_account')
    const before = await accounts()

    const unmarked = await createSignIn(database, 'signed.up.themselves@clinic.test')
    await expect(attach(unmarked, harborview)).rejects.toMatchObject(REFUSED)

    const forOtherClinic = await markedSignIn('other.clinic@clinic.test', '00000000-0000-4000-8000-0000000000aa')
    await expect(attach(forOtherClinic, harborview)).rejects.toMatchObject(REFUSED)

    const forSomethingElse = await markedSignIn('made.for.else@clinic.test', harborview, 'super_admin')
    await expect(attach(forSomethingElse, harborview)).rejects.toMatchObject(REFUSED)

    await expect(attach('00000000-0000-4000-8000-0000000000bb', harborview)).rejects.toMatchObject({ code: 'P0002' })

    const unnamed = await markedSignIn('unnamed@clinic.test', harborview)
    await expect(attach(unnamed, harborview, '  ', 'Mendez')).rejects.toMatchObject({ code: '23514' })

    // A marked sign-in that already has an account - say, a patient's.
    const patientLogin = await one<string>(
      database,
      `select user_id from public.user_account where user_role = 'patient' limit 1`,
    )
    await database.asService(
      `update auth.users set raw_app_meta_data = jsonb_build_object('provisioned_as', 'clinic_admin', 'provisioned_clinic', $2::text)
        where id = $1`,
      [patientLogin, harborview],
    )
    await expect(attach(patientLogin, harborview)).rejects.toMatchObject({ code: '23505' })

    expect(await accounts()).toEqual(before)
  })

  it('makes a Clinic Admin of that clinic, and nothing more, audited without their name or email', async () => {
    const login = await markedSignIn('  New.Admin@Harborview.test ', harborview)
    // The email Supabase Auth holds is the one used; spaces and case go.
    await database.asService(`update auth.users set email = 'New.Admin@Harborview.test' where id = $1`, [login])
    const [{ id: adminId }] = await attach(login, harborview, ' Clara ', ' Mendez ')

    expect(
      await database.asService(
        `select ua.user_role::text as role, ua.user_email as email, a.clinic_id as clinic,
                a.admin_first_name as first, a.admin_last_name as last
           from public.user_account ua join public.admin a using (user_id) where ua.user_id = $1`,
        [login],
      ),
    ).toEqual([{ role: 'admin', email: 'new.admin@harborview.test', clinic: harborview, first: 'Clara', last: 'Mendez' }])

    const [entry] = await database.asService<{ scope: string; clinic: string; actor: string; details: unknown }>(
      `select audit_scope::text as scope, clinic_id as clinic, user_id as actor, audit_log_details as details
         from public.audit_log where audit_log_entity = 'clinic_admin_account' and audit_log_entity_id = $1`,
      [adminId],
    )
    expect(entry).toEqual({ scope: 'platform', clinic: harborview, actor: superAdmin.userId, details: { clinic_id: harborview } })

    // Works as any Clinic Admin does: their clinic, and no platform entry.
    expect(await database.asUser(login, 'select clinic_name from public.clinic')).toEqual([
      { clinic_name: 'Harborview Recovery Clinic' },
    ])
    expect(
      await database.asUser(login, `select 1 from public.audit_log where audit_scope = 'platform'`),
    ).toEqual([])
  })

  it('takes no role from the caller: the function has no role to choose', async () => {
    const args = await one<string>(
      database,
      `select pg_get_function_identity_arguments('public.super_admin_attach_clinic_admin(uuid, uuid, text, text)'::regprocedure)`,
    )
    expect(args).toBe('target_user_id uuid, target_clinic_id uuid, first_name text, last_name text')
  })

  it('adds no Clinic Admin to an inactive clinic', async () => {
    await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'inactive')`, [harborview])
    try {
      await expect(
        database.asClaims(superAdmin.claims, 'select public.super_admin_check_clinic_for_admin($1)', [harborview]),
      ).rejects.toMatchObject({ code: '55000' })
      const login = await markedSignIn('too.late@harborview.test', harborview)
      await expect(attach(login, harborview)).rejects.toMatchObject({ code: '55000' })
    } finally {
      await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'active')`, [harborview])
    }
  })
})

describe('platform announcements', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; superAdminId: string; claims: Claims }

  const create = (title: string, content: string, publish = false) =>
    database.asClaims<{ id: string }>(
      superAdmin.claims,
      'select public.super_admin_create_announcement($1, $2, $3) as id',
      [title, content, publish],
    )
  const titlesSeenBy = async (userId: string) =>
    (
      await database.asUser<{ title: string }>(
        userId,
        'select announcement_title as title from public.announcement order by 1',
      )
    ).map((row) => row.title)

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('validates the title and the message', async () => {
    for (const [title, content] of [
      [' ', 'Body'],
      ['x'.repeat(151), 'Body'],
      ['Title', '   '],
      ['Title', 'x'.repeat(5001)],
    ]) {
      await expect(create(title!, content!)).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('reaches every signed-in user once published, and no one but the Super Admin while a draft', async () => {
    await create('Platform maintenance', 'Saturday 02:00-03:00 UTC', true)
    await create('Platform draft', 'Not yet', false)

    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
      const seen = await titlesSeenBy(userId)
      expect(seen).toContain('Platform maintenance')
      expect(seen).not.toContain('Platform draft')
    }
    // The Super Admin sees published platform ones through the table, as
    // everyone does - but no clinic's announcement, published or not.
    expect(
      (await database.asClaims<{ title: string }>(superAdmin.claims, 'select announcement_title as title from public.announcement'))
        .map((row) => row.title),
    ).toEqual(['Platform maintenance'])
    // And every platform one, drafts included, through the function only.
    expect(
      (await database.asClaims<{ announcement_title: string }>(superAdmin.claims, 'select announcement_title from public.super_admin_list_announcements()'))
        .map((row) => row.announcement_title)
        .sort(),
    ).toEqual(['Platform draft', 'Platform maintenance'])
  })

  it('cannot be written, edited, published or deleted by a Clinic Admin', async () => {
    const [{ id }] = await create('Platform only', 'Clinic Admins cannot touch this', true)
    await expectDenied(() =>
      database.asUser(fx.adminUserId, `update public.announcement set announcement_title = 'Hijacked' where announcement_id = $1 returning 1`, [id]),
    )
    await expectDenied(() =>
      database.asUser(fx.adminUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [id]),
    )
    await expect(
      database.asUser(
        fx.adminUserId,
        `insert into public.announcement (super_admin_id, announcement_title, announcement_content) values ($1, 'Forged', 'Forged')`,
        [superAdmin.superAdminId],
      ),
    ).rejects.toThrow()
    // Nor can a Clinic Admin turn their own into a platform one.
    await expect(
      database.asUser(
        fx.adminUserId,
        `update public.announcement set admin_id = null, super_admin_id = $1 where announcement_id = $2`,
        [superAdmin.superAdminId, fx.publishedAnnouncementId],
      ),
    ).rejects.toMatchObject(REFUSED)
    expect(
      await database.asService('select announcement_title as t from public.announcement where announcement_id = $1', [id]),
    ).toEqual([{ t: 'Platform only' }])
  })

  it('are edited, published, withdrawn and deleted by the Super Admin - and a clinic’s are not theirs to touch', async () => {
    const [{ id }] = await create('Draft to edit', 'First wording')
    await database.asClaims(superAdmin.claims, `select public.super_admin_update_announcement($1, ' Edited ', ' Second wording ')`, [id])
    const published = await database.asClaims<{ at: string | null }>(
      superAdmin.claims,
      'select public.super_admin_set_announcement_published($1, true) as at',
      [id],
    )
    expect(published[0]!.at).not.toBeNull()
    expect(await titlesSeenBy(fx.aliceUserId)).toContain('Edited')
    await database.asClaims(superAdmin.claims, 'select public.super_admin_set_announcement_published($1, false)', [id])
    expect(await titlesSeenBy(fx.aliceUserId)).not.toContain('Edited')
    await database.asClaims(superAdmin.claims, 'select public.super_admin_delete_announcement($1)', [id])
    expect(await database.asService('select 1 from public.announcement where announcement_id = $1', [id])).toEqual([])

    for (const sql of [
      `select public.super_admin_update_announcement($1, 'Mine now', 'Mine now')`,
      'select public.super_admin_set_announcement_published($1, false)',
      'select public.super_admin_delete_announcement($1)',
    ]) {
      await expect(database.asClaims(superAdmin.claims, sql, [fx.publishedAnnouncementId])).rejects.toMatchObject({ code: 'P0002' })
    }
  })

  it('are audited as platform entries, which no Clinic Admin reads; a clinic’s stay administration', async () => {
    // Which announcements were platform ones: their creation entry records
    // the author, even once they are edited or deleted.
    const scopes = await database.asService<{ author: string; scopes: string[] }>(
      `with platform_ids as (
         select audit_log_entity_id as id from public.audit_log
          where audit_log_entity = 'announcement' and audit_log_action = 'insert'
            and audit_log_details #>> '{record,super_admin_id}' is not null
       )
       select case when l.audit_log_entity_id in (select id from platform_ids)
                   then 'platform author' else 'clinic author' end as author,
              array_agg(distinct l.audit_scope::text) as scopes
         from public.audit_log l
        where l.audit_log_entity = 'announcement'
        group by 1 order by 1`,
    )
    expect(scopes).toEqual([
      { author: 'clinic author', scopes: ['administration'] },
      { author: 'platform author', scopes: ['platform'] },
    ])
    expect(
      await database.asUser(
        fx.adminUserId,
        `select 1 from public.audit_log where audit_log_entity = 'announcement' and audit_scope = 'platform'`,
      ),
    ).toEqual([])
  })

  it('still keep a clinic announcement’s author and clinic fixed', async () => {
    await expect(
      database.asService(`update public.announcement set clinic_id = null where announcement_id = $1`, [fx.publishedAnnouncementId]),
    ).rejects.toMatchObject(REFUSED)
  })
})

describe('the platform audit trail', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    const harborview = await one<string>(database, 'select clinic_id from public.clinic')
    // A little of everything: clinical, administration and platform entries.
    await database.asUser(fx.doctorAUserId, `update public.patient set pat_last_name = 'Reyes' where pat_id = $1`, [fx.alicePatId])
    await database.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Singapore')`)
    await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'inactive')`, [harborview])
    await database.asClaims(superAdmin.claims, `select * from public.super_admin_set_clinic_status($1, 'active')`, [harborview])
    await database.asClaims(superAdmin.claims, `select public.super_admin_create_announcement('Audit me', 'Platform', true)`)
  })

  afterAll(async () => {
    await database?.close()
  })

  const page = (size = 200, beforeTimestamp: string | null = null, beforeId: string | null = null) =>
    database.asClaims<{ audit_log_id: string; audit_log_timestamp: string; audit_log_entity: string; audit_log_details: unknown }>(
      superAdmin.claims,
      'select * from public.super_admin_list_audit($1, $2, $3)',
      [size, beforeTimestamp, beforeId],
    )

  it('gives the Super Admin platform entries only, and nothing about a patient', async () => {
    const entries = await page()
    const platformCount = await one<number>(database, `select count(*)::int from public.audit_log where audit_scope = 'platform'`)
    const otherCount = await one<number>(database, `select count(*)::int from public.audit_log where audit_scope <> 'platform'`)
    expect(entries).toHaveLength(platformCount)
    expect(otherCount).toBeGreaterThan(0)
    expect(new Set(entries.map((entry) => entry.audit_log_entity))).toEqual(
      new Set(['announcement', 'clinic', 'super_admin', 'user_account']),
    )
    const serialised = JSON.stringify(entries)
    for (const secret of [fx.alicePatId, fx.aliceUserId, fx.bobPatId, 'alice@recoverease.test', 'Santos', 'Reyes', 'swelling']) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('pages newest first without skipping entries written in the same instant', async () => {
    const all = await page()
    const first = await page(2)
    const last = first.at(-1)!
    const rest = await page(200, last.audit_log_timestamp, last.audit_log_id)
    expect([...first, ...rest].map((entry) => entry.audit_log_id)).toEqual(all.map((entry) => entry.audit_log_id))
    await expect(page(0)).rejects.toMatchObject({ code: '23514' })
    await expect(page(201)).rejects.toMatchObject({ code: '23514' })
  })

  it('is not readable through the table by the Super Admin, or by a Clinic Admin', async () => {
    expect(await database.asClaims(superAdmin.claims, 'select 1 from public.audit_log')).toEqual([])
    expect(await database.asUser(fx.adminUserId, `select 1 from public.audit_log where audit_scope = 'platform'`)).toEqual([])
  })
})

describe('a Super Admin and clinical information', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { userId: string; claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    await database.asClaims(superAdmin.claims, `select public.super_admin_create_announcement('Visible to all', 'Published', true)`)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('reads no row of any table but their own account and profile, and published platform announcements', async () => {
    const tables = await database.asService<{ t: string }>(
      `select table_name as t from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )
    expect(tables.length).toBeGreaterThan(15)
    const visible: Record<string, number> = {}
    for (const { t } of tables) {
      const [row] = await database.asClaims<{ n: number }>(superAdmin.claims, `select count(*)::int as n from public.${t}`)
      if (row!.n > 0) visible[t] = row!.n
    }
    expect(visible).toEqual({ announcement: 1, super_admin: 1, user_account: 1 })
    expect(
      await database.asClaims(superAdmin.claims, 'select user_id from public.user_account'),
    ).toEqual([{ user_id: superAdmin.userId }])
  })

  it('cannot write a clinical record', async () => {
    await expect(
      database.asClaims(
        superAdmin.claims,
        `insert into public.prescription (pat_id, doc_id, prescription_notes) values ($1, $2, 'Forged')`,
        [fx.alicePatId, fx.doctorAId],
      ),
    ).rejects.toThrow()
    await expectDenied(() =>
      database.asClaims(superAdmin.claims, `update public.patient set pat_last_name = 'X' returning pat_id`),
    )
  })

  it('is refused every Clinic Admin function', async () => {
    for (const [sql, params] of [
      ['select public.admin_dashboard_stats()', []],
      ['select public.admin_chatbot_usage(30)', []],
      ['select public.admin_doctor_patient_count($1)', [fx.doctorCId]],
      ['select public.admin_doctor_appointment_count($1)', [fx.doctorCId]],
      ['select public.admin_reassign_doctor_patients($1, $2, 1, 0)', [fx.doctorCId, fx.doctorAId]],
      [`select public.admin_set_clinic_timezone('UTC')`, []],
    ] as const) {
      await expect(database.asClaims(superAdmin.claims, sql, [...params]), sql).rejects.toMatchObject(REFUSED)
    }
  })
})
