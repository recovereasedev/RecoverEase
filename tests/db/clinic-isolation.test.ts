import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Two clinics, side by side (migration 30).
 *
 * Production has one clinic and a gate that refuses a second until every
 * reader of a setting is clinic-aware (lifted with clinic creation, after
 * migration 31). This suite lifts the gate in its own database only, so that
 * every Clinic Admin rule can be shown to stop at the clinic's edge - not
 * merely to pass because there is nothing beyond it.
 *
 *   Clinic A (Harborview, from migration 29): the shared fixture -
 *     admin, doctors A and B, deactivated doctor C; Alice, Bob, Carol, Dave.
 *   Clinic B (synthetic): admin B, doctor D, deactivated doctor E;
 *     Dana (doctor D), Erin (doctor E).
 */

const REFUSED = { code: '42501' }

type ClinicB = {
  clinicA: string
  clinicB: string
  adminBUserId: string
  adminBId: string
  doctorDUserId: string
  doctorDId: string
  doctorEUserId: string
  doctorEId: string
  danaUserId: string
  danaPatId: string
  erinUserId: string
  erinPatId: string
  publishedBId: string
  draftBId: string
  reportBId: string
}

async function account(database: TestDatabase, email: string, role: 'patient' | 'doctor' | 'admin') {
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

async function seedSecondClinic(database: TestDatabase): Promise<ClinicB> {
  const one = async (sql: string, params: unknown[] = []) =>
    Object.values((await database.asService<Record<string, string>>(sql, params))[0]!)[0]!

  const clinicA = await one('select clinic_id from public.clinic')
  await liftSingleClinicGate(database)
  const clinicB = await one(
    `insert into public.clinic (clinic_name, clinic_timezone)
     values ('Synthetic Second Clinic', 'Asia/Tokyo') returning clinic_id`,
  )

  const adminBUserId = await account(database, 'admin.b@second.test', 'admin')
  const adminBId = await one(
    `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
     values ($1, 'Bianca', 'Ortiz', $2) returning admin_id`,
    [adminBUserId, clinicB],
  )

  // With two clinics none can be assumed, so each doctor's is given.
  const doctor = async (email: string, licence: string, active: boolean) => {
    const userId = await account(database, email, 'doctor')
    const docId = await one(
      `insert into public.doctor
         (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Second', 'Clinician', $2, $3, $4) returning doc_id`,
      [userId, licence, active, clinicB],
    )
    return { userId, docId }
  }
  const doctorD = await doctor('doctor.d@second.test', 'LIC-B-D', true)
  const doctorE = await doctor('doctor.e@second.test', 'LIC-B-E', false)

  const patient = async (email: string, first: string, docId: string) => {
    const userId = await account(database, email, 'patient')
    const patId = await one(
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, $3, 'Mendoza', now()) returning pat_id`,
      [userId, docId, first],
    )
    return { userId, patId }
  }
  const dana = await patient('dana@second.test', 'Dana', doctorD.docId)
  const erin = await patient('erin@second.test', 'Erin', doctorE.docId)

  await database.asService(
    // With two clinics "today" is whose-today: a server-side insert gives its
    // date rather than take app_today()'s default (migration 31).
    `insert into public.prescription (pat_id, doc_id, prescription_notes, prescription_issued_date)
     values ($1, $2, 'Second clinic notes', date '2026-09-01')`,
    [dana.patId, doctorD.docId],
  )
  await database.asService(
    `insert into public.chat_session (pat_id, chat_session_summary) values ($1, 'Second clinic chat')`,
    [dana.patId],
  )

  const publishedBId = await one(
    `insert into public.announcement (admin_id, announcement_title, announcement_content, announcement_published_at)
     values ($1, 'Second clinic hours', 'Open 9am', now()) returning announcement_id`,
    [adminBId],
  )
  const draftBId = await one(
    `insert into public.announcement (admin_id, announcement_title, announcement_content)
     values ($1, 'Second clinic draft', 'Not yet') returning announcement_id`,
    [adminBId],
  )
  const reportBId = await one(
    `insert into public.report (user_id, report_type) values ($1, 'system_wide') returning report_id`,
    [adminBUserId],
  )
  await database.asService(
    `insert into public.report (pat_id, user_id, report_type) values ($1, $2, 'patient_recovery')`,
    [dana.patId, doctorD.userId],
  )

  return {
    clinicA,
    clinicB,
    adminBUserId,
    adminBId,
    doctorDUserId: doctorD.userId,
    doctorDId: doctorD.docId,
    doctorEUserId: doctorE.userId,
    doctorEId: doctorE.docId,
    danaUserId: dana.userId,
    danaPatId: dana.patId,
    erinUserId: erin.userId,
    erinPatId: erin.patId,
    publishedBId,
    draftBId,
    reportBId,
  }
}

describe('a Clinic Admin works within their own clinic', () => {
  let database: TestDatabase
  let fx: Fixture
  let b: ClinicB

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    await database.asService(
      `insert into public.report (user_id, report_type) values ($1, 'system_wide')`,
      [fx.adminUserId],
    )
    await database.asService(
      `insert into public.chat_session (pat_id, chat_session_summary) values ($1, 'Asked about rest')`,
      [fx.bobPatId],
    )
    b = await seedSecondClinic(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const ids = async <T extends string>(userId: string, sql: string, column: T, params: unknown[] = []) =>
    (await database.asUser<Record<T, string>>(userId, sql, params)).map((row) => row[column]).sort()

  describe('accounts (D5: emails within the clinic)', () => {
    it('lists only the accounts of the administrator’s own clinic', async () => {
      const clinicAAccounts = [
        fx.adminUserId, fx.doctorAUserId, fx.doctorBUserId, fx.doctorCUserId,
        fx.aliceUserId, fx.bobUserId, fx.carolUserId, fx.daveUserId,
      ].sort()
      expect(await ids(fx.adminUserId, 'select user_id from public.user_account', 'user_id')).toEqual(clinicAAccounts)

      expect(await ids(b.adminBUserId, 'select user_id from public.user_account', 'user_id')).toEqual(
        [b.adminBUserId, b.doctorDUserId, b.doctorEUserId, b.danaUserId, b.erinUserId].sort(),
      )
    })

    it('still lets a doctor see only their own patients’ accounts', async () => {
      expect(await ids(b.doctorDUserId, 'select user_id from public.user_account', 'user_id')).toEqual(
        [b.doctorDUserId, b.danaUserId].sort(),
      )
    })
  })

  describe('doctors', () => {
    it('lists only the clinic’s own doctors', async () => {
      expect(await ids(fx.adminUserId, 'select doc_id from public.doctor', 'doc_id')).toEqual(
        [fx.doctorAId, fx.doctorBId, fx.doctorCId].sort(),
      )
      expect(await ids(b.adminBUserId, 'select doc_id from public.doctor', 'doc_id')).toEqual(
        [b.doctorDId, b.doctorEId].sort(),
      )
    })

    it('cannot deactivate, reactivate or edit another clinic’s doctor', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          'update public.doctor set doc_is_active = false where doc_id = $1 returning doc_id',
          [b.doctorDId],
        ),
      )
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          'update public.doctor set doc_is_active = true where doc_id = $1 returning doc_id',
          [b.doctorEId],
        ),
      )
      expect(
        await database.asService('select doc_is_active as active from public.doctor where doc_id = $1', [b.doctorDId]),
      ).toEqual([{ active: true }])
    })

    it('still deactivates and reactivates its own doctor', async () => {
      for (const active of [false, true]) {
        expect(
          await database.asUser(
            fx.adminUserId,
            'update public.doctor set doc_is_active = $2 where doc_id = $1 returning doc_id',
            [fx.doctorBId, active],
          ),
        ).toHaveLength(1)
      }
    })

    it('moves no doctor or administrator to another clinic, whoever asks', async () => {
      for (const write of [database.asService]) {
        await expect(
          write('update public.doctor set clinic_id = $2 where doc_id = $1', [fx.doctorAId, b.clinicB]),
        ).rejects.toMatchObject({ ...REFUSED, message: 'A doctor cannot be moved to another clinic' })
        await expect(
          write('update public.admin set clinic_id = $2 where admin_id = $1', [fx.adminId, b.clinicB]),
        ).rejects.toMatchObject({ ...REFUSED, message: 'An admin cannot be moved to another clinic' })
      }
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          'update public.doctor set clinic_id = $2 where doc_id = $1 returning doc_id',
          [fx.doctorAId, b.clinicB],
        ),
      )
    })

    it('requires every Clinic Admin to belong to a clinic', async () => {
      const userId = await account(database, 'admin.none@second.test', 'admin')
      await expect(
        database.asService(
          `insert into public.admin (user_id, admin_first_name, admin_last_name) values ($1, 'No', 'Clinic')`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: '23502', message: 'A Clinic Admin must belong to a clinic' })
    })
  })

  describe('patients', () => {
    it('cannot be handed to a doctor in another clinic, even by their own doctor', async () => {
      await expect(
        database.asUser(fx.doctorAUserId, 'update public.patient set doc_id = $2 where pat_id = $1', [
          fx.bobPatId,
          b.doctorDId,
        ]),
      ).rejects.toMatchObject({ ...REFUSED, message: 'A patient can only be moved to a doctor in the same clinic' })
      expect(
        await database.asService('select doc_id from public.patient where pat_id = $1', [fx.bobPatId]),
      ).toEqual([{ doc_id: fx.doctorAId }])
    })

    it('are still readable by no administrator', async () => {
      for (const admin of [fx.adminUserId, b.adminBUserId]) {
        expect(await database.asUser(admin, 'select pat_id from public.patient')).toEqual([])
      }
    })
  })

  describe('announcements', () => {
    it('reach the members of their own clinic only', async () => {
      const titles = (userId: string) =>
        ids(userId, 'select announcement_title from public.announcement', 'announcement_title')
      expect(await titles(fx.aliceUserId)).toEqual(['Clinic hours'])
      expect(await titles(fx.doctorAUserId)).toEqual(['Clinic hours'])
      expect(await titles(b.danaUserId)).toEqual(['Second clinic hours'])
      // Drafts, to their clinic's administrator only.
      expect(await titles(fx.adminUserId)).toEqual(['Clinic hours', 'Unreleased policy'])
      expect(await titles(b.adminBUserId)).toEqual(['Second clinic draft', 'Second clinic hours'])
    })

    it('are filed under the author’s clinic, whatever the request says', async () => {
      const [created] = await database.asUser<{ clinic_id: string }>(
        fx.adminUserId,
        `insert into public.announcement (admin_id, announcement_title, announcement_content, clinic_id)
         values ($1, 'Addressed elsewhere', 'Should stay home', $2) returning clinic_id`,
        [fx.adminId, b.clinicB],
      )
      expect(created!.clinic_id).toBe(b.clinicA)
    })

    it('cannot be edited, deleted or moved across clinics', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          `update public.announcement set announcement_title = 'Hijacked' where announcement_id = $1 returning announcement_id`,
          [b.publishedBId],
        ),
      )
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          'delete from public.announcement where announcement_id = $1 returning announcement_id',
          [b.draftBId],
        ),
      )
      // Refused before the policy is even asked: from migration 31 an
      // announcement keeps its clinic and author (clinic-settings.test.ts).
      await expect(
        database.asUser(
          fx.adminUserId,
          'update public.announcement set clinic_id = $2 where announcement_id = $1',
          [fx.publishedAnnouncementId, b.clinicB],
        ),
      ).rejects.toThrow(/keeps the author and clinic/)
      expect(
        await database.asService(
          'select count(*)::int as n from public.announcement where announcement_id in ($1, $2)',
          [b.publishedBId, b.draftBId],
        ),
      ).toEqual([{ n: 2 }])
    })
  })

  describe('reports', () => {
    it('shows each administrator only their clinic’s system-wide reports', async () => {
      const reportsOf = (userId: string) =>
        database.asUser<{ clinic_id: string }>(userId, `select clinic_id from public.report where report_type = 'system_wide'`)
      expect((await reportsOf(fx.adminUserId)).every((r) => r.clinic_id === b.clinicA)).toBe(true)
      expect(await reportsOf(fx.adminUserId)).not.toHaveLength(0)
      expect(await ids(b.adminBUserId, `select report_id from public.report where report_type = 'system_wide'`, 'report_id')).toEqual([
        b.reportBId,
      ])
    })

    it('files a new report under its clinic, whatever the request says', async () => {
      const [report] = await database.asUser<{ clinic_id: string }>(
        fx.adminUserId,
        `insert into public.report (user_id, report_type, clinic_id) values ($1, 'system_wide', $2)
         returning clinic_id`,
        [fx.adminUserId, b.clinicB],
      )
      expect(report!.clinic_id).toBe(b.clinicA)

      const [patientReport] = await database.asService<{ clinic_id: string }>(
        `select clinic_id from public.report where pat_id = $1`,
        [b.danaPatId],
      )
      expect(patientReport!.clinic_id).toBe(b.clinicB)
    })
  })

  describe('the audit log', () => {
    it('shows each administrator their own clinic’s entries and no platform entry', async () => {
      for (const [admin, clinic, otherPeople] of [
        [fx.adminUserId, b.clinicA, [b.danaPatId, b.doctorDId, b.adminBUserId]],
        [b.adminBUserId, b.clinicB, [fx.alicePatId, fx.doctorAId, fx.adminUserId]],
      ] as const) {
        const entries = await database.asUser<{ clinic: string | null; scope: string; entity_id: string }>(
          admin,
          `select clinic_id as clinic, audit_scope::text as scope, audit_log_entity_id as entity_id
             from public.audit_log`,
        )
        expect(entries.length).toBeGreaterThan(0)
        expect(entries.filter((e) => e.scope === 'platform')).toEqual([])
        expect(entries.filter((e) => e.clinic !== null && e.clinic !== clinic)).toEqual([])
        expect(entries.filter((e) => (otherPeople as readonly string[]).includes(e.entity_id))).toEqual([])
      }
    })

    it('still shows an account’s entry once its profile exists, as create-account writes them', async () => {
      // The account is written a moment before its profile, so its entry
      // cannot know the clinic yet. It is resolved as it is read.
      const userId = await account(database, 'late.profile@harborview.test', 'doctor')
      await database.asService(
        `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
         values ($1, 'Late', 'Profile', 'LIC-A-LATE', $2)`,
        [userId, b.clinicA],
      )
      const seen = (admin: string) =>
        database.asUser(
          admin,
          `select audit_log_id from public.audit_log
            where audit_log_entity = 'user_account' and audit_log_entity_id = $1`,
          [userId],
        )
      expect(await seen(fx.adminUserId)).toHaveLength(1)
      expect(await seen(b.adminBUserId)).toEqual([])
    })

    it('scopes each entry by what it is about, whoever writes it and whatever they ask for', async () => {
      // The Edge Functions' entries, through the service role - one of them
      // asking for a scope it must not get.
      await database.asService(
        `insert into public.audit_log
           (user_id, audit_log_action, audit_log_entity, audit_log_entity_id, audit_log_details, audit_scope)
         values ($1, 'create', 'doctor_account', $2, '{}', null),
                ($3, 'create', 'patient_account', $4, '{}', 'platform'),
                ($5, 'update', 'account_password', $5, '{}', null),
                ($6, 'update', 'account_password', $6, '{}', null),
                ($1, 'update', 'something_new', null, '{}', 'platform')`,
        [fx.adminUserId, fx.doctorBId, fx.doctorAUserId, fx.bobPatId, fx.aliceUserId, fx.doctorBUserId],
      )
      const scoped = await database.asService<{ entity: string; entity_id: string | null; scope: string; clinic: string }>(
        `select audit_log_entity as entity, audit_log_entity_id as entity_id,
                audit_scope::text as scope, clinic_id as clinic
           from public.audit_log
          where audit_log_entity in ('doctor_account', 'patient_account', 'account_password', 'something_new')
            and audit_log_details = '{}'::jsonb`,
      )
      const scopeOf = (entity: string, entityId: string | null) =>
        scoped.find((row) => row.entity === entity && row.entity_id === entityId)
      expect(scopeOf('doctor_account', fx.doctorBId)).toMatchObject({ scope: 'administration', clinic: b.clinicA })
      expect(scopeOf('patient_account', fx.bobPatId)).toMatchObject({ scope: 'clinical', clinic: b.clinicA })
      expect(scopeOf('account_password', fx.aliceUserId)).toMatchObject({ scope: 'clinical' })
      expect(scopeOf('account_password', fx.doctorBUserId)).toMatchObject({ scope: 'administration' })
      // Unknown: the most restricted scope, in the actor's clinic.
      expect(scopeOf('something_new', null)).toMatchObject({ scope: 'clinical', clinic: b.clinicA })

      // And the triggers' own entries.
      const triggerScopes = await database.asService<{ entity: string; scopes: string[] }>(
        `select audit_log_entity as entity, array_agg(distinct audit_scope::text order by audit_scope::text) as scopes
           from public.audit_log
          where audit_log_entity in ('clinic', 'doctor', 'announcement', 'patient', 'prescription', 'treatment_plan')
          group by audit_log_entity order by 1`,
      )
      expect(triggerScopes).toEqual([
        { entity: 'announcement', scopes: ['administration'] },
        { entity: 'clinic', scopes: ['platform'] },
        { entity: 'doctor', scopes: ['administration'] },
        { entity: 'patient', scopes: ['clinical'] },
        { entity: 'prescription', scopes: ['clinical'] },
        { entity: 'treatment_plan', scopes: ['clinical'] },
      ])
    })

    it('makes only clinics platform entries, and puts no person in them', async () => {
      await database.asService(`update public.clinic set clinic_status = 'inactive' where clinic_id = $1`, [b.clinicB])
      await database.asService(`update public.clinic set clinic_status = 'active' where clinic_id = $1`, [b.clinicB])
      const platform = await database.asService<{ entity: string; details: unknown }>(
        `select audit_log_entity as entity, audit_log_details as details
           from public.audit_log where audit_scope = 'platform'`,
      )
      expect(new Set(platform.map((row) => row.entity))).toEqual(new Set(['clinic']))
      const serialised = JSON.stringify(platform)
      for (const person of [
        fx.alicePatId, fx.aliceUserId, b.danaPatId, b.danaUserId, fx.doctorAId, b.doctorDId,
        'alice@recoverease.test', 'dana@second.test', 'Alice', 'Dana',
      ]) {
        expect(serialised).not.toContain(person)
      }
    })

    it('has no audit trigger on chat, doses, recovery logs or appointments', async () => {
      const audited = await database.asService<{ table: string }>(
        `select distinct c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and t.tgfoid = 'public.audit_row_change'::regproc
            and c.relname in ('chat_session', 'chat_message', 'medication_log', 'recovery_log',
                              'appointment', 'reschedule_request')`,
      )
      expect(audited).toEqual([])
    })
  })

  describe('dashboard and usage counts', () => {
    it('count the caller’s clinic only', async () => {
      const stats = async (admin: string) =>
        (await database.asUser<{ s: Record<string, unknown> }>(admin, 'select public.admin_dashboard_stats() as s'))[0]!.s
      expect(await stats(fx.adminUserId)).toMatchObject({
        patients: { total: 4 },
        doctors: { total: 4, active: 3 },
        accounts: { admin: 1, doctor: 4, patient: 4 },
      })
      expect(await stats(b.adminBUserId)).toMatchObject({
        patients: { total: 2 },
        doctors: { total: 2, active: 1 },
        accounts: { admin: 1, doctor: 2, patient: 2 },
      })

      const usage = async (admin: string) =>
        (await database.asUser<{ u: { sessions: number } }>(admin, 'select public.admin_chatbot_usage(30) as u'))[0]!.u
      expect((await usage(fx.adminUserId)).sessions).toBe(2)
      expect((await usage(b.adminBUserId)).sessions).toBe(1)
    })

    it('are still refused to anyone but a Clinic Admin', async () => {
      for (const userId of [b.doctorDUserId, b.danaUserId]) {
        await expect(database.asUser(userId, 'select public.admin_dashboard_stats()')).rejects.toThrow(
          /Administrator privileges/,
        )
        await expect(database.asUser(userId, 'select public.admin_chatbot_usage(30)')).rejects.toThrow(
          /Administrator privileges/,
        )
      }
    })
  })

  describe('settings', () => {
    it('are each clinic’s own (migration 31), and doctors and patients still have no access at all', async () => {
      // The full rules are in clinic-settings.test.ts; here, that the second
      // clinic's administrator does not see the first clinic's.
      await database.asUser(
        fx.adminUserId,
        `insert into public.system_setting (system_setting_key, system_setting_value)
         values ('chatbot.system_prompt', 'Harborview guidance')`,
      )
      expect(
        await database.asUser(b.adminBUserId, 'select system_setting_key from public.system_setting'),
      ).toEqual([])

      for (const userId of [b.doctorDUserId, b.danaUserId, fx.doctorAUserId]) {
        expect(await database.asUser(userId, 'select system_setting_id from public.system_setting')).toEqual([])
        await expect(
          database.asUser(
            userId,
            `insert into public.system_setting (system_setting_key, system_setting_value) values ('x', 'y')`,
          ),
        ).rejects.toThrow(/row-level security/)
      }
    })
  })
})

describe('D8: moving a deactivated doctor’s patients', () => {
  let database: TestDatabase
  let fx: Fixture
  let b: ClinicB
  let davePrescriptionId: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    // History written by the doctor before they were deactivated.
    const [rx] = await database.asService<{ id: string }>(
      `insert into public.prescription (pat_id, doc_id, prescription_notes)
       values ($1, $2, 'Written before deactivation') returning prescription_id as id`,
      [fx.davePatId, fx.doctorCId],
    )
    davePrescriptionId = rx!.id
    b = await seedSecondClinic(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const count = (userId: string, docId: string) =>
    database.asUser<{ n: number }>(userId, 'select public.admin_doctor_patient_count($1) as n', [docId])
  const reassign = (userId: string, from: string, to: string, expected: number) =>
    database.asUser<{ n: number }>(
      userId,
      'select public.admin_reassign_doctor_patients($1, $2, $3) as n',
      [from, to, expected],
    )

  it('tells the Clinic Admin how many patients, and nothing else', async () => {
    expect(await count(fx.adminUserId, fx.doctorCId)).toEqual([{ n: 1 }])
    expect(await count(b.adminBUserId, b.doctorEId)).toEqual([{ n: 1 }])
  })

  it('counts only a deactivated doctor in the caller’s own clinic', async () => {
    await expect(count(fx.adminUserId, fx.doctorAId)).rejects.toThrow(/Only a deactivated doctor/)
    // Another clinic's doctor is indistinguishable from one that does not exist.
    await expect(count(fx.adminUserId, b.doctorEId)).rejects.toThrow('That doctor account could not be found')
    await expect(
      database.asUser(fx.adminUserId, 'select public.admin_doctor_appointment_count($1)', [b.doctorEId]),
    ).rejects.toThrow('That doctor account could not be found')
    await expect(count(fx.adminUserId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'That doctor account could not be found',
    )
  })

  it('is refused to doctors, patients and anonymous callers', async () => {
    for (const userId of [fx.doctorAUserId, fx.daveUserId]) {
      await expect(count(userId, fx.doctorCId)).rejects.toThrow(/Administrator privileges/)
      await expect(reassign(userId, fx.doctorCId, fx.doctorAId, 1)).rejects.toThrow(/Administrator privileges/)
    }
    await expect(
      database.asAnon('select public.admin_doctor_patient_count($1)', [fx.doctorCId]),
    ).rejects.toThrow(/permission denied/)
    await expect(
      database.asAnon('select public.admin_reassign_doctor_patients($1, $2, 1)', [fx.doctorCId, fx.doctorAId]),
    ).rejects.toThrow(/permission denied/)
  })

  it('moves patients only to an active doctor in the same clinic', async () => {
    // Another clinic's active doctor.
    await expect(reassign(fx.adminUserId, fx.doctorCId, b.doctorDId, 1)).rejects.toThrow(
      'That doctor account could not be found',
    )
    // Another clinic's deactivated doctor, as the source.
    await expect(reassign(fx.adminUserId, b.doctorEId, fx.doctorAId, 1)).rejects.toThrow(
      'That doctor account could not be found',
    )
    // The same doctor.
    await expect(reassign(fx.adminUserId, fx.doctorCId, fx.doctorCId, 1)).rejects.toThrow(/different doctor/)
    // A deactivated doctor in the same clinic. Only an administrator's
    // session may switch that flag (migration 08's doctor guard).
    const setActive = (active: boolean) =>
      database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = $2 where doc_id = $1', [
        fx.doctorBId,
        active,
      ])
    await setActive(false)
    try {
      await expect(reassign(fx.adminUserId, fx.doctorCId, fx.doctorBId, 1)).rejects.toThrow(/active doctor/)
    } finally {
      await setActive(true)
    }
    // An active doctor's patients stay where they are.
    await expect(reassign(fx.adminUserId, fx.doctorAId, fx.doctorBId, 2)).rejects.toThrow(/Only a deactivated doctor/)

    expect(
      await database.asService('select doc_id from public.patient where pat_id = $1', [fx.davePatId]),
    ).toEqual([{ doc_id: fx.doctorCId }])
  })

  it('moves nothing if the count is not the one the administrator confirmed', async () => {
    await expect(reassign(fx.adminUserId, fx.doctorCId, fx.doctorAId, 2)).rejects.toThrow(
      /number of patients has changed/,
    )
    expect(
      await database.asService('select doc_id from public.patient where pat_id = $1', [fx.davePatId]),
    ).toEqual([{ doc_id: fx.doctorCId }])
  })

  it('moves every patient, audits it without naming them, and keeps who wrote what', async () => {
    expect(await reassign(fx.adminUserId, fx.doctorCId, fx.doctorAId, 1)).toEqual([{ n: 1 }])

    expect(
      await database.asService('select doc_id from public.patient where pat_id = $1', [fx.davePatId]),
    ).toEqual([{ doc_id: fx.doctorAId }])
    // Authorship is history: the prescription is still doctor C's.
    expect(
      await database.asService('select doc_id from public.prescription where prescription_id = $1', [
        davePrescriptionId,
      ]),
    ).toEqual([{ doc_id: fx.doctorCId }])
    // The new doctor can now look after Dave; the old one, deactivated, cannot.
    expect(await database.asUser(fx.doctorAUserId, 'select pat_id from public.patient where pat_id = $1', [fx.davePatId])).toHaveLength(1)

    const [move] = await database.asService<{
      actor: string
      scope: string
      clinic: string
      details: Record<string, unknown>
    }>(
      `select user_id as actor, audit_scope::text as scope, clinic_id as clinic, audit_log_details as details
         from public.audit_log where audit_log_entity = 'doctor_patients' and audit_log_action = 'reassign'`,
    )
    expect(move).toEqual({
      actor: fx.adminUserId,
      scope: 'administration',
      clinic: b.clinicA,
      details: { from_doc_id: fx.doctorCId, to_doc_id: fx.doctorAId, patient_count: 1, appointment_count: 0 },
    })

    // Each patient's own entry records that the doctor changed, not to whom.
    const [patientEntry] = await database.asService<{ scope: string; details: unknown }>(
      `select audit_scope::text as scope, audit_log_details as details from public.audit_log
        where audit_log_entity = 'patient' and audit_log_entity_id = $1 and audit_log_action = 'update'
        order by audit_log_timestamp desc limit 1`,
      [fx.davePatId],
    )
    expect(patientEntry).toEqual({ scope: 'clinical', details: { changed_columns: ['doc_id'] } })

    // The other clinic's administrator sees none of it.
    expect(
      await database.asUser(
        b.adminBUserId,
        `select audit_log_id from public.audit_log
          where audit_log_entity in ('doctor_patients', 'patient') and audit_log_entity_id in ($1, $2)`,
        [fx.doctorCId, fx.davePatId],
      ),
    ).toEqual([])
  })

  it('has nothing left to move afterwards', async () => {
    expect(await count(fx.adminUserId, fx.doctorCId)).toEqual([{ n: 0 }])
    await expect(reassign(fx.adminUserId, fx.doctorCId, fx.doctorAId, 0)).rejects.toThrow(/no patients to reassign/)
  })
})
