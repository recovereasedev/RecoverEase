import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 28: the clinic schema, before any clinic exists.
 *
 * Phase A gives every account a clinic. This first step adds the `clinic`
 * table and the rules around it, but no clinic row, no clinic name and no
 * clinic column on any profile - migration 29 does that. So everything here
 * is checked against a database built up to migration 28 and no further, in
 * which nobody belongs to a clinic yet. clinic-migration.test.ts and
 * clinic-isolation.test.ts cover what 29 and 30 do.
 *
 * Clinic names below are synthetic and exist only in this test database.
 */

/** The last migration this file describes. */
const THROUGH_MIGRATION_28 = { stopAfter: '20260902100028' }

const MIGRATION_28 = 'supabase/migrations/20260902100028_clinic_schema.sql'
const MIGRATION_27 = 'supabase/migrations/20260902100027_account_roles_are_server_only.sql'

const REFUSED = { code: '42501' }

function harness(db: () => TestDatabase) {
  /** Runs as service_role, the role create-account's service key maps to. */
  async function asServiceRole<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await db().db.exec('begin')
    try {
      await db().db.exec('set local role service_role')
      const result = await db().db.query<T>(sql, params)
      await db().db.exec('commit')
      return result.rows
    } catch (error) {
      await db().db.exec('rollback')
      throw error
    }
  }

  /** A fresh account with no profile yet, as create-account's first step leaves it. */
  async function bareAccount(email: string, role: 'patient' | 'doctor' | 'admin') {
    const [user] = await db().asService<{ id: string }>(
      'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
      [email],
    )
    await db().asService(
      'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
      [user!.id, email, role],
    )
    return user!.id
  }

  const roleOf = async (userId: string) =>
    (
      await db().asService<{ role: string }>(
        'select user_role::text as role from public.user_account where user_id = $1',
        [userId],
      )
    )[0]!.role

  const addClinic = (name: string, timezone?: string) =>
    timezone === undefined
      ? db().asService<{ id: string }>(
          'insert into public.clinic (clinic_name) values ($1) returning clinic_id as id',
          [name],
        )
      : db().asService<{ id: string }>(
          `insert into public.clinic (clinic_name, clinic_timezone) values ($1, $2)
           returning clinic_id as id`,
          [name, timezone],
        )

  const clearClinics = () => db().asService('delete from public.clinic')

  return { asServiceRole, bareAccount, roleOf, addClinic, clearClinics }
}

describe('clinic schema (migration 28)', () => {
  let database: TestDatabase
  let fx: Fixture
  const { asServiceRole, bareAccount, roleOf, addClinic, clearClinics } = harness(
    () => database,
  )

  beforeAll(async () => {
    database = await createTestDatabase(THROUGH_MIGRATION_28)
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('the clinic table', () => {
    it('exists, with row level security on, and holds no clinic yet', async () => {
      const columns = await database.asService<{ name: string; nullable: string; fallback: string | null }>(
        `select column_name as name, is_nullable as nullable, column_default as fallback
           from information_schema.columns
          where table_schema = 'public' and table_name = 'clinic'
          order by ordinal_position`,
      )
      expect(columns.map((c) => c.name)).toEqual([
        'clinic_id',
        'clinic_name',
        'clinic_status',
        'clinic_timezone',
        'clinic_created_at',
        'clinic_updated_at',
      ])
      expect(columns.every((c) => c.nullable === 'NO')).toBe(true)
      expect(columns.find((c) => c.name === 'clinic_timezone')?.fallback).toContain('Asia/Manila')
      expect(columns.find((c) => c.name === 'clinic_status')?.fallback).toContain('active')

      const [table] = await database.asService<{ rls: boolean; rows: number }>(
        `select c.relrowsecurity as rls, (select count(*)::int from public.clinic) as rows
           from pg_class c where c.oid = 'public.clinic'::regclass`,
      )
      expect(table).toEqual({ rls: true, rows: 0 })
    })

    it('adds no clinic column to any profile yet - that is migration 29', async () => {
      const profileClinicColumns = await database.asService(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public'
            and table_name in ('doctor', 'admin', 'patient', 'user_account')
            and column_name like '%clinic%'`,
      )
      expect(profileClinicColumns).toEqual([])
    })

    it('fills in an active status and the Asia/Manila time zone by default', async () => {
      await addClinic('Synthetic Default Clinic')
      try {
        const [row] = await database.asService<{ status: string; tz: string }>(
          'select clinic_status::text as status, clinic_timezone as tz from public.clinic',
        )
        expect(row).toEqual({ status: 'active', tz: 'Asia/Manila' })
      } finally {
        await clearClinics()
      }
    })

    it('refuses a blank name', async () => {
      await expect(addClinic('   ')).rejects.toMatchObject({ code: '23514' })
    })

    it('refuses a name that differs from another only by case or surrounding spaces', async () => {
      // The single-clinic gate would refuse any second row; take it out of the
      // way to test the name rule on its own, and put it back.
      await database.db.exec('drop index public.clinic_single_clinic_gate')
      try {
        await addClinic('Synthetic North Clinic')
        for (const name of ['synthetic north clinic', 'SYNTHETIC NORTH CLINIC', '  Synthetic North Clinic ']) {
          await expect(addClinic(name)).rejects.toMatchObject({
            code: '23505',
            message: expect.stringContaining('clinic_name_key'),
          })
        }
        // A genuinely different name is fine.
        await addClinic('Synthetic South Clinic')
      } finally {
        await clearClinics()
        await database.db.exec(
          'create unique index clinic_single_clinic_gate on public.clinic ((true))',
        )
      }
    })

    it('allows at most one clinic, whatever the name', async () => {
      await addClinic('Synthetic First Clinic')
      try {
        await expect(addClinic('Synthetic Second Clinic')).rejects.toMatchObject({
          code: '23505',
          message: expect.stringContaining('clinic_single_clinic_gate'),
        })
      } finally {
        await clearClinics()
      }
    })

    it('accepts a real time zone and refuses one PostgreSQL does not know', async () => {
      for (const tz of ['Asia/Manila', 'UTC', 'Asia/Tokyo']) {
        await addClinic('Synthetic Zone Clinic', tz)
        await clearClinics()
      }
      await expect(addClinic('Synthetic Zone Clinic', 'Asia/Manilla')).rejects.toMatchObject({
        code: '23514',
        message: 'Unknown time zone: Asia/Manilla',
      })
      const [{ id }] = (await addClinic('Synthetic Zone Clinic')) as [{ id: string }]
      try {
        await expect(
          database.asService('update public.clinic set clinic_timezone = $2 where clinic_id = $1', [
            id,
            'Not/AZone',
          ]),
        ).rejects.toMatchObject({ code: '23514' })
      } finally {
        await clearClinics()
      }
    })

    it('stamps updates and records them in the audit log', async () => {
      const [{ id }] = (await addClinic('Synthetic Audit Clinic')) as [{ id: string }]
      try {
        const [before] = await database.asService<{ at: string }>(
          'select clinic_updated_at::text as at from public.clinic where clinic_id = $1',
          [id],
        )
        await database.asService(
          `update public.clinic set clinic_status = 'inactive' where clinic_id = $1`,
          [id],
        )
        const [after] = await database.asService<{ at: string }>(
          'select clinic_updated_at::text as at from public.clinic where clinic_id = $1',
          [id],
        )
        expect(after!.at).not.toBe(before!.at)
        const audits = await database.asService<{ action: string }>(
          `select audit_log_action as action from public.audit_log
            where audit_log_entity = 'clinic' and audit_log_entity_id = $1
            order by audit_log_timestamp`,
          [id],
        )
        expect(audits.map((a) => a.action)).toEqual(['insert', 'update'])
      } finally {
        await clearClinics()
      }
    })

    it('cannot be written by any browser session, and shows its row to nobody yet', async () => {
      const [{ id }] = (await addClinic('Synthetic Private Clinic')) as [{ id: string }]
      try {
        for (const caller of [fx.adminUserId, fx.doctorAUserId, fx.aliceUserId]) {
          await expect(
            database.asUser(caller, `insert into public.clinic (clinic_name) values ('Synthetic Session Clinic')`),
          ).rejects.toMatchObject(REFUSED)
          await expect(
            database.asUser(caller, `update public.clinic set clinic_name = 'Renamed' where clinic_id = $1`, [id]),
          ).rejects.toMatchObject(REFUSED)
          await expect(
            database.asUser(caller, 'delete from public.clinic where clinic_id = $1', [id]),
          ).rejects.toMatchObject(REFUSED)
          // Readable to its members only, and nobody is a member before 29.
          expect(await database.asUser(caller, 'select clinic_id from public.clinic')).toEqual([])
        }
        await expectDenied(() => database.asAnon('select clinic_id from public.clinic'))
      } finally {
        await clearClinics()
      }
    })
  })

  describe('clinic helpers before profiles have a clinic', () => {
    it('say "no clinic" for every caller, doctor and patient, without failing', async () => {
      for (const caller of [fx.adminUserId, fx.doctorAUserId, fx.doctorCUserId, fx.aliceUserId]) {
        expect(
          await database.asUser(
            caller,
            `select app_private.current_clinic_id() as mine,
                    app_private.clinic_of_doctor($1) as of_doctor,
                    app_private.clinic_of_patient($2) as of_patient`,
            [fx.doctorAId, fx.alicePatId],
          ),
        ).toEqual([{ mine: null, of_doctor: null, of_patient: null }])
      }
      // Unknown ids too.
      expect(
        await asServiceRole(
          `select app_private.clinic_of_doctor(gen_random_uuid()) as d,
                  app_private.clinic_of_patient(gen_random_uuid()) as p`,
        ),
      ).toEqual([{ d: null, p: null }])
    })

    it('still answer "no clinic" while a clinic row exists, since no profile is in it', async () => {
      await addClinic('Synthetic Member Clinic')
      try {
        expect(
          await database.asUser(fx.doctorAUserId, 'select app_private.current_clinic_id() as mine'),
        ).toEqual([{ mine: null }])
      } finally {
        await clearClinics()
      }
    })

    it('are not reachable without a session', async () => {
      await expect(database.asAnon('select app_private.current_clinic_id()')).rejects.toThrow()
    })
  })

  describe('an admin profile belongs to an admin account', () => {
    it('allows an admin profile on an admin account, created in the usual order', async () => {
      const adminUser = await bareAccount('synthetic.admin@recoverease.test', 'admin')
      expect(
        await asServiceRole(
          `insert into public.admin (user_id, admin_first_name, admin_last_name)
           values ($1, 'Synthetic', 'Admin') returning admin_id`,
          [adminUser],
        ),
      ).toHaveLength(1)
    })

    it('refuses an admin profile on a doctor or a patient account, for every writer', async () => {
      for (const owner of [fx.doctorAUserId, fx.aliceUserId]) {
        for (const write of [asServiceRole, database.asService]) {
          await expect(
            write(
              `insert into public.admin (user_id, admin_first_name, admin_last_name)
               values ($1, 'Not', 'Admin')`,
              [owner],
            ),
          ).rejects.toMatchObject({
            code: '42501',
            message: expect.stringContaining('admin profile can only belong to a admin account'),
          })
        }
      }
    })

    it('refuses moving an admin profile onto another account’s login', async () => {
      await expect(
        database.asService('update public.admin set user_id = $2 where admin_id = $1', [
          fx.adminId,
          fx.doctorBUserId,
        ]),
      ).rejects.toMatchObject(REFUSED)
    })

    it('still lets an administrator edit their own profile', async () => {
      expect(
        await database.asUser(
          fx.adminUserId,
          `update public.admin set admin_first_name = 'Ada-Marie' where user_id = $1 returning admin_id`,
          [fx.adminUserId],
        ),
      ).toHaveLength(1)
    })
  })

  describe('an account’s role is fixed once it has a profile', () => {
    it('refuses a role change on a doctor, patient or admin account - even for the server', async () => {
      for (const [owner, newRole] of [
        [fx.doctorAUserId, 'admin'],
        [fx.aliceUserId, 'doctor'],
        [fx.adminUserId, 'patient'],
      ] as const) {
        for (const write of [asServiceRole, database.asService]) {
          await expect(
            write('update public.user_account set user_role = $2 where user_id = $1', [owner, newRole]),
          ).rejects.toMatchObject({
            code: '42501',
            message: 'The role of an account with a profile cannot be changed',
          })
        }
      }
      expect(await roleOf(fx.doctorAUserId)).toBe('doctor')
      expect(await roleOf(fx.aliceUserId)).toBe('patient')
      expect(await roleOf(fx.adminUserId)).toBe('admin')
    })

    it('still refuses every browser session outright, as migration 27 does', async () => {
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.user_account set user_role = 'admin' where user_id = $1`,
          [fx.bobUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
    })

    it('lets the server correct an account’s role before any profile exists', async () => {
      const userId = await bareAccount('synthetic.wrong.role@recoverease.test', 'patient')
      await asServiceRole(`update public.user_account set user_role = 'doctor' where user_id = $1`, [userId])
      expect(await roleOf(userId)).toBe('doctor')
      // ...and the corrected role's profile then goes on as usual.
      expect(
        await asServiceRole(
          `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
           values ($1, 'Synthetic', 'Doctor', 'LIC-SYN-028') returning doc_id`,
          [userId],
        ),
      ).toHaveLength(1)
    })

    it('still allows the server’s other account updates on a profiled account', async () => {
      await asServiceRole(
        `update public.user_account set user_email = 'doctor.c.updated@recoverease.test' where user_id = $1`,
        [fx.doctorCUserId],
      )
      expect(await roleOf(fx.doctorCUserId)).toBe('doctor')
    })

    it('fails closed for a trusted writer that cannot see profiles or ask the helper', async () => {
      // A server role that neither bypasses RLS nor may call the profile
      // helper must not slip past the freeze because it cannot see the
      // profile. It is refused rather than allowed.
      await database.db.exec(`
        create role probe_writer nologin;
        grant usage on schema public to probe_writer;
        grant select, update on public.user_account to probe_writer;
        create policy probe_writer_reaches_accounts on public.user_account
          for all to probe_writer using (true) with check (true);
      `)
      try {
        await database.db.exec('begin')
        try {
          await database.db.exec('set local role probe_writer')
          await expect(
            database.db.query(
              `update public.user_account set user_role = 'admin' where user_id = $1`,
              [fx.doctorBUserId],
            ),
          ).rejects.toMatchObject(REFUSED)
        } finally {
          await database.db.exec('rollback')
        }
        expect(await roleOf(fx.doctorBUserId)).toBe('doctor')
      } finally {
        await database.db.exec(`
          drop policy probe_writer_reaches_accounts on public.user_account;
          revoke all on public.user_account from probe_writer;
          revoke usage on schema public from probe_writer;
          drop role probe_writer;
        `)
      }
    })

    it('lets only server roles ask whether an account has a profile', async () => {
      const [privileges] = await database.asService<Record<string, boolean>>(
        `select
           has_function_privilege('anon', 'app_private.account_has_profile(uuid)', 'EXECUTE') as anon,
           has_function_privilege('authenticated', 'app_private.account_has_profile(uuid)', 'EXECUTE') as authenticated,
           has_function_privilege('service_role', 'app_private.account_has_profile(uuid)', 'EXECUTE') as service_role`,
      )
      expect(privileges).toEqual({ anon: false, authenticated: false, service_role: true })
    })

    it('still provisions doctor and patient accounts in create-account’s order', async () => {
      const doctorUser = await bareAccount('synthetic.new.doctor@recoverease.test', 'doctor')
      const [doctor] = await asServiceRole<{ doc_id: string }>(
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
         values ($1, 'New', 'Doctor', 'LIC-SYN-NEW') returning doc_id`,
        [doctorUser],
      )
      const patientUser = await bareAccount('synthetic.new.patient@recoverease.test', 'patient')
      expect(
        await asServiceRole(
          `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name)
           values ($1, $2, 'New', 'Patient') returning pat_id`,
          [patientUser, doctor!.doc_id],
        ),
      ).toHaveLength(1)
    })
  })

  describe('the migration itself', () => {
    it('can be applied again without error, keeping one gate and one of each guard', async () => {
      await database.db.exec(await readFile(join(process.cwd(), MIGRATION_28), 'utf8'))
      const [state] = await database.asService<{ gates: number; admin_guards: number; rows: number }>(
        `select
           (select count(*)::int from pg_indexes
             where schemaname = 'public' and indexname = 'clinic_single_clinic_gate') as gates,
           (select count(*)::int from pg_trigger
             where tgname = 'admin_profile_matches_role' and not tgisinternal) as admin_guards,
           (select count(*)::int from public.clinic) as rows`,
      )
      expect(state).toEqual({ gates: 1, admin_guards: 1, rows: 0 })
    })
  })
})

describe('rolling migration 28 back with its own down-script', () => {
  let database: TestDatabase
  let fx: Fixture
  const { asServiceRole } = harness(() => database)

  beforeAll(async () => {
    database = await createTestDatabase(THROUGH_MIGRATION_28)
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('removes everything it added and restores migration 27’s account guard', async () => {
    // The statements from the migration header, exactly as documented.
    await database.db.exec(`
      drop trigger admin_profile_matches_role on public.admin;
      drop table public.clinic;
      drop function public.clinic_validate_timezone();
      drop type public.clinic_status;
      drop function app_private.current_clinic_id();
      drop function app_private.clinic_of_doctor(uuid);
      drop function app_private.clinic_of_patient(uuid);
      drop function app_private.account_has_profile(uuid);
    `)
    // "Re-run migration 27's user_account section": the whole file is
    // re-runnable, which restores that section exactly.
    await database.db.exec(await readFile(join(process.cwd(), MIGRATION_27), 'utf8'))

    const [left] = await database.asService<Record<string, number>>(
      `select
         (select count(*)::int from pg_class where relname = 'clinic' and relnamespace = 'public'::regnamespace) as clinic_table,
         (select count(*)::int from pg_type where typname = 'clinic_status') as clinic_type,
         (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and (p.proname like 'clinic_of_%' or p.proname in ('current_clinic_id', 'account_has_profile'))) as helpers,
         (select count(*)::int from pg_trigger where tgname = 'admin_profile_matches_role') as admin_guard`,
    )
    expect(left).toEqual({ clinic_table: 0, clinic_type: 0, helpers: 0, admin_guard: 0 })

    // Migration 27's behaviour is back: the server may change a profiled
    // account's role again, and sessions are still refused.
    await asServiceRole(`update public.user_account set user_role = 'admin' where user_id = $1`, [
      fx.doctorBUserId,
    ])
    await expect(
      database.asUser(
        fx.adminUserId,
        `update public.user_account set user_role = 'admin' where user_id = $1`,
        [fx.bobUserId],
      ),
    ).rejects.toMatchObject(REFUSED)
  })
})
