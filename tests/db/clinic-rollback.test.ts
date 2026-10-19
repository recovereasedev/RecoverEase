import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The down-scripts for migrations 31, 30 and 29 (supabase/rollbacks).
 *
 * Production has no point-in-time recovery, so a rollback has to be known
 * good before it could ever be needed. Each script is run against a database
 * that has been used - accounts, settings, a time zone change, announcements,
 * reports, a D8 move with an appointment - and the result is compared,
 * catalog entry by catalog entry, with a database built only up to the
 * migration before. Every row must survive all three. 31's also refuses,
 * changing nothing, while a later migration that depends on it - 33, 36 or
 * 37 - is still installed.
 */

const ROLLBACK_37 = 'supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql'
const ROLLBACK_31 = 'supabase/rollbacks/20260902100031_clinic_settings.down.sql'
const ROLLBACK_30 = 'supabase/rollbacks/20260902100030_clinic_admin_scope.down.sql'
const ROLLBACK_29 = 'supabase/rollbacks/20260902100029_initial_clinic.down.sql'

const MIGRATION_30 = '20260902100030'
const MIGRATION_31 = '20260902100031'
const MIGRATION_33 = '20260902100033'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'

const REFUSED_FOR_37 = /Roll back migration 37 first: its pre-dose medication reminder job reads system_setting\.clinic_id/
const REFUSED_FOR_33 = /Roll back migration 33 first: super_admin_create_clinic writes system_setting\.clinic_id/
const REFUSED_FOR_37_36_33 =
  /Roll back migrations 37, 36 and 33 first, newest first, each with its own down-script - 37: .+; 36: .+; 33: .+\. Nothing was changed\./
const REFUSED_FOR_36_33 = /Roll back migrations 36 and 33 first, newest first, each with its own down-script - 36: .+; 33: .+\./

const ROLLBACK_36 = 'supabase/rollbacks/20260902100036_doctor_announcements.down.sql'
const ROLLBACK_35 = 'supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql'
const ROLLBACK_33 = 'supabase/rollbacks/20260902100033_super_admin_platform.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

/** Whether migration 34's single-clinic gate is still in place. */
const gateCount = async (database: TestDatabase) =>
  (
    await database.asService<{ n: number }>(
      `select count(*)::int as n from pg_indexes where indexname = 'clinic_single_clinic_gate'`,
    )
  )[0]!.n

/** The rows a rollback must leave alone. */
const rows = async (database: TestDatabase) => ({
  accounts: await database.asService('select user_id, user_role, user_email from public.user_account order by 1'),
  doctors: await database.asService('select doc_id, user_id, doc_is_active, doc_license_no from public.doctor order by 1'),
  admins: await database.asService('select admin_id, user_id from public.admin order by 1'),
  patients: await database.asService('select pat_id, user_id, doc_id, pat_status from public.patient order by 1'),
  prescriptions: await database.asService('select prescription_id, pat_id, doc_id from public.prescription order by 1'),
  plans: await database.asService('select treatment_plan_id, pat_id, doc_id from public.treatment_plan order by 1'),
  announcements: await database.asService('select announcement_id, admin_id, announcement_title from public.announcement order by 1'),
  appointments: await database.asService('select appointment_id, pat_id, doc_id, appointment_status, appointment_date from public.appointment order by 1'),
  settings: await database.asService('select system_setting_id, system_setting_key, system_setting_value from public.system_setting order by 1'),
  reports: await database.asService('select report_id, pat_id, user_id, report_type from public.report order by 1'),
  chat: await database.asService(
    `select s.chat_session_id, m.chat_message_id, m.chat_message_content
       from public.chat_session s left join public.chat_message m using (chat_session_id) order by 1, 2`,
  ),
  audit: await database.asService(
    `select audit_log_id, user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details
       from public.audit_log order by 1`,
  ),
})

describe('rolling back migrations 31, 30 and 29 with their down-scripts', () => {
  let used: TestDatabase
  let through28: TestDatabase
  let through29: TestDatabase
  let through30: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[used, through28, through29, through30] = await Promise.all([
      // Built through 31: migrations 32 onwards have their own rollbacks
      // (super-admin-rollback.test.ts), applied before these.
      createTestDatabase({ stopAfter: '20260902100031' }),
      createTestDatabase({ stopAfter: '20260902100028' }),
      createTestDatabase({ stopAfter: '20260902100029' }),
      createTestDatabase({ stopAfter: '20260902100030' }),
    ])
    fx = await seedFixture(used)

    // Use what 31 adds: a clinic setting, a time zone change, and a D8 move
    // that takes an appointment with it.
    await used.asUser(
      fx.adminUserId,
      `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
       values ($1, 'medication.reminder_grace_hours', '4')`,
      [fx.adminId],
    )
    await used.asUser(fx.adminUserId, `select public.admin_set_clinic_timezone('Asia/Singapore')`)
    await used.asService(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, date_trunc('minute', now() + interval '2 days'))`,
      [fx.davePatId, fx.doctorCId],
    )

    // And what 30 adds, so the rollback meets real rows.
    await used.asUser(
      fx.adminUserId,
      `insert into public.report (user_id, report_type) values ($1, 'system_wide')`,
      [fx.adminUserId],
    )
    await used.asUser(
      fx.adminUserId,
      `insert into public.announcement (admin_id, announcement_title, announcement_content)
       values ($1, 'Written after 30', 'Still here after the rollback')`,
      [fx.adminId],
    )
    await used.asUser(fx.adminUserId, 'select public.admin_reassign_doctor_patients($1, $2, 1, 1)', [
      fx.doctorCId,
      fx.doctorAId,
    ])
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through28?.close(), through29?.close(), through30?.close()])
  })

  it('31’s returns the schema to exactly what 30 left, 30’s to what 29 left, and 29’s to what 28 left', async () => {
    const before = await rows(used)

    await used.db.exec(await readFile(join(process.cwd(), ROLLBACK_31), 'utf8'))
    expect(await catalog(used)).toEqual(await catalog(through30))
    // The time zone in force goes back into the global setting, so nothing
    // that reads it moves; the clinic's own setting keeps its value.
    expect(
      await used.asService(
        `select system_setting_key as k, system_setting_value as v from public.system_setting order by 1`,
      ),
    ).toEqual([
      { k: 'app.timezone', v: 'Asia/Singapore' },
      { k: 'medication.reminder_grace_hours', v: '4' },
    ])
    expect(
      await used.asService(`select (now() at time zone 'Asia/Singapore')::date = public.app_today() as same`),
    ).toEqual([{ same: true }])

    await used.db.exec(await readFile(join(process.cwd(), ROLLBACK_30), 'utf8'))
    expect(await catalog(used)).toEqual(await catalog(through29))

    await used.db.exec(await readFile(join(process.cwd(), ROLLBACK_29), 'utf8'))
    expect(await catalog(used)).toEqual(await catalog(through28))

    // Every row survives - the global time zone row apart, which 31's
    // rollback writes back. The D8 move is data, and stays made, with the
    // appointment that went with it.
    const after = await rows(used)
    const existing = new Set(before.audit.map((row) => row.audit_log_id))
    const settingIds = new Set(before.settings.map((row) => row.system_setting_id))
    expect({
      ...after,
      audit: after.audit.filter((row) => existing.has(row.audit_log_id)),
      settings: after.settings.filter((row) => settingIds.has(row.system_setting_id)),
    }).toEqual(before)
    expect(after.patients).toContainEqual(expect.objectContaining({ pat_id: fx.davePatId, doc_id: fx.doctorAId }))
    expect(after.appointments).toContainEqual(expect.objectContaining({ pat_id: fx.davePatId, doc_id: fx.doctorAId }))
    expect(await used.asService('select count(*)::int as n from public.clinic')).toEqual([{ n: 0 }])
  })
})

describe('rolling back migration 31 once there are two clinics', () => {
  it('is refused, and changes nothing: two clinics’ settings cannot be folded into one', async () => {
    const database = await createTestDatabase({ stopAfter: '20260902100031' })
    try {
      await liftSingleClinicGate(database)
      const second = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
      await database.asService(
        `insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
         values ((select clinic_id from public.clinic where clinic_id <> $1), 'chatbot.system_prompt', 'First'),
                ($1, 'chatbot.system_prompt', 'Second')`,
        [second],
      )
      const before = await catalog(database)

      await expect(
        database.db.exec(await readFile(join(process.cwd(), ROLLBACK_31), 'utf8')),
      ).rejects.toThrow(/cannot be folded back into one set while 2 clinics exist/)

      expect(await catalog(database)).toEqual(before)
      expect(
        await database.asService('select count(*)::int as n from public.system_setting'),
      ).toEqual([{ n: 2 }])
    } finally {
      await database.close()
    }
  })
})

describe('rolling back migration 31 while a migration that depends on it is installed', () => {
  // 31's down-script drops system_setting.clinic_id and announcement_guard_author
  // and rewrites the audit functions. Migration 37's reminder job reads the
  // column every minute; 36's doctors' announcements keep their author through
  // the guard; 33's super_admin_create_clinic writes the column, and 33
  // redefines the guard and the audit functions. Run out of order, each of
  // them would be left broken or unprotected.

  it('is refused, and changes nothing, in production’s order: 33, 35, 36 and 37, with 34 never applied', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_33 })
    try {
      const fx = await seedFixture(database)
      await database.applyMigration(MIGRATION_35)
      await database.applyMigration(MIGRATION_36)
      await database.applyMigration(MIGRATION_37)
      // A lead time, which the job reads through the clinic.
      await database.asUser(
        fx.adminUserId,
        `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
         values ($1, 'medication.reminder_lead_minutes', '15')`,
        [fx.adminId],
      )
      const before = await catalog(database)
      const rowsBefore = await rows(database)
      expect(await gateCount(database)).toBe(1)

      // Every dependent is named, newest first, in one refusal.
      await expect(database.db.exec(await script(ROLLBACK_31))).rejects.toThrow(REFUSED_FOR_37_36_33)

      expect(await catalog(database)).toEqual(before)
      expect(await rows(database)).toEqual(rowsBefore)
      expect(await gateCount(database)).toBe(1)
      // What the job needs is still there, and it still runs.
      expect(
        await database.asService(
          `select count(*)::int as n from information_schema.columns
            where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id'`,
        ),
      ).toEqual([{ n: 1 }])
      await expect(
        database.asService('select public.dispatch_medication_pre_dose_reminders() as sent'),
      ).resolves.toEqual([{ sent: expect.any(Number) }])
    } finally {
      await database.close()
    }
  })

  it('goes ahead in the right order: 37’s down-script, then 31’s, return the schema to what 30 left', async () => {
    // 37 needs only what 31 left, so here it sits directly above 31. The
    // migrations between have their own rollbacks (super-admin-rollback.test.ts).
    const [database, through30, through31] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_31 }),
      createTestDatabase({ stopAfter: MIGRATION_30 }),
      createTestDatabase({ stopAfter: MIGRATION_31 }),
    ])
    try {
      await seedFixture(database)
      await database.applyMigration(MIGRATION_37)
      const before = await catalog(database)

      await expect(database.db.exec(await script(ROLLBACK_31))).rejects.toThrow(REFUSED_FOR_37)
      expect(await catalog(database)).toEqual(before)

      await database.db.exec(await script(ROLLBACK_37))
      expect(await catalog(database)).toEqual(await catalog(through31))

      await database.db.exec(await script(ROLLBACK_31))
      expect(await catalog(database)).toEqual(await catalog(through30))
      expect(await gateCount(database)).toBe(1)
    } finally {
      await Promise.all([database.close(), through30.close(), through31.close()])
    }
  })

  it('is refused, and changes nothing, with migration 33 installed and nothing after it', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_33 })
    try {
      const fx = await seedFixture(database)
      await database.asUser(
        fx.adminUserId,
        `insert into public.system_setting (admin_id, system_setting_key, system_setting_value)
         values ($1, 'medication.reminder_grace_hours', '4')`,
        [fx.adminId],
      )
      const before = await catalog(database)
      const rowsBefore = await rows(database)

      await expect(database.db.exec(await script(ROLLBACK_31))).rejects.toThrow(REFUSED_FOR_33)

      expect(await catalog(database)).toEqual(before)
      expect(await rows(database)).toEqual(rowsBefore)
      expect(await gateCount(database)).toBe(1)
      // What 33 depends on is all still there.
      expect(
        await database.asService(
          `select (select count(*)::int from information_schema.columns
                    where table_schema = 'public' and table_name = 'system_setting' and column_name = 'clinic_id') as setting_clinic,
                  (select count(*)::int from pg_trigger where tgname = 'announcement_author_is_fixed') as author_guard`,
        ),
      ).toEqual([{ setting_clinic: 1, author_guard: 1 }])
    } finally {
      await database.close()
    }
  })

  it('goes ahead in production’s reverse order - 37, 36, 35 and 33, then 31 - each refusal naming what is left', async () => {
    const [database, through30] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      createTestDatabase({ stopAfter: MIGRATION_30 }),
    ])
    try {
      await seedFixture(database)
      await database.applyMigration(MIGRATION_35)
      await database.applyMigration(MIGRATION_36)
      await database.applyMigration(MIGRATION_37)

      /** 31's down-script is refused, with `refusal`, and changes nothing. */
      const refused = async (refusal: RegExp) => {
        const before = await catalog(database)
        await expect(database.db.exec(await script(ROLLBACK_31))).rejects.toThrow(refusal)
        expect(await catalog(database)).toEqual(before)
      }

      await refused(REFUSED_FOR_37_36_33)
      await database.db.exec(await script(ROLLBACK_37))
      await refused(REFUSED_FOR_36_33)
      await database.db.exec(await script(ROLLBACK_36))
      await refused(REFUSED_FOR_33)
      await database.db.exec(await script(ROLLBACK_35))
      await refused(REFUSED_FOR_33)
      await database.db.exec(await script(ROLLBACK_33))

      await database.db.exec(await script(ROLLBACK_31))

      // What 30 left - and migration 32's enum value, which PostgreSQL cannot
      // drop (super-admin-rollback.test.ts), and nothing else.
      const expected = (await catalog(through30)).map((entry) =>
        entry.kind === 'enum' && entry.name === 'user_role'
          ? { ...entry, detail: `${entry.detail},super_admin` }
          : entry,
      )
      expect(await catalog(database)).toEqual(expected)
      expect(await gateCount(database)).toBe(1)
    } finally {
      await Promise.all([database.close(), through30.close()])
    }
  })
})
