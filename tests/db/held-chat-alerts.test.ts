import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CRITICAL_ALERT_MESSAGE } from '../../supabase/functions/_shared/critical-alert'
import { catalog } from './helpers/catalog'
import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * A critical alert waits for a clinician who can open it (migration 38,
 * docs/critical-alert-escalation.md option C).
 *
 * When the patient's doctor is deactivated - decision D8 leaves their
 * patients assigned to them until a Clinic Admin moves them - the alert is
 * held against the conversation, once, and delivered by the database to
 * whichever clinician can open it next: the doctor the patients are moved
 * to, or the same doctor reactivated. The Clinic Admin sees a count against
 * the doctor and nothing else. Only `chatbot-reply` holds an alert, and only
 * the server sets or clears the hold.
 *
 * Fixture: doctor C is deactivated and has one patient, Dave. Doctor A is
 * active and has Alice and Bob.
 */

const MIGRATION_28 = '20260902100028'
const MIGRATION_33 = '20260902100033'
const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'
const MIGRATION_38 = '20260902100038'
const ROLLBACK_38 = 'supabase/rollbacks/20260902100038_held_chat_alerts.down.sql'

const DELIVERED_MESSAGE =
  'A patient raised a concern in the guidance chat while they had no active doctor. It may need your attention.'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

const one = async <T>(database: TestDatabase, sql: string, params: unknown[] = []): Promise<T> =>
  Object.values((await database.asService<Record<string, T>>(sql, params))[0]!)[0]!

/** A flagged conversation for a patient, as chatbot-reply leaves one. */
const flaggedSession = (database: TestDatabase, patId: string) =>
  one<string>(
    database,
    `insert into public.chat_session (pat_id, chat_session_has_critical_flag, chat_session_summary)
     values ($1, true, 'The assistant advised seeking care now.') returning chat_session_id`,
    [patId],
  )

/** What chatbot-reply does with the service key. */
const hold = (database: TestDatabase, sessionId: string) =>
  one<string>(database, 'select public.hold_chat_alert($1)', [sessionId])

const heldSince = (database: TestDatabase, sessionId: string) =>
  one<string | null>(
    database,
    'select chat_session_alert_held_since from public.chat_session where chat_session_id = $1',
    [sessionId],
  )

/** Chat alerts addressed to one account. */
const chatAlerts = (database: TestDatabase, userId: string) =>
  database.asService<{ chat_session_id: string | null; notification_message: string }>(
    `select chat_session_id, notification_message from public.notification
      where user_id = $1 and notification_type = 'chat_critical'
      order by notification_created_at, notification_id`,
    [userId],
  )

const counts = (database: TestDatabase, userId: string) =>
  database.asUser<{ doc_id: string; held_alerts: number }>(
    userId,
    'select * from public.admin_held_chat_alert_counts()',
  )

/** D8's move, as the Clinic Admin makes it: one patient, no appointments. */
const reassign = (database: TestDatabase, fx: Fixture, from: string, to: string) =>
  database.asUser(
    fx.adminUserId,
    'select public.admin_reassign_doctor_patients($1, $2, 1, 0) as moved',
    [from, to],
  )

describe('holding a critical alert', () => {
  let database: TestDatabase
  let fx: Fixture
  let daveSession: string

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    daveSession = await flaggedSession(database, fx.davePatId)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('holds it while the patient’s doctor is deactivated, and sends the deactivated doctor nothing', async () => {
    expect(await hold(database, daveSession)).toBe('held')
    expect(await heldSince(database, daveSession)).not.toBeNull()
    expect(await chatAlerts(database, fx.doctorCUserId)).toEqual([])
  })

  it('holds it once per conversation, however many replies raise a concern', async () => {
    const since = await heldSince(database, daveSession)
    expect(await hold(database, daveSession)).toBe('already_held')
    expect(await hold(database, daveSession)).toBe('already_held')
    expect(await heldSince(database, daveSession)).toEqual(since)
  })

  it('delivers it at once, in chatbot-reply’s words, when the patient’s doctor is active', async () => {
    const aliceSession = await flaggedSession(database, fx.alicePatId)
    const before = (await chatAlerts(database, fx.doctorAUserId)).length

    expect(await hold(database, aliceSession)).toBe('delivered')
    expect(await heldSince(database, aliceSession)).toBeNull()
    expect((await chatAlerts(database, fx.doctorAUserId)).slice(before)).toEqual([
      { chat_session_id: aliceSession, notification_message: CRITICAL_ALERT_MESSAGE },
    ])
  })

  it('refuses a conversation that does not exist', async () => {
    await expect(hold(database, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      /could not be found/,
    )
  })

  it('is chatbot-reply’s alone: refused to the patient, every doctor, the Clinic Admin and an anonymous caller', async () => {
    for (const userId of [fx.daveUserId, fx.doctorAUserId, fx.doctorCUserId, fx.adminUserId]) {
      await expect(
        database.asUser(userId, 'select public.hold_chat_alert($1)', [daveSession]),
      ).rejects.toThrow(/permission denied/)
    }
    await expect(
      database.asAnon('select public.hold_chat_alert($1)', [daveSession]),
    ).rejects.toThrow(/permission denied/)
  })

  it('the patient can neither clear a hold, taking the alert away, nor set one', async () => {
    await expect(
      database.asUser(
        fx.daveUserId,
        `update public.chat_session set chat_session_alert_held_since = null
          where chat_session_id = $1 returning chat_session_id`,
        [daveSession],
      ),
    ).rejects.toThrow(/set by the server and cannot be changed directly/)

    const ownSession = await one<string>(
      database,
      'insert into public.chat_session (pat_id) values ($1) returning chat_session_id',
      [fx.alicePatId],
    )
    await expect(
      database.asUser(
        fx.aliceUserId,
        `update public.chat_session set chat_session_alert_held_since = now()
          where chat_session_id = $1 returning chat_session_id`,
        [ownSession],
      ),
    ).rejects.toThrow(/set by the server and cannot be changed directly/)
    await expect(
      database.asUser(
        fx.aliceUserId,
        `insert into public.chat_session (pat_id, chat_session_alert_held_since)
         values ($1, now()) returning chat_session_id`,
        [fx.alicePatId],
      ),
    ).rejects.toThrow(/set by the server and cannot be changed directly/)

    expect(await heldSince(database, daveSession)).not.toBeNull()
    // Starting a conversation, as the app does, is untouched.
    await expect(
      database.asUser(
        fx.aliceUserId,
        'insert into public.chat_session (pat_id) values ($1) returning chat_session_id',
        [fx.alicePatId],
      ),
    ).resolves.toHaveLength(1)
  })

  it('shows the Clinic Admin a count against the doctor, and nothing else', async () => {
    expect(await counts(database, fx.adminUserId)).toEqual([{ doc_id: fx.doctorCId, held_alerts: 1 }])
    // Still no way into the conversation itself.
    await expectDenied(() =>
      database.asUser(fx.adminUserId, 'select * from public.chat_session where chat_session_id = $1', [
        daveSession,
      ]),
    )
  })

  it('refuses the counts to doctors, patients and anonymous callers', async () => {
    for (const userId of [fx.doctorAUserId, fx.doctorCUserId, fx.daveUserId]) {
      await expect(counts(database, userId)).rejects.toThrow(/Administrator privileges are required/)
    }
    await expect(
      database.asAnon('select * from public.admin_held_chat_alert_counts()'),
    ).rejects.toThrow(/permission denied/)
  })

  it('counts each clinic’s own: another clinic’s Clinic Admin sees only theirs', async () => {
    await liftSingleClinicGate(database)
    const clinicB = await addClinic(database, 'Synthetic Second Clinic', 'Asia/Tokyo')
    const account = async (email: string, role: string) => {
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
    const adminBUserId = await account('admin.b@second.test', 'admin')
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
       values ($1, 'Bianca', 'Ortiz', $2)`,
      [adminBUserId, clinicB],
    )
    const doctorEId = await one<string>(
      database,
      `insert into public.doctor
         (user_id, doc_first_name, doc_last_name, doc_license_no, doc_is_active, clinic_id)
       values ($1, 'Second', 'Clinician', 'LIC-B-E', false, $2) returning doc_id`,
      [await account('doctor.e@second.test', 'doctor'), clinicB],
    )
    const erinPatId = await one<string>(
      database,
      `insert into public.patient (user_id, doc_id, pat_first_name, pat_last_name, pat_consent_at)
       values ($1, $2, 'Erin', 'Mendoza', now()) returning pat_id`,
      [await account('erin@second.test', 'patient'), doctorEId],
    )
    expect(await hold(database, await flaggedSession(database, erinPatId))).toBe('held')

    expect(await counts(database, fx.adminUserId)).toEqual([{ doc_id: fx.doctorCId, held_alerts: 1 }])
    expect(await counts(database, adminBUserId)).toEqual([{ doc_id: doctorEId, held_alerts: 1 }])
  })
})

describe('delivering a held alert on hand-over', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  it('goes to the doctor a deactivated doctor’s patients are moved to (D8), linked to the conversation', async () => {
    const daveSession = await flaggedSession(database, fx.davePatId)
    expect(await hold(database, daveSession)).toBe('held')
    const before = (await chatAlerts(database, fx.doctorAUserId)).length

    expect(await reassign(database, fx, fx.doctorCId, fx.doctorAId)).toEqual([{ moved: 1 }])

    expect((await chatAlerts(database, fx.doctorAUserId)).slice(before)).toEqual([
      { chat_session_id: daveSession, notification_message: DELIVERED_MESSAGE },
    ])
    expect(await heldSince(database, daveSession)).toBeNull()
    expect(await chatAlerts(database, fx.doctorCUserId)).toEqual([])
    expect(await counts(database, fx.adminUserId)).toEqual([])
    // The new doctor can open it, which is what the notification links to.
    expect(
      await database.asUser(
        fx.doctorAUserId,
        'select pat_id from public.chat_session where chat_session_id = $1',
        [daveSession],
      ),
    ).toEqual([{ pat_id: fx.davePatId }])
  })

  it('goes to the same doctor reactivated, however the reactivation is made', async () => {
    // Dave is doctor A's now. Doctor A is deactivated with Alice, Bob and
    // Dave still assigned, and Dave raises a concern.
    await database.asUser(
      fx.adminUserId,
      'update public.doctor set doc_is_active = false where doc_id = $1 returning doc_id',
      [fx.doctorAId],
    )
    const daveSession = await flaggedSession(database, fx.davePatId)
    expect(await hold(database, daveSession)).toBe('held')
    expect(await counts(database, fx.adminUserId)).toEqual([{ doc_id: fx.doctorAId, held_alerts: 1 }])
    const before = (await chatAlerts(database, fx.doctorAUserId)).length

    await database.asUser(
      fx.adminUserId,
      'update public.doctor set doc_is_active = true where doc_id = $1 returning doc_id',
      [fx.doctorAId],
    )

    expect((await chatAlerts(database, fx.doctorAUserId)).slice(before)).toEqual([
      { chat_session_id: daveSession, notification_message: DELIVERED_MESSAGE },
    ])
    expect(await heldSince(database, daveSession)).toBeNull()
    expect(await counts(database, fx.adminUserId)).toEqual([])
  })

  it('stays held through changes that give the patient no active doctor', async () => {
    await database.asUser(
      fx.adminUserId,
      'update public.doctor set doc_is_active = false where doc_id = $1 returning doc_id',
      [fx.doctorAId],
    )
    const daveSession = await flaggedSession(database, fx.davePatId)
    expect(await hold(database, daveSession)).toBe('held')
    const notificationsBefore = await one<number>(database, 'select count(*)::int from public.notification')

    // Another doctor deactivated, and an edit to the deactivated doctor.
    await database.asUser(
      fx.adminUserId,
      'update public.doctor set doc_is_active = false where doc_id = $1 returning doc_id',
      [fx.doctorBId],
    )
    await database.asUser(
      fx.adminUserId,
      `update public.doctor set doc_specialization = 'Orthopaedics' where doc_id = $1 returning doc_id`,
      [fx.doctorAId],
    )

    expect(await heldSince(database, daveSession)).not.toBeNull()
    expect(await one<number>(database, 'select count(*)::int from public.notification')).toBe(
      notificationsBefore,
    )
  })

  it('cannot be triggered by calling the delivery directly', async () => {
    for (const userId of [fx.daveUserId, fx.doctorBUserId, fx.adminUserId]) {
      await expect(
        database.asUser(userId, 'select app_private.deliver_held_chat_alerts()'),
      ).rejects.toThrow(/permission denied/)
      await expect(
        database.asUser(userId, 'select public.chat_alert_deliver_on_handover()'),
      ).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/)
    }
  })
})

describe('migration 38 beside the others', () => {
  it('refuses to run without migration 29, changing nothing', async () => {
    const early = await createTestDatabase({ stopAfter: MIGRATION_28 })
    try {
      const before = await catalog(early)
      await expect(early.applyMigration(MIGRATION_38)).rejects.toThrow(/needs migration 29 first/)
      expect(await catalog(early)).toEqual(before)
    } finally {
      await early.close()
    }
  })

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

  it('goes in after 33, 35, 36 and 37 with 34 still unapplied, as production has them, changing no row; then the same schema once 34 follows', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      createTestDatabase(),
    ])
    try {
      const fx = await seedFixture(production)
      await production.applyMigration(MIGRATION_35)
      await production.applyMigration(MIGRATION_36)
      await production.applyMigration(MIGRATION_37)
      // A flagged conversation and its alert from before 38.
      await flaggedSession(production, fx.davePatId)
      const rows = async () => ({
        sessions: await production.asService(
          `select chat_session_id, pat_id, chat_session_has_critical_flag, chat_session_summary
             from public.chat_session order by 1`,
        ),
        notifications: await production.asService(
          'select notification_id, user_id, chat_session_id, notification_message from public.notification order by 1',
        ),
      })
      const before = await rows()

      await production.applyMigration(MIGRATION_38)

      expect(await rows()).toEqual(before)
      expect(
        await one<number>(
          production,
          'select count(*)::int from public.chat_session where chat_session_alert_held_since is not null',
        ),
      ).toBe(0)

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
  let daveSession: string

  beforeAll(async () => {
    ;[used, through37] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_38 }),
      createTestDatabase({ stopAfter: MIGRATION_37 }),
    ])
    fx = await seedFixture(used)
    daveSession = await flaggedSession(used, fx.davePatId)
    expect(await hold(used, daveSession)).toBe('held')
  })

  afterAll(async () => {
    await Promise.all([used?.close(), through37?.close()])
  })

  it('refuses while an alert is still waiting for a clinician, changing nothing', async () => {
    const before = await catalog(used)
    await expect(used.db.exec(await script(ROLLBACK_38))).rejects.toThrow(
      /still waiting for a clinician/,
    )
    expect(await catalog(used)).toEqual(before)
    expect(await heldSince(used, daveSession)).not.toBeNull()
  })

  it('once it is delivered, returns the schema to exactly what 37 left, keeping every alert and flag', async () => {
    await reassign(used, fx, fx.doctorCId, fx.doctorAId)
    const rows = async () => ({
      sessions: await used.asService(
        `select chat_session_id, pat_id, chat_session_has_critical_flag, chat_session_summary
           from public.chat_session order by 1`,
      ),
      notifications: await used.asService(
        'select notification_id, user_id, chat_session_id, notification_message from public.notification order by 1',
      ),
    })
    const before = await rows()
    expect(before.notifications.some((n) => n['notification_message'] === DELIVERED_MESSAGE)).toBe(true)

    await used.db.exec(await script(ROLLBACK_38))

    expect(await catalog(used)).toEqual(await catalog(through37))
    expect(await rows()).toEqual(before)
  })

  it('refuses, changing nothing, where migration 38 is not applied', async () => {
    const before = await catalog(through37)
    await expect(through37.db.exec(await script(ROLLBACK_38))).rejects.toThrow(
      /Migration 38 is not applied/,
    )
    expect(await catalog(through37)).toEqual(before)
  })
})
