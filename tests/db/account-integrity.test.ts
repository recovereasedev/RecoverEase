import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Who an account is - its role, its sign-in address, its login - and which
 * profile it has are decided by the server, never by a browser session
 * (migration 27).
 *
 * `user_account.user_role` is what every privilege check reads, so a session
 * able to write it can make itself, or anyone, an administrator. Before
 * migration 27 an administrator could do exactly that with one Data API
 * request, could rewrite another account's email, could attach a doctor
 * profile to any account, and a doctor could hand a patient to a deactivated
 * doctor. These tests run as the `authenticated` and `anon` roles with a
 * request.jwt claim, the way PostgREST runs every Data API request, so a
 * refusal here is a refusal of a direct REST call.
 */
describe('account roles and identity are server-only', () => {
  let database: TestDatabase
  let fx: Fixture

  const REFUSED = { code: '42501' }

  /** Runs as service_role, the role create-account's service key maps to. */
  async function asServiceRole<T = Record<string, unknown>>(
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

  type Account = { user_id: string; user_email: string; user_role: string }
  const accounts = () =>
    database.asService<Account>(
      `select user_id, user_email, user_role::text as user_role
         from public.user_account order by user_id`,
    )
  const doctorOf = async (patId: string) =>
    (
      await database.asService<{ doc_id: string }>(
        'select doc_id from public.patient where pat_id = $1',
        [patId],
      )
    )[0]!.doc_id

  /** A fresh account with no profile, as create-account's first step leaves it. */
  async function bareAccount(email: string, role: 'patient' | 'doctor' | 'admin') {
    const [user] = await database.asService<{ id: string }>(
      'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
      [email],
    )
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role)
       values ($1, $2, $3)`,
      [user!.id, email, role],
    )
    return user!.id
  }

  /** Audited changes to the fixture's own accounts - not ones a test adds. */
  const originalAccountAudits = async () =>
    (
      await database.asService<{ n: number }>(
        `select count(*)::int as n from public.audit_log
          where audit_log_entity = 'user_account' and audit_log_action <> 'insert'
            and audit_log_entity_id = any ($1::uuid[])`,
        [
          [
            fx.adminUserId,
            fx.doctorAUserId,
            fx.doctorBUserId,
            fx.doctorCUserId,
            fx.aliceUserId,
            fx.bobUserId,
            fx.carolUserId,
            fx.daveUserId,
          ],
        ],
      )
    )[0]!.n

  let before: {
    accounts: Account[]
    links: unknown[]
    chat: unknown[]
    accountAudits: number
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    before = {
      accounts: await accounts(),
      links: await database.asService(
        'select pat_id, user_id, doc_id from public.patient order by pat_id',
      ),
      chat: await database.asService(
        `select s.chat_session_id, s.pat_id, m.chat_message_id, m.chat_message_role,
                m.chat_message_content
           from public.chat_session s
           left join public.chat_message m on m.chat_session_id = s.chat_session_id
          order by s.chat_session_id, m.chat_message_id`,
      ),
      accountAudits: await originalAccountAudits(),
    }
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('roles', () => {
    it('an administrator cannot promote a patient or a doctor to administrator', async () => {
      for (const target of [fx.bobUserId, fx.doctorBUserId]) {
        await expect(
          database.asUser(
            fx.adminUserId,
            `update public.user_account set user_role = 'admin' where user_id = $1
             returning user_id`,
            [target],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
    })

    it('an administrator cannot change any other account’s role', async () => {
      for (const [target, role] of [
        [fx.aliceUserId, 'doctor'],
        [fx.doctorAUserId, 'patient'],
      ] as const) {
        await expect(
          database.asUser(
            fx.adminUserId,
            'update public.user_account set user_role = $2 where user_id = $1 returning user_id',
            [target, role],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
    })

    it('nobody can change their own role', async () => {
      for (const [self, role] of [
        [fx.aliceUserId, 'admin'],
        [fx.doctorAUserId, 'admin'],
        [fx.adminUserId, 'doctor'],
      ] as const) {
        await expect(
          database.asUser(
            self,
            'update public.user_account set user_role = $2 where user_id = $1 returning user_id',
            [self, role],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
    })

    it('a doctor cannot change any role', async () => {
      await expect(
        database.asUser(
          fx.doctorAUserId,
          `update public.user_account set user_role = 'admin' where user_id = $1
           returning user_id`,
          [fx.aliceUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
    })
  })

  describe('identity fields', () => {
    it('an administrator cannot rewrite another account’s email or login', async () => {
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.user_account set user_email = 'someone.else@recoverease.test'
            where user_id = $1 returning user_id`,
          [fx.doctorCUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
      await expect(
        database.asUser(
          fx.adminUserId,
          `update public.user_account set user_id = $2 where user_id = $1 returning user_id`,
          [fx.doctorCUserId, fx.daveUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
    })

    it('no session can create or delete an account row', async () => {
      const userId = (
        await database.asService<{ id: string }>(
          `insert into auth.users (id, email)
           values (gen_random_uuid(), 'nobody@recoverease.test') returning id`,
        )
      )[0]!.id
      for (const caller of [fx.adminUserId, fx.doctorAUserId, userId]) {
        await expect(
          database.asUser(
            caller,
            `insert into public.user_account (user_id, user_email, user_role)
             values ($1, 'nobody@recoverease.test', 'admin') returning user_id`,
            [userId],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
      await expect(
        database.asUser(
          fx.adminUserId,
          'delete from public.user_account where user_id = $1 returning user_id',
          [fx.bobUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
    })

    // An unauthenticated caller is tested further down, against a database
    // where `anon` holds the privileges Supabase gives it. Here `anon` holds
    // none, so a refusal would prove nothing.

    it('leaves the browser roles no write privilege on accounts, only reads', async () => {
      const [privileges] = await database.asService<Record<string, boolean>>(
        `select
           has_table_privilege('authenticated', 'public.user_account', 'SELECT') as select_account,
           has_table_privilege('authenticated', 'public.user_account', 'INSERT') as insert_account,
           has_table_privilege('authenticated', 'public.user_account', 'UPDATE') as update_account,
           has_table_privilege('authenticated', 'public.user_account', 'DELETE') as delete_account,
           has_column_privilege('authenticated', 'public.user_account', 'user_role', 'UPDATE')
             as update_role,
           has_table_privilege('authenticated', 'public.doctor', 'INSERT') as insert_doctor,
           has_table_privilege('authenticated', 'public.doctor', 'UPDATE') as update_doctor`,
      )
      expect(privileges).toEqual({
        select_account: true,
        insert_account: false,
        update_account: false,
        delete_account: false,
        update_role: false,
        insert_doctor: false,
        // Profile edits, activation and deactivation still go through RLS.
        update_doctor: true,
      })
    })

    it('stays closed even if a later policy and grant reopen the table', async () => {
      // A future migration that re-granted UPDATE and added a permissive
      // policy must still not let a session change a role.
      await database.db.exec(`
        grant insert, update on public.user_account to anon, authenticated;
        create policy reopened_for_test on public.user_account
          for update to anon, authenticated using (true) with check (true);
      `)
      try {
        await expect(
          database.asUser(
            fx.adminUserId,
            `update public.user_account set user_role = 'admin' where user_id = $1
             returning user_id`,
            [fx.bobUserId],
          ),
        ).rejects.toMatchObject({
          code: '42501',
          message: 'Accounts are created and changed only by the server',
        })
        await expect(
          database.asAnon(
            `update public.user_account set user_role = 'admin' where user_id = $1
             returning user_id`,
            [fx.bobUserId],
          ),
        ).rejects.toMatchObject(REFUSED)
      } finally {
        await database.db.exec(`
          drop policy reopened_for_test on public.user_account;
          revoke insert, update on public.user_account from anon, authenticated;
        `)
      }
    })

    it('still lets the server correct an account, stamping and auditing the change', async () => {
      const userId = await bareAccount('typo.adress@recoverease.test', 'doctor')
      const [original] = await database.asService<{ stamped: string }>(
        'select user_updated_at::text as stamped from public.user_account where user_id = $1',
        [userId],
      )
      await asServiceRole(
        `update public.user_account set user_email = 'typo.address@recoverease.test'
          where user_id = $1`,
        [userId],
      )
      const [row] = await database.asService<{ email: string; stamped: string }>(
        `select user_email as email, user_updated_at::text as stamped
           from public.user_account where user_id = $1`,
        [userId],
      )
      expect(row).toMatchObject({ email: 'typo.address@recoverease.test' })
      expect(row!.stamped).not.toBe(original!.stamped)
      // Audited, with the address itself redacted (migration 14).
      const [audit] = await database.asService<{ details: Record<string, unknown> }>(
        `select audit_log_details as details from public.audit_log
          where audit_log_entity = 'user_account' and audit_log_action = 'update'
            and audit_log_entity_id = $1`,
        [userId],
      )
      expect(audit?.details).toBeTruthy()
      expect(JSON.stringify(audit!.details)).not.toContain('recoverease.test')
    })

    it('does not let even the server re-point an account at another login', async () => {
      await expect(
        asServiceRole('update public.user_account set user_id = $2 where user_id = $1', [
          fx.carolUserId,
          fx.daveUserId,
        ]),
      ).rejects.toMatchObject(REFUSED)
    })
  })

  describe('profiles', () => {
    it('no session can create a doctor profile directly - admin, doctor or patient', async () => {
      const spare = await bareAccount('spare.doctor@recoverease.test', 'doctor')
      for (const [caller, owner] of [
        [fx.adminUserId, fx.daveUserId],
        [fx.adminUserId, spare],
        [fx.doctorAUserId, spare],
        [fx.aliceUserId, fx.aliceUserId],
      ] as const) {
        await expect(
          database.asUser(
            caller,
            `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
             values ($1, 'Not', 'Allowed', 'LIC-NOPE-' || left(md5(random()::text), 6))
             returning doc_id`,
            [owner],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
    })

    it('a profile only ever belongs to an account of the same role, for every writer', async () => {
      // Even the service role cannot put a doctor profile on a patient's account.
      await expect(
        asServiceRole(
          `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
           values ($1, 'Wrong', 'Account', 'LIC-WRONG-1')`,
          [fx.daveUserId],
        ),
      ).rejects.toMatchObject(REFUSED)
      // Nor can a doctor attach a patient profile to an administrator's account.
      await expect(
        database.asUser(
          fx.doctorAUserId,
          `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name)
           values ($1, $2, 'Not', 'Patient') returning pat_id`,
          [fx.adminUserId, fx.doctorAId],
        ),
      ).rejects.toMatchObject(REFUSED)
    })

    it('still lets the server create doctor and patient accounts the way create-account does', async () => {
      const doctorUser = await bareAccount('new.doctor@recoverease.test', 'doctor')
      const [doctor] = await asServiceRole<{ doc_id: string }>(
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
         values ($1, 'New', 'Doctor', 'LIC-NEW-001') returning doc_id`,
        [doctorUser],
      )
      expect(doctor?.doc_id).toBeTruthy()

      const patientUser = await bareAccount('new.patient@recoverease.test', 'patient')
      const [patient] = await asServiceRole<{ pat_id: string }>(
        `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name)
         values ($1, $2, 'New', 'Patient') returning pat_id`,
        [patientUser, doctor!.doc_id],
      )
      expect(patient?.pat_id).toBeTruthy()

      // The new doctor can read their new patient, as any assigned doctor can.
      expect(
        await database.asUser(doctorUser, 'select pat_id from public.patient where pat_id = $1', [
          patient!.pat_id,
        ]),
      ).toHaveLength(1)
    })

    it('still lets a doctor register a patient on their own caseload (module 2.2)', async () => {
      const patientUser = await bareAccount('own.patient@recoverease.test', 'patient')
      // No RETURNING: the patient read policy cannot see a row inserted by
      // the same statement, which was already so before migration 27. The app
      // registers patients through create-account, as the server.
      await database.asUser(
        fx.doctorAUserId,
        `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name)
         values ($1, $2, 'Own', 'Patient')`,
        [patientUser, fx.doctorAId],
      )
      expect(
        await database.asService('select pat_id from public.patient where user_id = $1 and doc_id = $2', [
          patientUser,
          fx.doctorAId,
        ]),
      ).toHaveLength(1)
    })

    it('keeps every legitimate profile edit working', async () => {
      // A doctor edits their own profile (module 2.6).
      expect(
        await database.asUser(
          fx.doctorAUserId,
          `update public.doctor set doc_specialization = 'Orthopaedics' where doc_id = $1
           returning doc_id`,
          [fx.doctorAId],
        ),
      ).toHaveLength(1)
      // An administrator deactivates, reactivates and corrects a doctor (11.2, 11.3).
      for (const sql of [
        'update public.doctor set doc_is_active = false where doc_id = $1 returning doc_id',
        'update public.doctor set doc_is_active = true where doc_id = $1 returning doc_id',
        `update public.doctor set doc_license_no = 'LIC-B-002-R' where doc_id = $1
         returning doc_id`,
      ]) {
        expect(await database.asUser(fx.adminUserId, sql, [fx.doctorBId])).toHaveLength(1)
      }
      // A patient edits their own details (2.7), and their doctor edits them (2.5).
      expect(
        await database.asUser(
          fx.aliceUserId,
          `update public.patient set pat_contact_no = '0917-111-2222' where pat_id = $1
           returning pat_id`,
          [fx.alicePatId],
        ),
      ).toHaveLength(1)
      expect(
        await database.asUser(
          fx.doctorAUserId,
          `update public.patient set pat_address = 'Synthetic Street' where pat_id = $1
           returning pat_id`,
          [fx.alicePatId],
        ),
      ).toHaveLength(1)
      // An administrator edits their own profile (14.2).
      expect(
        await database.asUser(
          fx.adminUserId,
          `update public.admin set admin_last_name = 'Reyes-Cruz' where user_id = $1
           returning admin_id`,
          [fx.adminUserId],
        ),
      ).toHaveLength(1)
    })
  })

  describe('patient reassignment', () => {
    it('refuses a deactivated or non-existent doctor as the new doctor', async () => {
      for (const target of [fx.doctorCId, '00000000-0000-4000-8000-000000000000']) {
        await expect(
          database.asUser(
            fx.doctorAUserId,
            'update public.patient set doc_id = $1 where pat_id = $2 returning pat_id',
            [target, fx.bobPatId],
          ),
        ).rejects.toMatchObject(REFUSED)
      }
      expect(await doctorOf(fx.bobPatId)).toBe(fx.doctorAId)
    })

    it('refuses anyone but the patient’s own doctor - another doctor, or an administrator', async () => {
      for (const caller of [fx.doctorBUserId, fx.adminUserId]) {
        await expectDenied(() =>
          database.asUser(
            caller,
            'update public.patient set doc_id = $1 where pat_id = $2 returning pat_id',
            [fx.doctorBId, fx.bobPatId],
          ),
        )
      }
      expect(await doctorOf(fx.bobPatId)).toBe(fx.doctorAId)
    })

    it('still lets the assigned doctor hand a patient to another active doctor, and back', async () => {
      expect(
        await database.asUser(
          fx.doctorAUserId,
          'update public.patient set doc_id = $1 where pat_id = $2 returning pat_id',
          [fx.doctorBId, fx.bobPatId],
        ),
      ).toHaveLength(1)
      expect(
        await database.asUser(
          fx.doctorBUserId,
          'update public.patient set doc_id = $1 where pat_id = $2 returning pat_id',
          [fx.doctorAId, fx.bobPatId],
        ),
      ).toHaveLength(1)
      expect(await doctorOf(fx.bobPatId)).toBe(fx.doctorAId)
    })
  })

  describe('the trust boundary the account guard relies on', () => {
    // user_account_guard_writes trusts every writer except `anon` and
    // `authenticated`, by current_user. These pin down what current_user is
    // on each path, so the boundary is a tested fact rather than an
    // assumption.
    const whoAmI = 'select current_user::text as role'

    it('names the Data API roles for direct callers, and service_role for the service key', async () => {
      expect(await database.asAnon(whoAmI)).toEqual([{ role: 'anon' }])
      expect(await database.asUser(fx.aliceUserId, whoAmI)).toEqual([{ role: 'authenticated' }])
      expect(await database.asUser(fx.adminUserId, whoAmI)).toEqual([{ role: 'authenticated' }])
      expect(await asServiceRole(whoAmI)).toEqual([{ role: 'service_role' }])
    })

    it('names the owner inside a SECURITY DEFINER function - code only a migration can install', async () => {
      // A function installed by a migration runs as its owner. That is the
      // only way a session's request becomes a "server" write, so any such
      // function that writes accounts must check its caller itself.
      await database.db.exec(`
        create function public.boundary_probe() returns text
          language sql security definer set search_path = '' as $$ select current_user::text $$;
        grant execute on function public.boundary_probe() to authenticated;
      `)
      try {
        const [owner] = await database.asService<{ role: string }>(whoAmI)
        expect(await database.asUser(fx.aliceUserId, 'select public.boundary_probe() as role')).toEqual([
          { role: owner!.role },
        ])
        expect(owner!.role).not.toMatch(/^(anon|authenticated)$/)
      } finally {
        await database.db.exec('drop function public.boundary_probe()')
      }
    })

    it('ships no function a session can call that writes accounts', async () => {
      // Every function in the exposed and helper schemas that inserts,
      // updates or deletes user_account. Today there is none; one added
      // later must be reviewed for its own caller check before this is
      // updated.
      const writers = await database.asService<{ fn: string }>(
        `select n.nspname || '.' || p.proname as fn
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app_private')
            and p.prokind = 'f'
            and p.prorettype <> 'pg_catalog.trigger'::regtype
            and p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?user_account'
            and (has_function_privilege('anon', p.oid, 'EXECUTE')
                 or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
      )
      expect(writers).toEqual([])
    })

    it('gives the Data API roles no way to become a trusted role', async () => {
      const [membership] = await database.asService<Record<string, boolean>>(
        `select
           pg_has_role('anon', 'service_role', 'MEMBER') as anon_service,
           pg_has_role('authenticated', 'service_role', 'MEMBER') as authenticated_service,
           pg_has_role('anon', current_user, 'MEMBER') as anon_owner,
           pg_has_role('authenticated', current_user, 'MEMBER') as authenticated_owner`,
      )
      expect(Object.values(membership!)).toEqual([false, false, false, false])
    })
  })

  describe('the migration itself', () => {
    it('can be applied again without error, leaving one of each guard and the guards in force', async () => {
      const sql = await readFile(
        join(process.cwd(), 'supabase/migrations/20260902100027_account_roles_are_server_only.sql'),
        'utf8',
      )
      await database.db.exec(sql)

      const triggers = await database.asService<{ name: string }>(
        `select tgname as name from pg_trigger
          where not tgisinternal
            and tgname in ('user_account_guard_writes', 'doctor_profile_matches_role',
                           'patient_profile_matches_role',
                           'patient_reassignment_requires_active_doctor')
          order by tgname`,
      )
      expect(triggers.map((t) => t.name)).toEqual([
        'doctor_profile_matches_role',
        'patient_profile_matches_role',
        'patient_reassignment_requires_active_doctor',
        'user_account_guard_writes',
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

  describe('existing data', () => {
    it('leaves every original account, patient link and conversation exactly as it was', async () => {
      const after = await accounts()
      for (const account of before.accounts) {
        expect(after).toContainEqual(account)
      }
      const links = await database.asService(
        'select pat_id, user_id, doc_id from public.patient order by pat_id',
      )
      for (const link of before.links) {
        expect(links).toContainEqual(link)
      }
      expect(
        await database.asService(
          `select s.chat_session_id, s.pat_id, m.chat_message_id, m.chat_message_role,
                  m.chat_message_content
             from public.chat_session s
             left join public.chat_message m on m.chat_session_id = s.chat_session_id
            order by s.chat_session_id, m.chat_message_id`,
        ),
      ).toEqual(before.chat)
    })

    it('recorded no change to any original account, and still audits the legitimate doctor changes', async () => {
      expect(await originalAccountAudits()).toBe(before.accountAudits)

      const [doctorAudits] = await database.asService<{ n: number }>(
        `select count(*)::int as n from public.audit_log
          where audit_log_entity = 'doctor' and audit_log_action = 'update'
            and audit_log_entity_id = $1`,
        [fx.doctorBId],
      )
      expect(doctorAudits!.n).toBeGreaterThanOrEqual(3)
    })
  })
})

/**
 * An unauthenticated caller, holding what Supabase gives `anon` on every
 * public table: every table privilege, with RLS deciding the rows. The shared
 * harness gives `anon` nothing, under which any refusal is trivially true;
 * here a refusal of `anon` can only come from migration 27 itself.
 */
describe('an unauthenticated caller, with the privileges Supabase gives anon', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase({ anonTablePrivileges: true })
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('still holds the default privileges elsewhere, but no write on accounts or doctor inserts', async () => {
    const [privileges] = await database.asService<Record<string, boolean>>(
      `select
         has_table_privilege('anon', 'public.appointment', 'UPDATE') as default_update_elsewhere,
         has_table_privilege('anon', 'public.user_account', 'SELECT') as select_account,
         has_table_privilege('anon', 'public.user_account', 'INSERT') as insert_account,
         has_table_privilege('anon', 'public.user_account', 'UPDATE') as update_account,
         has_table_privilege('anon', 'public.user_account', 'DELETE') as delete_account,
         has_table_privilege('anon', 'public.user_account', 'TRUNCATE') as truncate_account,
         has_table_privilege('anon', 'public.doctor', 'INSERT') as insert_doctor`,
    )
    expect(privileges).toEqual({
      // Proves the grants here are Supabase's, so the falses below are the
      // migration's revokes and not an empty harness.
      default_update_elsewhere: true,
      select_account: true,
      insert_account: false,
      update_account: false,
      delete_account: false,
      truncate_account: false,
      insert_doctor: false,
    })
  })

  it('cannot change a role, an email address or a login', async () => {
    for (const sql of [
      `update public.user_account set user_role = 'admin' where user_id = $1`,
      `update public.user_account set user_email = 'anon.was.here@recoverease.test' where user_id = $1`,
      `update public.user_account set user_id = gen_random_uuid() where user_id = $1`,
    ]) {
      await expect(database.asAnon(sql, [fx.aliceUserId])).rejects.toMatchObject({
        code: '42501',
        message: 'permission denied for table user_account',
      })
    }
    const [alice] = await database.asService<{ role: string; email: string }>(
      `select user_role::text as role, user_email as email
         from public.user_account where user_id = $1`,
      [fx.aliceUserId],
    )
    expect(alice).toEqual({ role: 'patient', email: 'alice@recoverease.test' })
  })

  it('cannot create an account or a doctor profile', async () => {
    const [spare] = await database.asService<{ id: string }>(
      `insert into auth.users (id, email)
       values (gen_random_uuid(), 'anon.spare@recoverease.test') returning id`,
    )
    await expect(
      database.asAnon(
        `insert into public.user_account (user_id, user_email, user_role)
         values ($1, 'anon.spare@recoverease.test', 'admin')`,
        [spare!.id],
      ),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for table user_account' })
    await expect(
      database.asAnon(
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
         values ($1, 'Anon', 'Doctor', 'LIC-ANON-1')`,
        [fx.daveUserId],
      ),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for table doctor' })
  })

  it('reads no account at all, as before', async () => {
    expect(await database.asAnon('select user_id from public.user_account')).toEqual([])
  })
})
