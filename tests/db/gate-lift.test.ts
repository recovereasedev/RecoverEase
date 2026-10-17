import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, createSignIn, type Claims } from './helpers/super-admin'

/**
 * Migration 34: the single-clinic gate comes down.
 *
 * Before it, a second clinic is refused - by the Super Admin's own function
 * too, with nothing left half made. After it, a Super Admin creates a second
 * clinic in a zone with daylight saving time, gives it a Clinic Admin, a
 * doctor and a patient, and each clinic keeps its own settings, its own
 * "today" and its own wall-clock dose times.
 */

const BEFORE_GATE_LIFT = '20260902100033'

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

describe('before migration 34', () => {
  let database: TestDatabase
  let superAdmin: { claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase({ stopAfter: BEFORE_GATE_LIFT })
    await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('a Super Admin’s second clinic is refused by the gate, and nothing is left half made', async () => {
    const counts = () =>
      database.asService(
        `select (select count(*)::int from public.clinic) as clinics,
                (select count(*)::int from public.system_setting) as settings,
                (select count(*)::int from public.audit_log) as audit`,
      )
    const before = await counts()
    await expect(
      database.asClaims(superAdmin.claims, `select * from public.super_admin_create_clinic('Second Clinic', 'UTC')`),
    ).rejects.toThrow(/clinic_single_clinic_gate/)
    expect(await counts()).toEqual(before)
  })

  it('migration 34 refuses to run without migration 33', async () => {
    const early = await createTestDatabase({ stopAfter: '20260902100032' })
    try {
      await expect(early.applyMigration('20260902100034')).rejects.toThrow(/needs migration 33 first/)
      expect(await one<number>(early, `select count(*)::int from pg_indexes where indexname = 'clinic_single_clinic_gate'`)).toBe(1)
    } finally {
      await early.close()
    }
  })
})

describe('after migration 34: two clinics, two zones, one with daylight saving time', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { claims: Claims }
  let harborview: string
  let lakeside: string
  let adminBUserId: string
  let patientBUserId: string
  let patientBPatId: string
  let doctorBId: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    harborview = await one<string>(database, 'select clinic_id from public.clinic')

    const [created] = await database.asClaims<{ clinic_id: string }>(
      superAdmin.claims,
      `select clinic_id from public.super_admin_create_clinic('Lakeside Recovery Centre', 'America/New_York')`,
    )
    lakeside = created!.clinic_id

    adminBUserId = await createSignIn(database, 'admin@lakeside.test', {
      provisioned_as: 'clinic_admin',
      provisioned_clinic: lakeside,
    })
    await database.asClaims(superAdmin.claims, `select public.super_admin_attach_clinic_admin($1, $2, 'Lena', 'Hart')`, [
      adminBUserId,
      lakeside,
    ])

    // A doctor and a patient of Lakeside, as create-account would make them:
    // with two clinics, every writer names the clinic.
    const doctorUser = await createSignIn(database, 'doctor@lakeside.test')
    await database.asService(`insert into public.user_account (user_id, user_email, user_role) values ($1, 'doctor@lakeside.test', 'doctor')`, [doctorUser])
    doctorBId = await one<string>(
      database,
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Noah', 'Lake', 'LIC-LAKE-1', $2) returning doc_id`,
      [doctorUser, lakeside],
    )
    patientBUserId = await createSignIn(database, 'patient@lakeside.test')
    await database.asService(`insert into public.user_account (user_id, user_email, user_role) values ($1, 'patient@lakeside.test', 'patient')`, [patientBUserId])
    patientBPatId = await one<string>(
      database,
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, 'Lia', 'Brook', now()) returning pat_id`,
      [patientBUserId, doctorBId],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  it('has dropped the gate and the key-only settings index, and kept one setting of each kind per clinic', async () => {
    expect(
      await database.asService(
        `select indexname from pg_indexes
          where indexname in ('clinic_single_clinic_gate', 'system_setting_key_unique', 'system_setting_clinic_key_unique')`,
      ),
    ).toEqual([{ indexname: 'system_setting_clinic_key_unique' }])
    await expect(
      database.asService(
        `insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
         values ($1, 'medication.reminder_grace_hours', '3')`,
        [lakeside],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('lists both clinics to the Super Admin, each with its Clinic Admin', async () => {
    expect(
      await database.asClaims(
        superAdmin.claims,
        'select clinic_name, clinic_timezone, clinic_admin_count from public.super_admin_list_clinics()',
      ),
    ).toEqual([
      { clinic_name: 'Harborview Recovery Clinic', clinic_timezone: 'Asia/Manila', clinic_admin_count: 1 },
      { clinic_name: 'Lakeside Recovery Centre', clinic_timezone: 'America/New_York', clinic_admin_count: 1 },
    ])
  })

  it('lets each Clinic Admin write the same settings as the other, saved on clinic and key as the screen does', async () => {
    const save = (userId: string, key: string, value: string) =>
      database.asUser(
        userId,
        `insert into public.system_setting (system_setting_key, system_setting_value) values ($1, $2)
         on conflict (clinic_id, system_setting_key) do update set system_setting_value = excluded.system_setting_value`,
        [key, value],
      )
    await save(fx.adminUserId, 'chatbot.system_prompt', 'Harborview guidance')
    await save(adminBUserId, 'chatbot.system_prompt', 'Lakeside guidance')
    await save(adminBUserId, 'medication.reminder_grace_hours', '2')

    const seenBy = (userId: string) =>
      database.asUser(
        userId,
        'select system_setting_key as key, system_setting_value as value from public.system_setting order by 1',
      )
    expect(await seenBy(fx.adminUserId)).toEqual([
      { key: 'chatbot.system_prompt', value: 'Harborview guidance' },
    ])
    expect(await seenBy(adminBUserId)).toEqual([
      { key: 'chatbot.system_prompt', value: 'Lakeside guidance' },
      { key: 'medication.reminder_grace_hours', value: '2' },
    ])
    // What chatbot-reply v15 reads for each patient: their doctor's clinic's
    // prompt, by clinic and key.
    const promptFor = (docId: string) =>
      one<string>(
        database,
        `select s.system_setting_value from public.doctor d
           join public.system_setting s on s.clinic_id = d.clinic_id and s.system_setting_key = 'chatbot.system_prompt'
          where d.doc_id = $1`,
        [docId],
      )
    expect(await promptFor(fx.doctorAId)).toBe('Harborview guidance')
    expect(await promptFor(doctorBId)).toBe('Lakeside guidance')
  })

  it('gives each member their own clinic’s "today", and refuses to guess for a writer with no clinic', async () => {
    const today = (userId: string) =>
      database.asUser<{ d: string }>(userId, 'select public.app_today()::text as d').then((rows) => rows[0]!.d)
    expect(await today(fx.aliceUserId)).toBe(await one<string>(database, `select (now() at time zone 'Asia/Manila')::date::text`))
    expect(await today(patientBUserId)).toBe(
      await one<string>(database, `select (now() at time zone 'America/New_York')::date::text`),
    )
    await expect(database.asService('select public.app_today()')).rejects.toThrow(/With 2 clinics/)
  })

  it('keeps a Lakeside dose at 08:00 New York time on both sides of a daylight-saving change', async () => {
    // The next day New York's offset from UTC changes, whenever the test runs.
    const change = await one<string>(
      database,
      `with days as (
         select d::date as day,
                (d::date + time '12:00')
                  - (((d::date + time '12:00') at time zone 'America/New_York') at time zone 'UTC') as utc_offset
           from generate_series(current_date, current_date + 400, interval '1 day') as d
       )
       select day::text from (
         select day, utc_offset, lag(utc_offset) over (order by day) as previous from days
       ) x
       where previous is not null and utc_offset <> previous
       order by day limit 1`,
    )
    const prescription = await one<string>(
      database,
      `insert into public.prescription (pat_id, doc_id, prescription_issued_date)
       values ($1, $2, $3::date - 3) returning prescription_id`,
      [patientBPatId, doctorBId, change],
    )
    const schedule = await one<string>(
      database,
      `insert into public.medication_schedule
         (prescription_id, medication_schedule_name, medication_schedule_dosage, medication_schedule_frequency,
          medication_schedule_times, medication_schedule_start_date, medication_schedule_end_date)
       values ($1, 'Ibuprofen', '200mg', 1, '{08:00}'::time[], $2::date - 2, $2::date + 2)
       returning medication_schedule_id`,
      [prescription, change],
    )
    await database.asService('select public.generate_medication_log_slots($1, 400)', [schedule])

    const slots = await database.asService<{ local: string; utc_hour: number }>(
      `select to_char(medication_log_scheduled_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as local,
              extract(hour from medication_log_scheduled_at at time zone 'UTC')::int as utc_hour
         from public.medication_log where medication_schedule_id = $1 order by medication_log_scheduled_at`,
      [schedule],
    )
    expect(slots).toHaveLength(5)
    expect(slots.every((slot) => slot.local.endsWith(' 08:00'))).toBe(true)
    // The same wall-clock time is a different UTC hour across the change.
    expect(new Set(slots.map((slot) => slot.utc_hour)).size).toBe(2)
  })

  it('shows a published platform announcement to both clinics, and each clinic’s only to its own', async () => {
    await database.asClaims(superAdmin.claims, `select public.super_admin_create_announcement('Platform update', 'For every clinic', true)`)
    await database.asService(
      `insert into public.announcement (admin_id, announcement_title, announcement_content, announcement_published_at)
       values ((select admin_id from public.admin where user_id = $1), 'Lakeside only', 'Our hours', now())`,
      [adminBUserId],
    )
    const titles = async (userId: string) =>
      (await database.asUser<{ t: string }>(userId, 'select announcement_title as t from public.announcement order by 1')).map((r) => r.t)
    expect(await titles(patientBUserId)).toEqual(['Lakeside only', 'Platform update'])
    const harborviewTitles = await titles(fx.aliceUserId)
    expect(harborviewTitles).toContain('Platform update')
    expect(harborviewTitles).not.toContain('Lakeside only')
  })

  it('keeps each Clinic Admin to their own clinic', async () => {
    expect(await database.asUser(adminBUserId, 'select clinic_name from public.clinic')).toEqual([
      { clinic_name: 'Lakeside Recovery Centre' },
    ])
    expect(
      await database.asUser(adminBUserId, 'select pat_id from public.patient'),
    ).toEqual([])
    expect(
      (await database.asUser<{ user_email: string }>(adminBUserId, 'select user_email from public.user_account order by 1')).map(
        (row) => row.user_email,
      ),
    ).toEqual(['admin@lakeside.test', 'doctor@lakeside.test', 'patient@lakeside.test'])
    expect(harborview).not.toBe(lakeside)
  })
})
