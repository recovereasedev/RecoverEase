import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
 * migration before. Every row must survive all three.
 */

const ROLLBACK_31 = 'supabase/rollbacks/20260902100031_clinic_settings.down.sql'
const ROLLBACK_30 = 'supabase/rollbacks/20260902100030_clinic_admin_scope.down.sql'
const ROLLBACK_29 = 'supabase/rollbacks/20260902100029_initial_clinic.down.sql'

/** Everything that defines the schema's behaviour, in a comparable form. */
const CATALOG = `
  select 'policy' as kind, tablename || '.' || policyname as name,
         cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '-')
           || ' ' || coalesce(with_check, '-') as detail
    from pg_policies where schemaname = 'public'
  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(p.prosrc) || ' definer=' || p.prosecdef || ' ' || p.provolatile::text
           || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
           || ' acl=' || coalesce(array_to_string(p.proacl, ','), '-')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private')
  union all
  select 'column', table_name || '.' || column_name,
         data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-')
    from information_schema.columns where table_schema = 'public'
  union all
  select 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
  union all
  select 'index', indexname, indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'enum', t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_enum e on e.enumtypid = t.oid
   where t.typnamespace = 'public'::regnamespace
   group by t.typname
  order by 1, 2
`

const catalog = (database: TestDatabase) =>
  database.asService<{ kind: string; name: string; detail: string }>(CATALOG)

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
      createTestDatabase(),
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
    const database = await createTestDatabase()
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
