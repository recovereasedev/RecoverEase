import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 7.1 "Send Notification to Patient", as the database allows it after
 * migration 41: an active doctor may send their own patient a general, unread
 * message of 1 to 1,000 characters - and nothing else. Every other kind of
 * notification is the system's, written by SECURITY DEFINER functions and the
 * service role, and still arrives.
 */

const MIGRATION_38 = '20260902100038'
const MIGRATION_41 = '20260902100041'
const MIGRATION_41_FILE = 'supabase/migrations/20260902100041_doctor_notifications_general_only.sql'
const ROLLBACK_41 = 'supabase/rollbacks/20260902100041_doctor_notifications_general_only.down.sql'

const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

/** A script's lines of SQL, without its comments or blank lines. */
const codeLines = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))

/** The connection's `lock_timeout`, as its next statement would run under. */
async function lockTimeout(database: TestDatabase): Promise<string> {
  const [row] = await database.asService<{ lock_timeout: string }>(
    `select current_setting('lock_timeout') as lock_timeout`,
  )
  return row!.lock_timeout
}

const RLS = /row-level security/

/**
 * Inserts as a signed-in user, as `sendNotificationToPatient` does - with no
 * RETURNING, which would also need the sender to be able to read the row,
 * and a doctor cannot read their patient's notifications.
 */
function notifyAs(
  database: TestDatabase,
  userId: string,
  values: {
    to: string
    type?: string
    message?: string
    chatSessionId?: string | null
    isRead?: boolean
    id?: string
  },
) {
  return database.asUser(
    userId,
    `insert into public.notification
       (notification_id, user_id, notification_type, notification_message,
        chat_session_id, notification_is_read)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)`,
    [
      values.id ?? null,
      values.to,
      values.type ?? 'general',
      values.message ?? 'Bring your medication list on Thursday.',
      values.chatSessionId ?? null,
      values.isRead ?? false,
    ],
  )
}

describe('a doctor’s notification to a patient (migration 41)', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.notification')
  })

  it('is a general message to their own patient, which the patient reads', async () => {
    await notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId })

    const alicesView = await database.asUser<{ notification_type: string; notification_message: string }>(
      fx.aliceUserId,
      'select notification_type, notification_message from public.notification',
    )
    expect(alicesView).toEqual([
      { notification_type: 'general', notification_message: 'Bring your medication list on Thursday.' },
    ])
  })

  it('may be exactly 1,000 characters, and no longer', async () => {
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, message: 'x'.repeat(1000) }),
    ).resolves.toEqual([])
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, message: 'x'.repeat(1001) }),
    ).rejects.toThrow(RLS)
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, message: '   ' }),
    ).rejects.toThrow(RLS)
  })

  it.each(['appointment', 'medication', 'treatment', 'chat_critical', 'announcement'])(
    'cannot be a %s notification',
    async (type) => {
      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, type }),
      ).rejects.toThrow(RLS)
    },
  )

  it('cannot link a conversation, or arrive already read', async () => {
    await expect(
      notifyAs(database, fx.doctorAUserId, {
        to: fx.aliceUserId,
        chatSessionId: fx.aliceChatSessionId,
      }),
    ).rejects.toThrow(RLS)
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, isRead: true }),
    ).rejects.toThrow(RLS)
  })

  it('still reaches only the doctor’s own patients, and only while the doctor is active', async () => {
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.carolUserId }),
    ).rejects.toThrow(RLS)

    // Deactivated as an administrator does it (module 11.3): the doctor guard
    // lets nobody else change it.
    await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = false where doc_id = $1', [
      fx.doctorAId,
    ])
    try {
      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId }),
      ).rejects.toThrow(RLS)
    } finally {
      await database.asUser(fx.adminUserId, 'update public.doctor set doc_is_active = true where doc_id = $1', [
        fx.doctorAId,
      ])
    }
  })

  it('cannot be written by a patient or an administrator', async () => {
    await expect(notifyAs(database, fx.aliceUserId, { to: fx.bobUserId })).rejects.toThrow(RLS)
    await expect(notifyAs(database, fx.adminUserId, { to: fx.aliceUserId })).rejects.toThrow(RLS)
  })

  it('is stored once when the same send arrives twice under one id', async () => {
    const id = '7a3f0c9e-1b2d-4e5f-8a6b-9c0d1e2f3a4b'
    await notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, id })

    // The website answers this duplicate-key refusal as "already sent".
    await expect(
      notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, id }),
    ).rejects.toMatchObject({ code: '23505' })
    const [{ count }] = (await database.asService<{ count: number }>(
      'select count(*)::int as count from public.notification where notification_id = $1',
      [id],
    )) as [{ count: number }]
    expect(count).toBe(1)
  })

  describe('leaves the system’s own notifications to the system', () => {
    it('tells the patient when their doctor cancels an appointment', async () => {
      // The cancellation notice is written by a trigger while the doctor is
      // the signed-in user - SECURITY DEFINER, so not through their policy.
      const [appointment] = await database.asService<{ appointment_id: string }>(
        `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_status)
         values ($1, $2, now() + interval '2 days', 'scheduled')
         returning appointment_id`,
        [fx.alicePatId, fx.doctorAId],
      )
      const cancelled = await database.asUser(
        fx.doctorAUserId,
        `update public.appointment set appointment_status = 'cancelled'
          where appointment_id = $1 returning appointment_id`,
        [appointment!.appointment_id],
      )
      expect(cancelled).toHaveLength(1)

      const notices = await database.asService<{ user_id: string; notification_type: string }>(
        'select user_id, notification_type from public.notification order by user_id',
      )
      expect(notices.map((row) => row.notification_type)).toEqual(['appointment', 'appointment'])
      expect(notices.map((row) => row.user_id).sort()).toEqual(
        [fx.aliceUserId, fx.doctorAUserId].sort(),
      )
      await database.asService('delete from public.appointment where appointment_id = $1', [
        appointment!.appointment_id,
      ])
    })

    it('lets the service role raise a critical-chat alert, as chatbot-reply does', async () => {
      await database.asService(
        `insert into public.notification
           (user_id, notification_type, notification_message, chat_session_id)
         values ($1, 'chat_critical', 'A patient raised a possible critical concern.', $2)`,
        [fx.doctorAUserId, fx.aliceChatSessionId],
      )
      const doctorsView = await database.asUser<{ notification_type: string }>(
        fx.doctorAUserId,
        'select notification_type from public.notification',
      )
      expect(doctorsView).toEqual([{ notification_type: 'chat_critical' }])
    })
  })
})

describe('migration 41, before and after', () => {
  it('was the gap it closes: before it, a doctor could raise a critical alert', async () => {
    const before = await createTestDatabase({ stopAfter: MIGRATION_38 })
    try {
      const fx = await seedFixture(before)
      await expect(
        notifyAs(before, fx.doctorAUserId, { to: fx.aliceUserId, type: 'chat_critical' }),
      ).resolves.toEqual([])
    } finally {
      await before.close()
    }
  })

  it('waits at most 3 seconds for its lock, puts the setting back, and can be run again', async () => {
    // The timeout is in force before the policy is touched, and the server's
    // default is back after the last statement.
    const lines = codeLines(await script(MIGRATION_41_FILE))
    expect(lines[0]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase({ stopAfter: MIGRATION_38 })
    try {
      await database.applyMigration(MIGRATION_41)
      expect(await lockTimeout(database)).toBe('0')

      // Stopped by a lock it could not get, it runs again from the top.
      await database.applyMigration(MIGRATION_41)
      const policies = await database.asService<{ with_check: string }>(
        `select with_check from pg_policies
          where tablename = 'notification'
            and policyname = 'notification_insert_doctor_to_patient'`,
      )
      expect(policies).toHaveLength(1)
      expect(policies[0]!.with_check).toContain('notification_type')
    } finally {
      await database.close()
    }
  })

  it('rolls back to the policy migration 06 wrote, and refuses to run twice', async () => {
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.db.exec(await script(ROLLBACK_41))

      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, type: 'treatment' }),
      ).resolves.toEqual([])
      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.carolUserId }),
      ).rejects.toThrow(RLS)

      await expect(database.db.exec(await script(ROLLBACK_41))).rejects.toThrow(
        /Migration 41 is not applied/,
      )
    } finally {
      await database.close()
    }
  })

  it('rolls back waiting at most 3 seconds for its lock, set only once it has decided to run, and puts the setting back', async () => {
    // The check comes first and locks nothing. The timeout is set on the line
    // after it, before the policy is touched, and the server's default is back
    // after the last statement.
    const lines = codeLines(await script(ROLLBACK_41))
    const checked = lines.indexOf('$$;')
    expect(lines.slice(0, checked + 1).some((line) => /^(drop|create|alter)\b/.test(line))).toBe(false)
    expect(lines[checked + 1]).toBe("set lock_timeout = '3s';")
    expect(lines.filter((line) => line.includes('lock_timeout'))).toHaveLength(2)
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase()
    try {
      await database.db.exec(await script(ROLLBACK_41))
      expect(await lockTimeout(database)).toBe('0')

      // Refused, it leaves the connection's own setting as it found it.
      await database.db.exec(`set lock_timeout = '5s'`)
      await expect(database.db.exec(await script(ROLLBACK_41))).rejects.toThrow(
        /Migration 41 is not applied/,
      )
      expect(await lockTimeout(database)).toBe('5s')
    } finally {
      await database.close()
    }
  })

  it('stopped between dropping the policy and putting it back, recovers through migration 41 and then the rollback', async () => {
    // Where the runner does not run the file as one transaction, a lock
    // timeout on its `create policy` leaves no doctor policy at all, and the
    // rollback's check then refuses a second run.
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.db.exec(
        'drop policy notification_insert_doctor_to_patient on public.notification',
      )
      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId }),
      ).rejects.toThrow(RLS)
      await expect(database.db.exec(await script(ROLLBACK_41))).rejects.toThrow(
        /Migration 41 is not applied/,
      )

      // Migration 41 again puts its policy back; the rollback then runs.
      await database.applyMigration(MIGRATION_41)
      await database.db.exec(await script(ROLLBACK_41))
      await expect(
        notifyAs(database, fx.doctorAUserId, { to: fx.aliceUserId, type: 'treatment' }),
      ).resolves.toEqual([])
    } finally {
      await database.close()
    }
  })
})
