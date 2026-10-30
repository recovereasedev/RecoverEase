import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 43: a system-wide report keeps the figures it was generated
 * with, so module 9.5's history can download it again as it was. The
 * figures are the database's - `admin_record_system_report()` computes them
 * with `admin_dashboard_stats()` - and nobody signed in can write or change
 * them; who may read them is `report_select`, unchanged.
 */

const MIGRATION_42 = '20260902100042'
const MIGRATION_43 = '20260902100043'
const MIGRATION_43_FILE = 'supabase/migrations/20260902100043_system_report_snapshot.sql'
const ROLLBACK_43 = 'supabase/rollbacks/20260902100043_system_report_snapshot.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

/** A script's lines of SQL, without its comments or blank lines. */
const codeLines = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))

const GUARD = /figures are recorded by the database/

type Recorded = {
  report_id: string
  user_id: string
  report_type: string
  clinic_id: string
  report_snapshot: {
    patients: { total: number; active: number }
    doctors: { total: number; active: number }
    accounts: Record<string, number>
    appointments: { upcoming: number }
    generated_at: string
  }
}

const RECORD = 'select (public.admin_record_system_report()).*'

async function account(database: TestDatabase, email: string, role: 'admin') {
  const [user] = await database.asService<{ id: string }>(
    'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
    [email],
  )
  await database.asService(
    'insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)',
    [user!.id, email, role],
  )
  return user!.id
}

describe('a system-wide report and its kept figures (migration 43)', () => {
  let database: TestDatabase
  let fx: Fixture
  let clinicA: string
  let otherAdminUserId: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    clinicA = (await database.asService<{ clinic_id: string }>('select clinic_id from public.clinic'))[0]!
      .clinic_id
    await liftSingleClinicGate(database)
    const clinicB = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
    otherAdminUserId = await account(database, 'admin.b@second.test', 'admin')
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Bianca', 'Ortiz', $2)`,
      [otherAdminUserId, clinicB],
    )
  })

  afterAll(async () => {
    await database.close()
  })

  it('records the report with the figures the database computes for the Clinic Admin’s clinic', async () => {
    const [stats] = await database.asUser<{ stats: Recorded['report_snapshot'] }>(
      fx.adminUserId,
      'select public.admin_dashboard_stats() as stats',
    )
    const [recorded] = await database.asUser<Recorded>(fx.adminUserId, RECORD)

    expect(recorded!.user_id).toBe(fx.adminUserId)
    expect(recorded!.report_type).toBe('system_wide')
    expect(recorded!.clinic_id).toBe(clinicA)
    const { generated_at: _when, ...figures } = recorded!.report_snapshot
    const { generated_at: _then, ...expected } = stats!.stats
    expect(figures).toEqual(expected)
    expect(figures.patients.total).toBeGreaterThan(0)
  })

  it('keeps them: the report reads back with the same figures after the clinic changes', async () => {
    const [recorded] = await database.asUser<Recorded>(fx.adminUserId, RECORD)
    await database.asService(`update public.patient set pat_status = 'inactive' where pat_id = $1`, [
      fx.alicePatId,
    ])
    try {
      const [kept] = await database.asUser<Recorded>(
        fx.adminUserId,
        'select report_snapshot from public.report where report_id = $1',
        [recorded!.report_id],
      )
      expect(kept!.report_snapshot).toEqual(recorded!.report_snapshot)
      const [now] = await database.asUser<{ stats: Recorded['report_snapshot'] }>(
        fx.adminUserId,
        'select public.admin_dashboard_stats() as stats',
      )
      expect(now!.stats.patients.active).toBe(recorded!.report_snapshot.patients.active - 1)
    } finally {
      await database.asService(`update public.patient set pat_status = 'active' where pat_id = $1`, [
        fx.alicePatId,
      ])
    }
  })

  it('is refused to anyone but a Clinic Admin', async () => {
    for (const userId of [fx.doctorAUserId, fx.aliceUserId]) {
      await expect(database.asUser(userId, RECORD)).rejects.toThrow(/Administrator privileges are required/)
    }
    await expect(database.asAnon(RECORD)).rejects.toThrow(/permission denied/)
  })

  it('cannot be given made-up figures, or have its figures changed, by anyone signed in', async () => {
    await expect(
      database.asUser(
        fx.adminUserId,
        `insert into public.report (user_id, report_type, report_snapshot)
         values ($1, 'system_wide', '{"patients": {"total": 999}}'::jsonb)`,
        [fx.adminUserId],
      ),
    ).rejects.toThrow(GUARD)

    const [recorded] = await database.asUser<Recorded>(fx.adminUserId, RECORD)
    // No policy lets anyone update a report; the guard stands behind that.
    await database.asUser(
      fx.adminUserId,
      `update public.report set report_snapshot = '{}'::jsonb where report_id = $1`,
      [recorded!.report_id],
    )
    const [kept] = await database.asService<Recorded>(
      'select report_snapshot from public.report where report_id = $1',
      [recorded!.report_id],
    )
    expect(kept!.report_snapshot).toEqual(recorded!.report_snapshot)

    // A report row without figures is still allowed, as before 43.
    await expect(
      database.asUser(
        fx.adminUserId,
        `insert into public.report (user_id, report_type) values ($1, 'system_wide')`,
        [fx.adminUserId],
      ),
    ).resolves.toEqual([])
  })

  it('is never kept for a recovery report, which holds a patient’s record', async () => {
    await expect(
      database.asService(
        `insert into public.report (user_id, report_type, pat_id, report_snapshot)
         values ($1, 'patient_recovery', $2, '{}'::jsonb)`,
        [fx.doctorAUserId, fx.alicePatId],
      ),
    ).rejects.toThrow(/report_snapshot_system_wide_only/)
  })

  it('is read only where the report always was: its author and its clinic’s Clinic Admins', async () => {
    const [recorded] = await database.asUser<Recorded>(fx.adminUserId, RECORD)
    const readBy = async (userId: string) =>
      database.asUser(userId, 'select report_snapshot from public.report where report_id = $1', [
        recorded!.report_id,
      ])

    expect(await readBy(fx.adminUserId)).toHaveLength(1)
    expect(await readBy(otherAdminUserId)).toEqual([])
    expect(await readBy(fx.doctorAUserId)).toEqual([])
    expect(await readBy(fx.aliceUserId)).toEqual([])
  })

  it('counts another clinic’s Clinic Admin’s report from their own clinic only', async () => {
    const [mine] = await database.asUser<Recorded>(fx.adminUserId, RECORD)
    const [theirs] = await database.asUser<Recorded>(otherAdminUserId, RECORD)
    expect(theirs!.clinic_id).not.toBe(clinicA)
    expect(theirs!.report_snapshot.patients.total).toBe(0)
    expect(mine!.report_snapshot.patients.total).toBeGreaterThan(0)
  })
})

describe('migration 43, before and after', () => {
  it('waits at most 3 seconds for its lock, and puts the setting back', async () => {
    const lines = codeLines(await script(MIGRATION_43_FILE))
    expect(lines[0]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase({ stopAfter: MIGRATION_42 })
    try {
      await database.applyMigration(MIGRATION_43)
      const [after] = await database.asService<{ lock_timeout: string }>(
        `select current_setting('lock_timeout') as lock_timeout`,
      )
      expect(after!.lock_timeout).toBe('0')
      // Run again from the top, as after a lock it could not get.
      await database.applyMigration(MIGRATION_43)
    } finally {
      await database.close()
    }
  })

  it('leaves every report generated before it without figures, rather than inventing them', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_42 })
    try {
      const fx = await seedFixture(database)
      await database.asService(
        `insert into public.report (user_id, report_type) values ($1, 'system_wide')`,
        [fx.adminUserId],
      )
      await database.applyMigration(MIGRATION_43)
      const rows = await database.asService<{ report_snapshot: unknown }>(
        'select report_snapshot from public.report',
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.report_snapshot === null)).toBe(true)
    } finally {
      await database.close()
    }
  })

  it('rolls back - every report kept, its figures gone - refuses to run twice, and leaves the setting', async () => {
    const lines = codeLines(await script(ROLLBACK_43))
    const checked = lines.indexOf('$$;')
    expect(lines.slice(0, checked + 1).some((line) => /^(drop|create|alter)\b/.test(line))).toBe(false)
    expect(lines[checked + 1]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.asUser(fx.adminUserId, RECORD)
      const before = await database.asService<{ n: number }>('select count(*)::int as n from public.report')

      await database.db.exec(await script(ROLLBACK_43))

      expect(await database.asService('select count(*)::int as n from public.report')).toEqual(before)
      expect(
        await database.asService(
          `select 1 from information_schema.columns
            where table_name = 'report' and column_name = 'report_snapshot'
           union all
           select 1 from pg_proc where proname in ('admin_record_system_report', 'report_guard_snapshot')`,
        ),
      ).toEqual([])
      const [setting] = await database.asService<{ lock_timeout: string }>(
        `select current_setting('lock_timeout') as lock_timeout`,
      )
      expect(setting!.lock_timeout).toBe('0')

      await expect(database.db.exec(await script(ROLLBACK_43))).rejects.toThrow(
        /Migration 43 is not applied/,
      )
    } finally {
      await database.close()
    }
  })
})
