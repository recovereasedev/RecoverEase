import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, claimsFor, provisionSuperAdmin } from './helpers/super-admin'

/**
 * The adviser's "AI Chatbot On/Off" (migration 38).
 *
 * Two switches, both enforced by the server: the platform's, which only an
 * assured Super Admin changes, and each clinic's `chatbot.enabled`, which only
 * that clinic's Clinic Admin changes. The assistant is on for a patient only
 * when both are on; never set counts as on; anything but 'true' as off.
 *
 * `guidance_assistant_on_for_doctor()` is what `chatbot-reply` asks, with the
 * service role, before it reads a conversation or calls Gemini; the order is
 * pinned in `tests/unit/chatbot-assistant-switch.test.ts`.
 */

const MIGRATION_33 = '20260902100033'
const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'
const MIGRATION_38 = '20260902100038'
const ROLLBACK_38 = 'supabase/rollbacks/20260902100038_guidance_assistant_switch.down.sql'
const CLINIC_KEY = 'chatbot.enabled'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** Saves a clinic's switch as the settings page does: an upsert, as its Clinic Admin. */
async function setClinicSwitch(
  database: TestDatabase,
  adminUserId: string,
  adminId: string,
  value: string,
) {
  const rows = await database.asUser(
    adminUserId,
    `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
     values ($1, $2, $3)
     on conflict (clinic_id, system_setting_key) do update
       set admin_id = excluded.admin_id,
           system_setting_value = excluded.system_setting_value
     returning system_setting_value`,
    [adminId, CLINIC_KEY, value],
  )
  expect(rows).toEqual([{ system_setting_value: value }])
}

describe('the guidance assistant’s switches', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: Awaited<ReturnType<typeof assuredSuperAdmin>>
  let second: { adminUserId: string; adminId: string; patientUserId: string; doctorId: string }

  const availableTo = async (userId: string) =>
    (await database.asUser<{ on: boolean }>(userId, 'select public.guidance_assistant_available() as on'))[0]!.on

  const onForDoctor = async (docId: string) =>
    one<boolean>(database, 'select public.guidance_assistant_on_for_doctor($1)', [docId])

  const setPlatform = (enabled: boolean) =>
    database.asClaims(superAdmin.claims, 'select public.super_admin_set_guidance_assistant($1) as on', [enabled])

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)

    // A second clinic, with its own Clinic Admin, doctor and patient.
    await liftSingleClinicGate(database)
    const clinicId = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
    const account = async (email: string, role: 'patient' | 'doctor' | 'admin') => {
      const userId = await one<string>(
        database,
        'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
        [email],
      )
      await database.asService(
        'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
        [userId, email, role],
      )
      return userId
    }
    const adminUserId = await account('admin@second.test', 'admin')
    const adminId = await one<string>(
      database,
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Admin', 'Second', $2) returning admin_id`,
      [adminUserId, clinicId],
    )
    const doctorUserId = await account('doctor@second.test', 'doctor')
    const doctorId = await one<string>(
      database,
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Doc', 'Second', 'LIC-SECOND', $2) returning doc_id`,
      [doctorUserId, clinicId],
    )
    const patientUserId = await account('patient@second.test', 'patient')
    await database.asService(
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, 'Pat', 'Second', now())`,
      [patientUserId, doctorId],
    )
    second = { adminUserId, adminId, patientUserId, doctorId }
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.system_setting where system_setting_key = $1', [CLINIC_KEY])
    await database.asService('delete from app_private.platform_setting')
  })

  it('is on everywhere until someone turns it off', async () => {
    for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId, second.patientUserId]) {
      expect(await availableTo(userId)).toBe(true)
    }
    expect(await onForDoctor(fx.doctorAId)).toBe(true)
    expect(await onForDoctor(second.doctorId)).toBe(true)
  })

  it('turned off by a clinic, is off for that clinic’s patients only', async () => {
    await setClinicSwitch(database, fx.adminUserId, fx.adminId, 'false')

    expect(await availableTo(fx.aliceUserId)).toBe(false)
    expect(await onForDoctor(fx.doctorAId)).toBe(false)
    expect(await availableTo(second.patientUserId)).toBe(true)
    expect(await onForDoctor(second.doctorId)).toBe(true)

    await setClinicSwitch(database, fx.adminUserId, fx.adminId, 'true')
    expect(await availableTo(fx.aliceUserId)).toBe(true)
  })

  it('reads the clinic’s switch past case and spaces, and fails closed on anything else', async () => {
    await setClinicSwitch(database, fx.adminUserId, fx.adminId, ' TRUE ')
    expect(await onForDoctor(fx.doctorAId)).toBe(true)

    for (const value of ['', 'yes', 'on', '1', 'flase', 'false ']) {
      await setClinicSwitch(database, fx.adminUserId, fx.adminId, value)
      expect(await onForDoctor(fx.doctorAId), JSON.stringify(value)).toBe(false)
    }
  })

  it('turned off for the platform, is off for every clinic, whatever the clinics say', async () => {
    await setClinicSwitch(database, fx.adminUserId, fx.adminId, 'true')
    expect(await setPlatform(false)).toEqual([{ on: false }])

    for (const userId of [fx.aliceUserId, second.patientUserId]) {
      expect(await availableTo(userId)).toBe(false)
    }
    expect(await onForDoctor(fx.doctorAId)).toBe(false)
    expect(await onForDoctor(second.doctorId)).toBe(false)

    await setPlatform(true)
    expect(await availableTo(second.patientUserId)).toBe(true)
  })

  it('shows the Super Admin the platform switch and when it changed', async () => {
    const read = () =>
      database.asClaims<{ enabled: boolean; updated_at: string | null }>(
        superAdmin.claims,
        'select * from public.super_admin_get_guidance_assistant()',
      )
    expect(await read()).toEqual([{ enabled: true, updated_at: null }])

    await setPlatform(false)
    const [row] = await read()
    expect(row!.enabled).toBe(false)
    expect(row!.updated_at).not.toBeNull()
  })

  describe('who may change the platform switch', () => {
    it('refuses a patient, a doctor and a Clinic Admin', async () => {
      for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId]) {
        await expect(
          database.asUser(userId, 'select public.super_admin_set_guidance_assistant(false)'),
        ).rejects.toThrow(/Super Admin access requires/)
        await expect(
          database.asUser(userId, 'select * from public.super_admin_get_guidance_assistant()'),
        ).rejects.toThrow(/Super Admin access requires/)
      }
      expect(await availableTo(fx.aliceUserId)).toBe(true)
    })

    it('refuses an anonymous caller outright', async () => {
      await expect(
          database.asAnon('select public.super_admin_set_guidance_assistant(false)'),
        ).rejects.toThrow(/permission denied|row-level security/)
      await expect(
        database.asAnon('select public.guidance_assistant_available()'),
      ).rejects.toThrow(/permission denied|row-level security/)
    })

    it('refuses a Super Admin whose session is not verified with their authenticator', async () => {
      const unverified = await provisionSuperAdmin(database, 'unverified@platform.test')
      await expect(
        database.asClaims(
          claimsFor(unverified.userId, null, 'aal1'),
          'select public.super_admin_set_guidance_assistant(false)',
        ),
      ).rejects.toThrow(/Super Admin access requires/)
      expect(await availableTo(fx.aliceUserId)).toBe(true)
    })

    it('refuses an empty answer', async () => {
      await expect(
        database.asClaims(superAdmin.claims, 'select public.super_admin_set_guidance_assistant(null)'),
      ).rejects.toThrow(/on or off/)
    })

    it('cannot be read or written through the table by anyone', async () => {
      for (const userId of [fx.aliceUserId, fx.adminUserId, superAdmin.userId]) {
        await expect(
          database.asUser(userId, 'select * from app_private.platform_setting'),
        ).rejects.toThrow(/permission denied|row-level security/)
        await expect(
          database.asUser(
            userId,
            `insert into app_private.platform_setting (platform_setting_key, platform_setting_value)
             values ('guidance_assistant.enabled', 'false')`,
          ),
        ).rejects.toThrow(/permission denied|row-level security/)
      }
      await expect(
        database.asAnon('select * from app_private.platform_setting'),
      ).rejects.toThrow(/permission denied|row-level security/)
    })

    it('holds only the declared key, and only true or false', async () => {
      await expect(
        database.asService(
          `insert into app_private.platform_setting (platform_setting_key, platform_setting_value)
           values ('anything.else', 'true')`,
        ),
      ).rejects.toThrow(/check constraint/)
      await expect(
        database.asService(
          `insert into app_private.platform_setting (platform_setting_key, platform_setting_value)
           values ('guidance_assistant.enabled', 'maybe')`,
        ),
      ).rejects.toThrow(/check constraint/)
    })
  })

  describe('the check chatbot-reply makes', () => {
    it('is the service role’s alone: refused to a patient, a doctor, an administrator and an anonymous caller', async () => {
      for (const userId of [fx.aliceUserId, fx.doctorAUserId, fx.adminUserId, superAdmin.userId]) {
        await expect(
          database.asUser(userId, 'select public.guidance_assistant_on_for_doctor($1)', [fx.doctorAId]),
        ).rejects.toThrow(/permission denied|row-level security/)
      }
      await expect(
        database.asAnon('select public.guidance_assistant_on_for_doctor($1)', [fx.doctorAId]),
      ).rejects.toThrow(/permission denied|row-level security/)
    })
  })

  describe('a clinic’s switch', () => {
    it('is set by each Clinic Admin for their own clinic only', async () => {
      await setClinicSwitch(database, second.adminUserId, second.adminId, 'false')

      expect(
        await database.asService(
          `select c.clinic_name as clinic, s.system_setting_value as value
             from public.system_setting s join public.clinic c using (clinic_id)
            where s.system_setting_key = $1`,
          [CLINIC_KEY],
        ),
      ).toEqual([{ clinic: 'Synthetic Second Clinic', value: 'false' }])
      expect(await availableTo(fx.aliceUserId)).toBe(true)
      expect(await availableTo(second.patientUserId)).toBe(false)
    })

    it('cannot be set by a patient or a doctor', async () => {
      for (const userId of [fx.aliceUserId, fx.doctorAUserId]) {
        await expect(
          database.asUser(
            userId,
            `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
             values ($1, $2, 'false')`,
            [fx.adminId, CLINIC_KEY],
          ),
        ).rejects.toThrow(/permission denied|row-level security/)
      }
      expect(await availableTo(fx.aliceUserId)).toBe(true)
    })
  })

  describe('the audit trail', () => {
    it('records each change of the platform switch as a platform entry, and not an unchanged one', async () => {
      const entries = () =>
        database.asService<{ action: string; scope: string; clinic: string | null }>(
          `select audit_log_action as action, audit_scope::text as scope, clinic_id as clinic
             from public.audit_log where audit_log_entity = 'platform_setting'
            order by audit_log_timestamp, audit_log_id`,
        )
      await database.asService(`delete from public.audit_log where audit_log_entity = 'platform_setting'`)

      await setPlatform(false)
      await setPlatform(false)
      await setPlatform(true)

      expect(await entries()).toEqual([
        { action: 'insert', scope: 'platform', clinic: null },
        { action: 'update', scope: 'platform', clinic: null },
      ])
    })

    it('shows those entries to the Super Admin, and to no Clinic Admin', async () => {
      await setPlatform(false)

      const platform = await database.asClaims<{ audit_log_entity: string }>(
        superAdmin.claims,
        'select audit_log_entity from public.super_admin_list_audit(200)',
      )
      expect(platform.map((entry) => entry.audit_log_entity)).toContain('platform_setting')

      const clinicView = await database.asUser<{ audit_log_entity: string }>(
        fx.adminUserId,
        `select audit_log_entity from public.audit_log where audit_log_entity = 'platform_setting'`,
      )
      expect(clinicView).toEqual([])
    })
  })
})

describe('migration 38 beside the others', () => {
  it('refuses to run twice', async () => {
    const applied = await createTestDatabase()
    try {
      const before = await catalog(applied)
      await expect(applied.applyMigration(MIGRATION_38)).rejects.toThrow(/already been applied/)
      expect(await catalog(applied)).toEqual(before)
    } finally {
      await applied.close()
    }
  })

  it('refuses to run without migration 33, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: '20260902100032' })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_38)).rejects.toThrow(/needs migration 33 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('goes in after 37 with 34 still unapplied, as production has them; then the same schema once 34 follows', async () => {
    // The repository as far as 38: the migrations after it are compared with
    // their own predecessors, in their own suites.
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      createTestDatabase({ stopAfter: MIGRATION_38 }),
    ])
    try {
      await seedFixture(production)
      await production.applyMigration(MIGRATION_35)
      await production.applyMigration(MIGRATION_36)
      await production.applyMigration(MIGRATION_37)
      await production.applyMigration(MIGRATION_38)

      expect(await one(production, `select to_regclass('app_private.platform_setting')::text`)).toBe(
        'app_private.platform_setting',
      )
      expect(await one<boolean>(production, 'select public.guidance_assistant_on_for_doctor(doc_id) from public.doctor limit 1')).toBe(true)
      expect(
        await one<number>(production, `select count(*)::int from pg_indexes where indexname = 'clinic_single_clinic_gate'`),
      ).toBe(1)

      await production.applyMigration(MIGRATION_34)
      expect(await catalog(production)).toEqual(await catalog(repository))
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})

describe('the down-script for migration 38', () => {
  let used: TestDatabase
  let through37: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[used, through37] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_38 }),
      createTestDatabase({ stopAfter: MIGRATION_37 }),
    ])
    fx = await seedFixture(used)
    // Use what 38 adds: both switches, one of them audited.
    const admin = await assuredSuperAdmin(used)
    await used.asClaims(admin.claims, 'select public.super_admin_set_guidance_assistant(false)')
    await setClinicSwitch(used, fx.adminUserId, fx.adminId, 'false')
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through37?.close()])
  })

  it('returns the schema to exactly what 37 left, keeping each clinic’s setting and every audit entry', async () => {
    const rows = async () => ({
      settings: await used.asService(
        'select system_setting_id, clinic_id, system_setting_key, system_setting_value from public.system_setting order by 1',
      ),
      audit: await used.asService(
        'select audit_log_id, audit_log_entity, audit_scope::text from public.audit_log order by 1',
      ),
    })
    const before = await rows()
    expect(before.audit.some((entry) => entry['audit_log_entity'] === 'platform_setting')).toBe(true)

    await used.db.exec(await script(ROLLBACK_38))

    expect(await catalog(used)).toEqual(await catalog(through37))
    expect(await rows()).toEqual(before)
    // The catalog covers public's tables, triggers and indexes; the switch's
    // table lived in app_private, so it is checked by name.
    expect(await one(used, `select to_regclass('app_private.platform_setting')::text`)).toBeNull()
    expect(
      await one<number>(used, `select count(*)::int from pg_indexes where indexname = 'platform_setting_updated_by_idx'`),
    ).toBe(0)
  })

  it('refuses, changing nothing, where migration 38 is not applied', async () => {
    const before = await catalog(through37)
    await expect(through37.db.exec(await script(ROLLBACK_38))).rejects.toThrow(/Migration 38 is not applied/)
    expect(await catalog(through37)).toEqual(before)
  })
})
