import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migrations 29 and 30 against a clinic that already has data.
 *
 * Production holds real accounts, patients and history, and the free plan has
 * no point-in-time recovery, so the migrations have to prove themselves on a
 * copy first. Each database here is built up to migration 28, seeded with the
 * synthetic fixture plus history (reports, the Edge Functions' audit entries,
 * an account created and deleted), and only then given 29 and 30 - the order
 * production will see them in.
 *
 * Every id, link, clinical row and conversation must come through unchanged.
 * Any inconsistent record must stop migration 29 with nothing applied.
 */

const THROUGH_28 = { stopAfter: '20260902100028' }
const MIGRATION_29 = '20260902100029'
const MIGRATION_30 = '20260902100030'

/** What each kind of audit entry is for. Anything not named is clinical. */
const EXPECTED_SCOPE: Record<string, string> = {
  clinic: 'platform',
  doctor: 'administration',
  doctor_account: 'administration',
  announcement: 'administration',
  system_setting: 'administration',
  patient: 'clinical',
  patient_account: 'clinical',
  prescription: 'clinical',
  treatment_plan: 'clinical',
}

async function tableCounts(database: TestDatabase): Promise<Record<string, number>> {
  const tables = await database.asService<{ name: string }>(
    `select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
  )
  const counts: Record<string, number> = {}
  for (const { name } of tables) {
    const [row] = await database.asService<{ n: number }>(
      `select count(*)::int as n from public.${name}`,
    )
    counts[name] = row!.n
  }
  return counts
}

/** Every row of every table the migrations must leave alone, in full. */
async function untouched(database: TestDatabase) {
  const all = (table: string, key: string) =>
    database.asService(`select * from public.${table} order by ${key}`)
  return {
    patients: await all('patient', 'pat_id'),
    plans: await all('treatment_plan', 'treatment_plan_id'),
    goals: await all('treatment_goal', 'treatment_goal_id'),
    prescriptions: await all('prescription', 'prescription_id'),
    schedules: await all('medication_schedule', 'medication_schedule_id'),
    doses: await all('medication_log', 'medication_log_id'),
    recovery: await all('recovery_log', 'recovery_log_id'),
    notes: await all('doctor_note', 'doctor_note_id'),
    appointments: await all('appointment', 'appointment_id'),
    sessions: await all('chat_session', 'chat_session_id'),
    messages: await all('chat_message', 'chat_message_id'),
    notifications: await all('notification', 'notification_id'),
    settings: await all('system_setting', 'system_setting_id'),
    accounts: await all('user_account', 'user_id'),
    // Profiles and the tables the migrations add a column to, without it.
    doctors: await database.asService(
      `select doc_id, user_id, doc_first_name, doc_last_name, doc_license_no,
              doc_is_active from public.doctor order by doc_id`,
    ),
    admins: await database.asService(
      'select admin_id, user_id, admin_first_name, admin_last_name from public.admin order by admin_id',
    ),
    announcements: await database.asService(
      `select announcement_id, admin_id, announcement_title, announcement_content,
              announcement_published_at from public.announcement order by announcement_id`,
    ),
    reports: await database.asService(
      'select report_id, pat_id, user_id, report_type from public.report order by report_id',
    ),
    audit: await database.asService(
      `select audit_log_id, user_id, audit_log_action, audit_log_entity,
              audit_log_entity_id, audit_log_details
         from public.audit_log order by audit_log_id`,
    ),
  }
}

/** History production has and the bare fixture does not. */
async function seedHistory(database: TestDatabase, fx: Fixture) {
  await database.asService(
    `insert into public.report (user_id, report_type) values ($1, 'system_wide')`,
    [fx.adminUserId],
  )
  await database.asService(
    `insert into public.report (pat_id, user_id, report_type) values ($1, $2, 'patient_recovery')`,
    [fx.alicePatId, fx.doctorAUserId],
  )
  // The entries the Edge Functions write through the service role.
  await database.asService(
    `insert into public.audit_log
       (user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details)
     values ($1, 'create', 'doctor_account', $2, '{"created_by_role": "admin"}'),
            ($3, 'create', 'patient_account', $4, '{"created_by_role": "doctor"}'),
            ($5, 'update', 'account_password', $5, '{"reason": "initial_password_setup"}'),
            ($6, 'update', 'account_password', $6, '{"reason": "initial_password_setup"}')`,
    [fx.adminUserId, fx.doctorBId, fx.doctorAUserId, fx.bobPatId, fx.aliceUserId, fx.doctorBUserId],
  )
  // An account created and then removed, as create-account's clean-up does.
  const [gone] = await database.asService<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), 'removed@recoverease.test')
     returning id`,
  )
  await database.asService(
    `insert into public.user_account (user_id, user_email, user_role) values ($1, $2, 'patient')`,
    [gone!.id, 'removed@recoverease.test'],
  )
  await database.asService('delete from public.user_account where user_id = $1', [gone!.id])
  await database.asService('delete from auth.users where id = $1', [gone!.id])
}

describe('migrations 29 and 30 on a clinic that already has data', () => {
  let database: TestDatabase
  let fx: Fixture
  let before: Awaited<ReturnType<typeof untouched>>
  let countsBefore: Record<string, number>
  let countsAfter29: Record<string, number>
  let countsAfter30: Record<string, number>
  let clinicId: string

  beforeAll(async () => {
    database = await createTestDatabase(THROUGH_28)
    fx = await seedFixture(database)
    await seedHistory(database, fx)

    before = await untouched(database)
    countsBefore = await tableCounts(database)
    await database.applyMigration(MIGRATION_29)
    countsAfter29 = await tableCounts(database)
    await database.applyMigration(MIGRATION_30)
    countsAfter30 = await tableCounts(database)

    const [clinic] = await database.asService<{ id: string }>(
      'select clinic_id as id from public.clinic',
    )
    clinicId = clinic!.id
  })

  afterAll(async () => {
    await database?.close()
  })

  it('creates Harborview Recovery Clinic, active, in Asia/Manila, and no other', async () => {
    expect(
      await database.asService(
        `select clinic_name as name, clinic_status::text as status, clinic_timezone as tz
           from public.clinic`,
      ),
    ).toEqual([{ name: 'Harborview Recovery Clinic', status: 'active', tz: 'Asia/Manila' }])
  })

  it('puts every doctor and the admin in it, and leaves none without a clinic', async () => {
    const outside = await database.asService(
      `select 'doctor' as kind, doc_id as id from public.doctor where clinic_id is distinct from $1
       union all
       select 'admin', admin_id from public.admin where clinic_id is distinct from $1`,
      [clinicId],
    )
    expect(outside).toEqual([])

    const [column] = await database.asService<{ nullable: string }>(
      `select is_nullable as nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'doctor' and column_name = 'clinic_id'`,
    )
    expect(column!.nullable).toBe('NO')
  })

  it('keeps every id, account, profile, patient link, clinical record and conversation', async () => {
    const after = await untouched(database)
    // The migrations add audit entries of their own (counted below); every
    // entry that was already there must be exactly as it was.
    const existing = new Set(before.audit.map((row) => row.audit_log_id))
    expect({
      ...after,
      audit: after.audit.filter((row) => existing.has(row.audit_log_id)),
    }).toEqual(before)
  })

  it('changes no row count except the clinic and the audit entries it writes', async () => {
    const doctors = countsBefore.doctor!
    expect(countsAfter29).toEqual({
      ...countsBefore,
      clinic: countsBefore.clinic! + 1,
      // The clinic's own entry, and one per doctor for joining it.
      audit_log: countsBefore.audit_log! + 1 + doctors,
    })
    expect(countsAfter30).toEqual({
      ...countsAfter29,
      // One per announcement for taking its author's clinic.
      audit_log: countsAfter29.audit_log! + countsBefore.announcement!,
    })
  })

  it('records the clinic and each doctor joining it in the audit trail', async () => {
    const [clinicEntry] = await database.asService<{ action: string; scope: string }>(
      `select audit_log_action as action, audit_scope::text as scope from public.audit_log
        where audit_log_entity = 'clinic' and audit_log_entity_id = $1`,
      [clinicId],
    )
    expect(clinicEntry).toEqual({ action: 'insert', scope: 'platform' })

    const joined = await database.asService<{ id: string }>(
      `select audit_log_entity_id as id from public.audit_log
        where audit_log_entity = 'doctor' and audit_log_action = 'update'
          and audit_log_details -> 'changed_columns' = '["clinic_id"]'::jsonb
        order by 1`,
    )
    expect(joined.map((row) => row.id)).toEqual(
      [fx.doctorAId, fx.doctorBId, fx.doctorCId].sort(),
    )
  })

  it('gives every announcement, report and audit entry the clinic', async () => {
    const outside = await database.asService(
      `select 'announcement' as t from public.announcement where clinic_id is distinct from $1
       union all select 'report' from public.report where clinic_id is distinct from $1
       union all select 'audit' from public.audit_log where clinic_id is distinct from $1`,
      [clinicId],
    )
    expect(outside).toEqual([])
  })

  it('classifies every existing entry by what it is about', async () => {
    const entries = await database.asService<{
      entity: string
      scope: string
      role: string | null
    }>(
      `select l.audit_log_entity as entity, l.audit_scope::text as scope,
              coalesce(l.audit_log_details #>> '{record,user_role}',
                       (select ua.user_role::text from public.user_account ua
                         where ua.user_id = l.audit_log_entity_id)) as role
         from public.audit_log l`,
    )
    expect(entries.length).toBeGreaterThan(20)
    for (const entry of entries) {
      const expected =
        entry.entity === 'user_account' || entry.entity === 'account_password'
          ? entry.role === 'patient'
            ? 'clinical'
            : 'administration'
          : (EXPECTED_SCOPE[entry.entity] ?? 'clinical')
      expect({ ...entry, scope: entry.scope }).toEqual({ ...entry, scope: expected })
    }

    // The account that no longer exists is still known to be a patient's,
    // from the copy recorded when it was written.
    const [removed] = await database.asService<{ scopes: string[] }>(
      `select array_agg(distinct audit_scope::text) as scopes from public.audit_log
        where audit_log_entity = 'user_account'
          and audit_log_details #>> '{record,user_email}' is null
          and audit_log_entity_id not in (select user_id from public.user_account)`,
    )
    expect(removed!.scopes).toEqual(['clinical'])
  })

  it('makes only the clinic itself a platform entry', async () => {
    const platform = await database.asService<{ entity: string; details: Record<string, unknown> }>(
      `select audit_log_entity as entity, audit_log_details as details
         from public.audit_log where audit_scope = 'platform'`,
    )
    expect(platform.map((row) => row.entity)).toEqual(['clinic'])
    // The clinic's own fields, and nothing about any person.
    const record = platform[0]!.details.record as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([
      'clinic_created_at',
      'clinic_id',
      'clinic_name',
      'clinic_status',
      'clinic_timezone',
      'clinic_updated_at',
    ])
  })

  it('gives the clinic helpers real answers for every member', async () => {
    for (const member of [fx.adminUserId, fx.doctorAUserId, fx.doctorCUserId, fx.aliceUserId, fx.daveUserId]) {
      expect(
        await database.asUser(member, 'select app_private.current_clinic_id() as clinic'),
      ).toEqual([{ clinic: clinicId }])
    }
    expect(
      await database.asUser(
        fx.adminUserId,
        `select app_private.clinic_of_doctor($1) as doctor, app_private.clinic_of_patient($2) as patient,
                app_private.admin_clinic_id() as administers`,
        [fx.doctorBId, fx.carolPatId],
      ),
    ).toEqual([{ doctor: clinicId, patient: clinicId, administers: clinicId }])
    // Only a Clinic Admin administers it.
    expect(
      await database.asUser(fx.doctorAUserId, 'select app_private.admin_clinic_id() as administers'),
    ).toEqual([{ administers: null }])
    // A member reads their own clinic, and now has one to read.
    expect(
      await database.asUser(fx.aliceUserId, 'select clinic_name as name from public.clinic'),
    ).toEqual([{ name: 'Harborview Recovery Clinic' }])
  })

  it('keeps the single-clinic gate: settings are not per clinic until migration 31', async () => {
    await expect(
      database.asService(`insert into public.clinic (clinic_name) values ('Synthetic Second Clinic')`),
    ).rejects.toMatchObject({ code: '23505', message: expect.stringContaining('clinic_single_clinic_gate') })
  })
})

describe('migration 29 refuses inconsistent data and changes nothing', () => {
  /** A database through 28 with the fixture, broken by `inject`. */
  async function broken(inject: (database: TestDatabase, fx: Fixture) => Promise<void>) {
    const database = await createTestDatabase(THROUGH_28)
    const fx = await seedFixture(database)
    await inject(database, fx)
    return { database, fx }
  }

  /** Writes past the guards, as only a direct database edit could. */
  async function bypassingGuards(database: TestDatabase, sql: string, params: unknown[] = []) {
    await database.db.exec('begin')
    try {
      await database.db.exec('set local session_replication_role = replica')
      await database.db.query(sql, params)
      await database.db.exec('commit')
    } catch (error) {
      await database.db.exec('rollback')
      throw error
    }
  }

  async function expectRefusedAndUnchanged(database: TestDatabase, reason: RegExp) {
    const auditBefore = await database.asService<{ n: number }>(
      'select count(*)::int as n from public.audit_log',
    )
    await expect(database.applyMigration(MIGRATION_29)).rejects.toThrow(reason)
    expect(
      await database.asService(
        `select (select count(*)::int from public.clinic) as clinics,
                (select count(*)::int from information_schema.columns
                  where table_schema = 'public' and table_name in ('doctor', 'admin')
                    and column_name = 'clinic_id') as clinic_columns,
                (select count(*)::int from public.audit_log) as audit_rows`,
      ),
    ).toEqual([{ clinics: 0, clinic_columns: 0, audit_rows: auditBefore[0]!.n }])
  }

  it('a doctor profile on a patient’s account', async () => {
    const { database } = await broken(async (db, fx) => {
      await bypassingGuards(
        db,
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
         values ($1, 'Wrong', 'Role', 'LIC-SYN-BAD')`,
        [fx.bobUserId],
      )
    })
    try {
      await expectRefusedAndUnchanged(database, /doctor .+ is on a patient account/)
    } finally {
      await database.close()
    }
  })

  it('an account with no profile', async () => {
    const { database } = await broken(async (db) => {
      const [user] = await db.asService<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), 'bare@recoverease.test') returning id`,
      )
      await db.asService(
        `insert into public.user_account (user_id, user_email, user_role) values ($1, 'bare@recoverease.test', 'doctor')`,
        [user!.id],
      )
    })
    try {
      await expectRefusedAndUnchanged(database, /account .+ has 0 profiles/)
    } finally {
      await database.close()
    }
  })

  it('two profiles on one account', async () => {
    const { database } = await broken(async (db, fx) => {
      await bypassingGuards(
        db,
        `insert into public.admin (user_id, admin_first_name, admin_last_name) values ($1, 'Second', 'Profile')`,
        [fx.doctorBUserId],
      )
    })
    try {
      await expectRefusedAndUnchanged(database, /has 2 profiles/)
    } finally {
      await database.close()
    }
  })

  it('a patient whose doctor no longer exists', async () => {
    const { database } = await broken(async (db, fx) => {
      await bypassingGuards(db, 'delete from public.doctor where doc_id = $1', [fx.doctorCId])
    })
    try {
      await expectRefusedAndUnchanged(database, /patient .+ has no doctor/)
    } finally {
      await database.close()
    }
  })

  it('an application time zone other than Asia/Manila', async () => {
    const { database } = await broken(async (db) => {
      await db.asService(
        `insert into public.system_setting (system_setting_key, system_setting_value)
         values ('app.timezone', 'Asia/Tokyo')`,
      )
    })
    try {
      await expectRefusedAndUnchanged(database, /application time zone is Asia\/Tokyo/)
    } finally {
      await database.close()
    }
  })

  it('a clinic that already exists', async () => {
    const database = await createTestDatabase(THROUGH_28)
    try {
      await database.asService(`insert into public.clinic (clinic_name) values ('Synthetic Early Clinic')`)
      await expect(database.applyMigration(MIGRATION_29)).rejects.toThrow(/already exist/)
      expect(
        await database.asService('select clinic_name as name from public.clinic'),
      ).toEqual([{ name: 'Synthetic Early Clinic' }])
    } finally {
      await database.close()
    }
  })

  it('still runs when the time zone setting is Asia/Manila', async () => {
    const { database } = await broken(async (db) => {
      await db.asService(
        `insert into public.system_setting (system_setting_key, system_setting_value)
         values ('app.timezone', 'Asia/Manila')`,
      )
    })
    try {
      await database.applyMigration(MIGRATION_29)
      expect(
        await database.asService('select clinic_timezone as tz from public.clinic'),
      ).toEqual([{ tz: 'Asia/Manila' }])
    } finally {
      await database.close()
    }
  })
})

describe('migration 30 runs only after 29, and only once', () => {
  it('refuses to run before migration 29', async () => {
    const database = await createTestDatabase(THROUGH_28)
    try {
      await expect(database.applyMigration(MIGRATION_30)).rejects.toThrow(/needs migration 29 first/)
      expect(
        await database.asService(
          `select count(*)::int as n from information_schema.columns
            where table_schema = 'public' and column_name in ('clinic_id', 'audit_scope')
              and table_name in ('audit_log', 'announcement', 'report')`,
        ),
      ).toEqual([{ n: 0 }])
    } finally {
      await database.close()
    }
  })

  it('refuses to run a second time', async () => {
    const database = await createTestDatabase()
    try {
      await expect(database.applyMigration(MIGRATION_30)).rejects.toThrow(/already been applied/)
    } finally {
      await database.close()
    }
  })
})

/** A doctor account, then its profile with no clinic - the deployed create-account's order. */
async function newDoctorWithoutClinic(database: TestDatabase, licence: string) {
  const email = `${licence}@recoverease.test`
  const [user] = await database.asService<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [email],
  )
  await database.asService(
    `insert into public.user_account (user_id, user_email, user_role) values ($1, $2, 'doctor')`,
    [user!.id, email],
  )
  return database.asService<{ clinic: string }>(
    `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no)
     values ($1, 'Auto', 'Assigned', $2) returning clinic_id as clinic`,
    [user!.id, licence.toUpperCase()],
  )
}

describe('a doctor created without a clinic, until migration 31', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.close()
  })

  it('joins the only clinic there is - which is what the deployed create-account relies on', async () => {
    const [clinic] = await database.asService<{ id: string }>('select clinic_id as id from public.clinic')
    expect(await newDoctorWithoutClinic(database, 'lic-auto-1')).toEqual([{ clinic: clinic!.id }])
  })

  it('is refused when two clinics exist, rather than guessed', async () => {
    // In a database of its own: a clinic with audit history cannot be
    // deleted afterwards, by design.
    const two = await createTestDatabase()
    try {
      await two.db.exec('drop index public.clinic_single_clinic_gate')
      await two.asService(`insert into public.clinic (clinic_name) values ('Synthetic Second Clinic')`)
      await expect(newDoctorWithoutClinic(two, 'lic-auto-2')).rejects.toMatchObject({
        code: '23502',
        message: expect.stringContaining('with 2 clinics none can be assumed'),
      })
    } finally {
      await two.close()
    }
  })

  it('is refused when there is no clinic', async () => {
    // Built only up to 29, before audit entries carry a clinic, so the
    // clinic can be removed to leave none.
    const none = await createTestDatabase({ stopAfter: MIGRATION_29 })
    try {
      await none.asService('delete from public.clinic')
      await expect(newDoctorWithoutClinic(none, 'lic-auto-0')).rejects.toMatchObject({
        code: '23502',
        message: expect.stringContaining('with 0 clinics'),
      })
    } finally {
      await none.close()
    }
  })
})
