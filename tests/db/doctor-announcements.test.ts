import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, type Claims } from './helpers/super-admin'

/**
 * Migration 36: a doctor writes announcements for their own patients.
 *
 * Called as the Data API would call them, as each role: a doctor writes only
 * as themselves, while active, into their own clinic, and manages only their
 * own announcements - never a Clinic Admin's, another doctor's, another
 * clinic's or a platform one. Once published, a doctor's announcement reaches
 * the patients assigned to them now, while they are active - not their
 * colleagues, not another doctor's patients, no one in another clinic. Clinic
 * Admins keep the access they had to their clinic's announcements, and
 * platform and Clinic Admin announcements reach whom they reached before.
 *
 * The fixture's assignments: doctor A has Alice and Bob, doctor B has Carol,
 * and doctor C, deactivated, has Dave.
 */

const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const ROLLBACK_36 = 'supabase/rollbacks/20260902100036_doctor_announcements.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** What a doctor's own page sends to post: their id, a title, a message. */
const post = (database: TestDatabase, userId: string, docId: string, title: string, published: boolean) =>
  database.asUser<{ id: string; clinic: string; admin: string | null; superAdmin: string | null }>(
    userId,
    `insert into public.announcement (doc_id, announcement_title, announcement_content, announcement_published_at)
     values ($1, $2, 'Written by a doctor', ${published ? 'now()' : 'null'})
     returning announcement_id as id, clinic_id as clinic, admin_id as admin, super_admin_id as "superAdmin"`,
    [docId, title],
  )

/** The ids a caller can read. */
const visible = async (database: TestDatabase, userId: string) =>
  (
    await database.asUser<{ id: string }>(userId, 'select announcement_id as id from public.announcement')
  ).map((row) => row.id)

describe('a doctor’s announcements', () => {
  let database: TestDatabase
  let fx: Fixture
  let superAdmin: { claims: Claims }
  let clinicA: string
  let clinicB: string
  let doctorDUserId: string
  let doctorDId: string
  let adminBUserId: string
  let danaUserId: string
  let platformId: string
  let clinicBPublishedId: string
  let doctorBPublishedId: string
  let doctorBDraftId: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    clinicA = await one<string>(database, 'select clinic_id from public.clinic')

    // A second clinic with its own Clinic Admin, doctor and patient.
    await liftSingleClinicGate(database)
    clinicB = await one<string>(
      database,
      `insert into public.clinic (clinic_name, clinic_timezone) values ('Second Clinic', 'Asia/Tokyo') returning clinic_id`,
    )
    const account = async (email: string, role: 'patient' | 'doctor' | 'admin') => {
      const id = await one<string>(database, 'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id', [email])
      await database.asService('insert into public.user_account (user_id, user_email, user_role) values ($1, $2, $3)', [id, email, role])
      return id
    }
    adminBUserId = await account('admin.b@second.test', 'admin')
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id) values ($1, 'Bianca', 'Ortiz', $2)`,
      [adminBUserId, clinicB],
    )
    doctorDUserId = await account('doctor.d@second.test', 'doctor')
    doctorDId = await one<string>(
      database,
      `insert into public.doctor (user_id, doc_first_name, doc_last_name, doc_license_no, clinic_id)
       values ($1, 'Dara', 'Tan', 'LIC-B-D', $2) returning doc_id`,
      [doctorDUserId, clinicB],
    )
    danaUserId = await account('dana@second.test', 'patient')
    await database.asService(
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at) values ($1, $2, 'Dana', 'Mendoza', now())`,
      [danaUserId, doctorDId],
    )

    const [{ id: platform }] = await database.asClaims<{ id: string }>(
      superAdmin.claims,
      `select public.super_admin_create_announcement('Planned maintenance', 'RecoverEase', true) as id`,
    )
    platformId = platform
    clinicBPublishedId = (await post(database, doctorDUserId, doctorDId, 'Second clinic notice', true))[0]!.id
    doctorBPublishedId = (await post(database, fx.doctorBUserId, fx.doctorBId, 'Doctor B notice', true))[0]!.id
    doctorBDraftId = (await post(database, fx.doctorBUserId, fx.doctorBId, 'Doctor B draft', false))[0]!.id
  })

  afterAll(async () => {
    await database?.close()
  })

  it('are written by an active doctor for their own clinic, published or as a draft', async () => {
    const [published] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Clinic hours changed', true)
    const [draft] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Holiday hours', false)

    expect(published).toMatchObject({ clinic: clinicA, admin: null, superAdmin: null })
    expect(draft).toMatchObject({ clinic: clinicA, admin: null, superAdmin: null })
  })

  it('take the doctor’s clinic, whatever the request says', async () => {
    const [row] = await database.asUser<{ clinic: string }>(
      fx.doctorAUserId,
      `insert into public.announcement (doc_id, clinic_id, announcement_title, announcement_content)
       values ($1, $2, 'Addressed elsewhere', 'Lands at home') returning clinic_id as clinic`,
      [fx.doctorAId, clinicB],
    )
    expect(row!.clinic).toBe(clinicA)
  })

  it('cannot be written as anyone else, by a deactivated doctor, or as a platform announcement', async () => {
    const insert = (userId: string, columns: string, values: string, params: unknown[]) =>
      database.asUser(
        userId,
        `insert into public.announcement (${columns}, announcement_title, announcement_content) values (${values}, 'Forged', 'Forged')`,
        params,
      )
    const counts = () => database.asService('select count(*)::int as n from public.announcement')
    const before = await counts()

    // As another doctor, as the Clinic Admin, or as the Super Admin.
    await expect(insert(fx.doctorAUserId, 'doc_id', '$1', [fx.doctorBId])).rejects.toThrow(/row-level security/)
    await expect(insert(fx.doctorAUserId, 'admin_id', '$1', [fx.adminId])).rejects.toThrow(/row-level security/)
    await expect(
      insert(fx.doctorAUserId, 'super_admin_id', '(select super_admin_id from public.super_admin limit 1)', []),
    ).rejects.toThrow()
    // Two authors, or none.
    await expect(insert(fx.doctorAUserId, 'doc_id, admin_id', '$1, $2', [fx.doctorAId, fx.adminId])).rejects.toThrow()
    await expect(
      database.asUser(fx.doctorAUserId, `insert into public.announcement (announcement_title, announcement_content) values ('No one', 'No one')`),
    ).rejects.toThrow()
    // A deactivated doctor writes nothing, even as themselves.
    await expect(insert(fx.doctorCUserId, 'doc_id', '$1', [fx.doctorCId])).rejects.toThrow(/row-level security/)
    // A patient writes nothing.
    await expect(insert(fx.aliceUserId, 'doc_id', '$1', [fx.doctorAId])).rejects.toThrow(/row-level security/)

    expect(await counts()).toEqual(before)
  })

  it('are published, withdrawn, edited and deleted by their own doctor', async () => {
    const [mine] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Mine to manage', false)

    expect(
      await database.asUser(fx.doctorAUserId, `update public.announcement set announcement_published_at = now() where announcement_id = $1 returning 1`, [mine!.id]),
    ).toHaveLength(1)
    expect(
      await database.asUser(fx.doctorAUserId, `update public.announcement set announcement_published_at = null, announcement_title = 'Edited' where announcement_id = $1 returning 1`, [mine!.id]),
    ).toHaveLength(1)
    expect(
      await database.asUser(fx.doctorAUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [mine!.id]),
    ).toHaveLength(1)
  })

  it('never let a doctor change or delete anyone else’s - the Clinic Admin’s, another doctor’s, another clinic’s or a platform one', async () => {
    for (const id of [fx.publishedAnnouncementId, fx.draftAnnouncementId, doctorBPublishedId, doctorBDraftId, clinicBPublishedId, platformId]) {
      await expectDenied(() =>
        database.asUser(fx.doctorAUserId, `update public.announcement set announcement_title = 'Hijacked' where announcement_id = $1 returning 1`, [id]),
      )
      await expectDenied(() =>
        database.asUser(fx.doctorAUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [id]),
      )
    }
    expect(
      await database.asService(`select count(*)::int as n from public.announcement where announcement_title = 'Hijacked'`),
    ).toEqual([{ n: 0 }])
  })

  it('keep who wrote them and whose clinic they are', async () => {
    const [mine] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Fixed author', true)
    const update = (set: string, params: unknown[]) =>
      database.asUser(fx.doctorAUserId, `update public.announcement set ${set} where announcement_id = $1`, [mine!.id, ...params])

    await expect(update('doc_id = $2', [fx.doctorBId])).rejects.toMatchObject({ code: '42501' })
    await expect(update('clinic_id = $2', [clinicB])).rejects.toMatchObject({ code: '42501' })
    await expect(update('doc_id = null, admin_id = $2', [fx.adminId])).rejects.toMatchObject({ code: '42501' })
    // Nor can the Clinic Admin, who may otherwise manage it, hand it to
    // another doctor.
    await expect(
      database.asUser(fx.adminUserId, 'update public.announcement set doc_id = $2 where announcement_id = $1', [mine!.id, fx.doctorBId]),
    ).rejects.toMatchObject({ code: '42501' })
    expect(
      await database.asService('select doc_id as doc, clinic_id as clinic from public.announcement where announcement_id = $1', [mine!.id]),
    ).toEqual([{ doc: fx.doctorAId, clinic: clinicA }])
  })

  it('show a doctor RecoverEase’s, their Clinic Admin’s and their own, drafts included - never a colleague’s, nothing of another clinic', async () => {
    const [draft] = await post(database, fx.doctorAUserId, fx.doctorAId, 'My draft', false)
    const seen = await visible(database, fx.doctorAUserId)

    expect(seen).toEqual(expect.arrayContaining([platformId, fx.publishedAnnouncementId, draft!.id]))
    for (const hidden of [fx.draftAnnouncementId, doctorBPublishedId, doctorBDraftId, clinicBPublishedId]) {
      expect(seen).not.toContain(hidden)
    }

    // The colleague does not see this doctor's either.
    expect(await visible(database, fx.doctorBUserId)).not.toContain(draft!.id)

    const otherClinic = await visible(database, doctorDUserId)
    expect(otherClinic).toEqual(expect.arrayContaining([platformId, clinicBPublishedId]))
    for (const hidden of [fx.publishedAnnouncementId, doctorBPublishedId, draft!.id]) expect(otherClinic).not.toContain(hidden)
  })

  it('reach only the author’s assigned patients once published - not another doctor’s patients, not another clinic', async () => {
    const carol = await visible(database, fx.carolUserId)
    expect(carol).toContain(doctorBPublishedId)
    expect(carol).not.toContain(doctorBDraftId)

    for (const unassigned of [fx.aliceUserId, fx.bobUserId, fx.daveUserId, danaUserId]) {
      const seen = await visible(database, unassigned)
      expect(seen).not.toContain(doctorBPublishedId)
      expect(seen).not.toContain(doctorBDraftId)
    }

    const dana = await visible(database, danaUserId)
    expect(dana).toContain(clinicBPublishedId)
    expect(await visible(database, fx.carolUserId)).not.toContain(clinicBPublishedId)
  })

  it('follow the patient’s current assignment: a moved patient sees their new doctor’s, and no longer the old one’s', async () => {
    const [doctorAs] = await post(database, fx.doctorAUserId, fx.doctorAId, 'For doctor A’s patients', true)
    expect(await visible(database, fx.carolUserId)).not.toContain(doctorAs!.id)

    await database.asService('update public.patient set doc_id = $1 where pat_id = $2', [fx.doctorAId, fx.carolPatId])
    try {
      const carol = await visible(database, fx.carolUserId)
      expect(carol).toContain(doctorAs!.id)
      expect(carol).not.toContain(doctorBPublishedId)
    } finally {
      await database.asService('update public.patient set doc_id = $1 where pat_id = $2', [fx.doctorBId, fx.carolPatId])
    }
    expect(await visible(database, fx.carolUserId)).toContain(doctorBPublishedId)
  })

  it('leave the feeds of a deactivated doctor’s patients at once, before they are moved - and stay the Clinic Admin’s to see', async () => {
    // Deactivated the way a Clinic Admin does it (module 11.3); Carol is
    // still assigned to doctor B.
    const setActive = (active: boolean) =>
      database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = $1 where doc_id = $2', [active, fx.doctorBId])
    await setActive(false)
    try {
      expect(await visible(database, fx.carolUserId)).not.toContain(doctorBPublishedId)
      expect(await visible(database, fx.adminUserId)).toContain(doctorBPublishedId)
    } finally {
      await setActive(true)
    }
    expect(await visible(database, fx.carolUserId)).toContain(doctorBPublishedId)

    // Doctor C was deactivated before writing anything; one of theirs, put
    // there by the owner, still reaches neither Dave nor anyone else.
    const inactiveId = await one<string>(
      database,
      `insert into public.announcement (doc_id, announcement_title, announcement_content, announcement_published_at)
       values ($1, 'From an inactive doctor', 'Hidden', now()) returning announcement_id`,
      [fx.doctorCId],
    )
    for (const patient of [fx.daveUserId, fx.aliceUserId, fx.carolUserId]) {
      expect(await visible(database, patient)).not.toContain(inactiveId)
    }
    expect(await visible(database, fx.adminUserId)).toContain(inactiveId)
    await database.asService('delete from public.announcement where announcement_id = $1', [inactiveId])
  })

  it('leave RecoverEase’s and the Clinic Admin’s announcements reaching whom they reached before', async () => {
    for (const member of [fx.aliceUserId, fx.carolUserId, fx.daveUserId, fx.doctorAUserId, fx.doctorBUserId]) {
      const seen = await visible(database, member)
      expect(seen).toEqual(expect.arrayContaining([platformId, fx.publishedAnnouncementId]))
      expect(seen).not.toContain(fx.draftAnnouncementId)
    }
    const dana = await visible(database, danaUserId)
    expect(dana).toContain(platformId)
    expect(dana).not.toContain(fx.publishedAnnouncementId)
  })

  it('are still their clinic’s for its Clinic Admin to manage, as every clinic announcement is, and nobody else’s', async () => {
    const [mine] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Moderated', true)
    const [draft] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Moderated draft', false)

    // The access a Clinic Admin has to every announcement of their clinic.
    expect(await visible(database, fx.adminUserId)).toEqual(expect.arrayContaining([mine!.id, draft!.id]))
    expect(await visible(database, adminBUserId)).not.toContain(mine!.id)
    await expectDenied(() =>
      database.asUser(adminBUserId, `update public.announcement set announcement_published_at = null where announcement_id = $1 returning 1`, [mine!.id]),
    )
    await expectDenied(() =>
      database.asUser(adminBUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [mine!.id]),
    )

    expect(
      await database.asUser(fx.adminUserId, `update public.announcement set announcement_published_at = null where announcement_id = $1 returning 1`, [mine!.id]),
    ).toHaveLength(1)
    expect(
      await database.asUser(fx.adminUserId, 'delete from public.announcement where announcement_id = $1 returning 1', [draft!.id]),
    ).toHaveLength(1)
  })

  it('are not the Super Admin’s to change: their functions take platform announcements only', async () => {
    await expect(
      database.asClaims(superAdmin.claims, `select public.super_admin_update_announcement($1, 'T', 'C')`, [doctorBPublishedId]),
    ).rejects.toThrow(/platform announcement could not be found/)
    await expect(
      database.asClaims(superAdmin.claims, 'select public.super_admin_delete_announcement($1)', [doctorBPublishedId]),
    ).rejects.toThrow(/platform announcement could not be found/)
    const listed = await database.asClaims<{ announcement_id: string }>(superAdmin.claims, 'select announcement_id from public.super_admin_list_announcements()')
    expect(listed.map((row) => row.announcement_id)).toEqual([platformId])
  })

  it('are audited as their clinic’s administration entries, never as platform ones', async () => {
    const [mine] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Audited', true)
    expect(
      await database.asService(
        `select audit_log_action as action, audit_scope::text as scope, clinic_id as clinic, user_id as actor
           from public.audit_log where audit_log_entity = 'announcement' and audit_log_entity_id = $1`,
        [mine!.id],
      ),
    ).toEqual([{ action: 'insert', scope: 'administration', clinic: clinicA, actor: fx.doctorAUserId }])
  })
})

describe('a doctor’s writes on their own, without the read policy’s help', () => {
  // An UPDATE or DELETE with a WHERE clause must also pass the read policy,
  // which already hides a colleague's announcements. One with no WHERE clause
  // does not, so these show the write policies hold on their own.
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('change and delete only the doctor’s own, even asked for every row', async () => {
    const [mine] = await post(database, fx.doctorAUserId, fx.doctorAId, 'Mine', true)
    const [theirs] = await post(database, fx.doctorBUserId, fx.doctorBId, 'Theirs', true)
    const others = [theirs!.id, fx.publishedAnnouncementId, fx.draftAnnouncementId]
    const titles = () =>
      database.asService<{ id: string; title: string }>(
        'select announcement_id as id, announcement_title as title from public.announcement where announcement_id = any($1) order by 1',
        [others],
      )
    const before = await titles()

    await database.asUser(fx.doctorAUserId, `update public.announcement set announcement_title = 'Every one'`)
    expect(await titles()).toEqual(before)
    expect(await one<string>(database, 'select announcement_title from public.announcement where announcement_id = $1', [mine!.id])).toBe('Every one')

    await database.asUser(fx.doctorAUserId, 'delete from public.announcement')
    expect(await titles()).toEqual(before)
    expect(await database.asService('select 1 from public.announcement where announcement_id = $1', [mine!.id])).toEqual([])
  })
})

describe('migration 36 beside migrations 34 and 35', () => {
  it('refuses to run without migration 33, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: '20260902100032' })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_36)).rejects.toThrow(/needs migration 33 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

  it('goes in after 33 and 35 with 34 still unapplied, as production has them, keeping every row; then the same schema once 34 follows', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: '20260902100033' }),
      createTestDatabase(),
    ])
    try {
      await seedFixture(production)
      await production.applyMigration(MIGRATION_35)
      const rows = () =>
        production.asService(
          `select announcement_id, admin_id, super_admin_id, clinic_id, announcement_title, announcement_published_at
             from public.announcement order by 1`,
        )
      const before = await rows()

      await production.applyMigration(MIGRATION_36)

      expect(await rows()).toEqual(before)
      expect(
        await one<number>(production, `select count(*)::int from pg_indexes where indexname = 'clinic_single_clinic_gate'`),
      ).toBe(1)
      await expect(production.applyMigration(MIGRATION_36)).rejects.toThrow(/already been applied/)

      await production.applyMigration(MIGRATION_34)
      expect(await catalog(production)).toEqual(await catalog(repository))
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})

describe('the down-script for migration 36', () => {
  let used: TestDatabase
  let through35: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    ;[used, through35] = await Promise.all([
      createTestDatabase(),
      createTestDatabase({ stopAfter: MIGRATION_35 }),
    ])
    fx = await seedFixture(used)
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through35?.close()])
  })

  it('refuses, changing nothing, while a doctor’s announcement exists', async () => {
    const [mine] = await post(used, fx.doctorAUserId, fx.doctorAId, 'Keeps the rollback out', true)
    const before = await catalog(used)

    await expect(used.db.exec(await script(ROLLBACK_36))).rejects.toThrow(/Doctors' announcements exist/)
    expect(await catalog(used)).toEqual(before)

    await used.asService('delete from public.announcement where announcement_id = $1', [mine!.id])
  })

  it('returns the schema to exactly what 35 left, keeping every announcement', async () => {
    const rows = () =>
      used.asService(
        `select announcement_id, admin_id, super_admin_id, clinic_id, announcement_title, announcement_published_at
           from public.announcement order by 1`,
      )
    const before = await rows()

    await used.db.exec(await script(ROLLBACK_36))

    expect(await catalog(used)).toEqual(await catalog(through35))
    expect(await rows()).toEqual(before)
  })

  it('refuses where migration 36 is not applied', async () => {
    await expect(through35.db.exec(await script(ROLLBACK_36))).rejects.toThrow(/Migration 36 is not applied/)
  })
})
