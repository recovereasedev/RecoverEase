import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { catalog } from './helpers/catalog'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Migration 44: a notification is dated when the database stores it. A doctor
 * calling the Data API directly could otherwise date a message to their own
 * patient in the past or the future - and the patient's list is ordered by
 * that date. Every writer is dated the same way, and since none of the
 * system's writers ever named a time, each still writes exactly what it did.
 */

const MIGRATION_33 = '20260902100033'
const MIGRATION_34 = '20260902100034'
const MIGRATION_35 = '20260902100035'
const MIGRATION_36 = '20260902100036'
const MIGRATION_37 = '20260902100037'
const MIGRATION_38 = '20260902100038'
const MIGRATION_41 = '20260902100041'
const MIGRATION_42 = '20260902100042'
const MIGRATION_43 = '20260902100043'
const MIGRATION_44 = '20260902100044'
const MIGRATION_44_FILE = 'supabase/migrations/20260902100044_notification_created_at_server_time.sql'
const ROLLBACK_44 = 'supabase/rollbacks/20260902100044_notification_created_at_server_time.down.sql'

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

/** Long before and long after anything these tests write. */
const PAST = '2026-01-01 00:00:00+00'
const FUTURE = '2099-12-31 23:59:00+00'

/** The wall clock, read in a statement of its own. */
async function clock(database: TestDatabase): Promise<string> {
  const [row] = await database.asService<{ t: string }>('select clock_timestamp()::text as t')
  return row!.t
}

/**
 * Inserts as a signed-in user, as `sendNotificationToPatient` does - with no
 * RETURNING, since a doctor cannot read their patient's notifications. With
 * `createdAt` it also names the time, which only a direct API call can do.
 */
function notifyAs(
  database: TestDatabase,
  userId: string,
  values: {
    id: string
    to: string
    createdAt?: string
    type?: string
    message?: string
    chatSessionId?: string | null
    isRead?: boolean
  },
) {
  const timed = values.createdAt !== undefined
  return database.asUser(
    userId,
    `insert into public.notification
       (notification_id, user_id, notification_type, notification_message,
        chat_session_id, notification_is_read${timed ? ', notification_created_at' : ''})
     values ($1, $2, $3, $4, $5, $6${timed ? ', $7' : ''})`,
    [
      values.id,
      values.to,
      values.type ?? 'general',
      values.message ?? 'Bring your medication list on Thursday.',
      values.chatSessionId ?? null,
      values.isRead ?? false,
      ...(timed ? [values.createdAt] : []),
    ],
  )
}

/** Where a stored notification's time falls: between two clock readings, or as supplied. */
async function storedTime(
  database: TestDatabase,
  id: string,
  window: { before: string; after: string },
  supplied: string,
) {
  const [row] = await database.asService<{ on_time: boolean; as_supplied: boolean }>(
    `select notification_created_at between $2::timestamptz and $3::timestamptz as on_time,
            notification_created_at = $4::timestamptz as as_supplied
       from public.notification where notification_id = $1`,
    [id, window.before, window.after, supplied],
  )
  return row
}

/** Sends as a doctor, naming a time, and reports where the stored time fell. */
async function sendTimed(
  database: TestDatabase,
  userId: string,
  to: string,
  createdAt: string,
) {
  const id = crypto.randomUUID()
  const before = await clock(database)
  await notifyAs(database, userId, { id, to, createdAt })
  const after = await clock(database)
  return storedTime(database, id, { before, after }, createdAt)
}

/** Every notification, as a rollback or a migration must leave it. */
const stored = (database: TestDatabase) =>
  database.asService(
    `select notification_id, user_id, notification_type::text, notification_message,
            notification_created_at::text
       from public.notification order by notification_id`,
  )

describe('a notification’s time (migration 44)', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.notification')
  })

  it.each([
    ['in the past', PAST],
    ['in the future', FUTURE],
  ])('is when the database stored it, not a time %s that the doctor named', async (_, supplied) => {
    await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, supplied)).resolves.toEqual({
      on_time: true,
      as_supplied: false,
    })
  })

  it('keeps the doctor’s message where it was sent in the patient’s list, newest first', async () => {
    // A reminder the system has just written, then two messages the doctor
    // dated far back and far ahead: the list shows them in the order they
    // arrived.
    await database.asService(
      `insert into public.notification (user_id, notification_type, notification_message)
       values ($1, 'medication', 'Your Amoxicillin (500mg) is due at 08:00.')`,
      [fx.aliceUserId],
    )
    await notifyAs(database, fx.doctorAUserId, {
      id: crypto.randomUUID(),
      to: fx.aliceUserId,
      message: 'Dated long ago.',
      createdAt: PAST,
    })
    await notifyAs(database, fx.doctorAUserId, {
      id: crypto.randomUUID(),
      to: fx.aliceUserId,
      message: 'Dated far ahead.',
      createdAt: FUTURE,
    })

    const alicesList = await database.asUser<{ notification_message: string }>(
      fx.aliceUserId,
      `select notification_message from public.notification
        order by notification_created_at desc, notification_message limit 50`,
    )
    const times = await database.asService<{ late: boolean }>(
      `select max(notification_created_at) < $1::timestamptz
          and min(notification_created_at) > $2::timestamptz as late
         from public.notification`,
      [FUTURE, PAST],
    )
    expect(times).toEqual([{ late: true }])
    expect(alicesList).toEqual([
      { notification_message: 'Dated far ahead.' },
      { notification_message: 'Dated long ago.' },
      { notification_message: 'Your Amoxicillin (500mg) is due at 08:00.' },
    ])
  })

  it('is set for a general message that names no time, which the patient reads, as the website sends it', async () => {
    const id = crypto.randomUUID()
    const before = await clock(database)
    await notifyAs(database, fx.doctorAUserId, { id, to: fx.aliceUserId })
    const after = await clock(database)

    const alicesView = await database.asUser<{ notification_type: string; notification_message: string }>(
      fx.aliceUserId,
      'select notification_type, notification_message from public.notification',
    )
    expect(alicesView).toEqual([
      { notification_type: 'general', notification_message: 'Bring your medication list on Thursday.' },
    ])
    expect(await storedTime(database, id, { before, after }, PAST)).toEqual({
      on_time: true,
      as_supplied: false,
    })
  })

  it('cannot be changed by the doctor once the message is sent', async () => {
    const id = crypto.randomUUID()
    await notifyAs(database, fx.doctorAUserId, { id, to: fx.aliceUserId })

    await expectDenied(() =>
      database.asUser(
        fx.doctorAUserId,
        `update public.notification set notification_created_at = $2
          where notification_id = $1 returning notification_id`,
        [id, PAST],
      ),
    )
  })

  describe('leaves migration 41’s rules as they were, a time named or not', () => {
    const send = (userId: string, values: Partial<Parameters<typeof notifyAs>[2]>) =>
      notifyAs(database, userId, {
        id: crypto.randomUUID(),
        to: fx.aliceUserId,
        createdAt: PAST,
        ...values,
      })

    it('may be exactly 1,000 characters, and is dated by the database', async () => {
      const id = crypto.randomUUID()
      await expect(send(fx.doctorAUserId, { id, message: 'x'.repeat(1000) })).resolves.toEqual([])
      const [row] = await database.asService<{ as_supplied: boolean }>(
        `select notification_created_at = $2::timestamptz as as_supplied
           from public.notification where notification_id = $1`,
        [id, PAST],
      )
      expect(row).toEqual({ as_supplied: false })
    })

    it.each(['appointment', 'medication', 'treatment', 'chat_critical', 'announcement'])(
      'cannot be a %s notification',
      async (type) => {
        await expect(send(fx.doctorAUserId, { type })).rejects.toThrow(RLS)
      },
    )

    it('cannot link a conversation, arrive already read, be blank or run past 1,000 characters', async () => {
      await expect(send(fx.doctorAUserId, { chatSessionId: fx.aliceChatSessionId })).rejects.toThrow(RLS)
      await expect(send(fx.doctorAUserId, { isRead: true })).rejects.toThrow(RLS)
      await expect(send(fx.doctorAUserId, { message: '   ' })).rejects.toThrow(RLS)
      await expect(send(fx.doctorAUserId, { message: 'x'.repeat(1001) })).rejects.toThrow(RLS)
    })

    it('reaches only the doctor’s own patients, and only while the doctor is active', async () => {
      await expect(send(fx.doctorAUserId, { to: fx.carolUserId })).rejects.toThrow(RLS)
      // Doctor C is deactivated in the fixture; Dave is their patient.
      await expect(send(fx.doctorCUserId, { to: fx.daveUserId })).rejects.toThrow(RLS)
    })

    it('cannot be written by a patient or an administrator', async () => {
      await expect(send(fx.aliceUserId, { to: fx.bobUserId })).rejects.toThrow(RLS)
      await expect(send(fx.adminUserId, {})).rejects.toThrow(RLS)
    })

    it('leaves nothing behind when it refuses', async () => {
      await expect(send(fx.doctorAUserId, { type: 'chat_critical' })).rejects.toThrow(RLS)
      expect(await stored(database)).toEqual([])
    })
  })
})

describe('the system’s own notifications, dated as the column default dated them', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await database.asService('delete from public.notification')
  })

  /**
   * The notifications written since the last case, each checked against
   * `at`: the start of the transaction that wrote them, which is what the
   * column default would have given.
   */
  async function written(at: string) {
    return database.asService<{ user_id: string; notification_type: string; at_default: boolean }>(
      `select user_id, notification_type::text, notification_created_at = $1::timestamptz as at_default
         from public.notification order by user_id, notification_type`,
      [at],
    )
  }

  it('the appointment reminder job', async () => {
    await database.asService(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, now() + interval '12 hours')`,
      [fx.alicePatId, fx.doctorAId],
    )
    const [run] = await database.asService<{ at: string; n: number }>(
      'select now()::text as at, public.dispatch_appointment_reminders(24) as n',
    )

    expect(Number(run!.n)).toBe(2)
    const rows = await written(run!.at)
    expect(rows.map((row) => row.user_id).sort()).toEqual([fx.aliceUserId, fx.doctorAUserId].sort())
    expect(rows.every((row) => row.notification_type === 'appointment' && row.at_default)).toBe(true)
  })

  it('the missed-dose and pre-dose medication reminder jobs', async () => {
    await database.asService(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() - interval '45 minutes')`,
      [fx.aliceScheduleId],
    )
    const [missed] = await database.asService<{ at: string; n: number }>(
      'select now()::text as at, public.dispatch_medication_reminders(30) as n',
    )
    expect(Number(missed!.n)).toBeGreaterThan(0)
    const missedRows = await written(missed!.at)
    expect(missedRows).toHaveLength(Number(missed!.n))
    expect(missedRows.every((row) => row.notification_type === 'medication' && row.at_default)).toBe(true)

    await database.asService('delete from public.notification')
    await database.asService(
      `insert into public.medication_log (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() + interval '5 minutes')`,
      [fx.aliceScheduleId],
    )
    const [preDose] = await database.asService<{ at: string; n: number }>(
      'select now()::text as at, public.dispatch_medication_pre_dose_reminders() as n',
    )
    expect(Number(preDose!.n)).toBeGreaterThan(0)
    const preDoseRows = await written(preDose!.at)
    expect(preDoseRows).toHaveLength(Number(preDose!.n))
    expect(preDoseRows.every((row) => row.notification_type === 'medication' && row.at_default)).toBe(true)
  })

  it('the cancellation notices, written while the doctor is the signed-in user', async () => {
    const [appointment] = await database.asService<{ appointment_id: string }>(
      `insert into public.appointment (pat_id, doc_id, appointment_date, appointment_status)
       values ($1, $2, now() + interval '2 days', 'scheduled')
       returning appointment_id`,
      [fx.alicePatId, fx.doctorAId],
    )
    const [run] = await database.asUser<{ at: string; n: number }>(
      fx.doctorAUserId,
      `with cancelled as (
         update public.appointment set appointment_status = 'cancelled'
          where appointment_id = $1 returning appointment_id
       )
       select now()::text as at, (select count(*) from cancelled)::int as n`,
      [appointment!.appointment_id],
    )

    expect(run!.n).toBe(1)
    const rows = await written(run!.at)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.notification_type === 'appointment' && row.at_default)).toBe(true)
  })

  it('a critical-chat alert from the service role, as chatbot-reply writes it, even naming a time', async () => {
    const rows = await database.db.transaction(async (tx) => {
      await tx.exec('set local role service_role')
      const plain = await tx.query<{ at_default: boolean }>(
        `insert into public.notification
           (user_id, notification_type, notification_message, chat_session_id)
         values ($1, 'chat_critical', 'A patient raised a concern in the guidance chat that may need your attention.', $2)
         returning notification_created_at = now() as at_default`,
        [fx.doctorAUserId, fx.aliceChatSessionId],
      )
      const timed = await tx.query<{ at_default: boolean }>(
        `insert into public.notification
           (user_id, notification_type, notification_message, chat_session_id, notification_created_at)
         values ($1, 'chat_critical', 'The guidance assistant could not answer a patient''s message.', $2, $3)
         returning notification_created_at = now() as at_default`,
        [fx.doctorAUserId, fx.aliceChatSessionId, PAST],
      )
      return [...plain.rows, ...timed.rows]
    })

    expect(rows).toEqual([{ at_default: true }, { at_default: true }])
    const doctorsView = await database.asUser<{ notification_type: string }>(
      fx.doctorAUserId,
      'select notification_type from public.notification',
    )
    expect(doctorsView).toEqual([{ notification_type: 'chat_critical' }, { notification_type: 'chat_critical' }])
  })

  // Last: it moves Dave and his appointment to doctor A.
  it('the reassignment notices, when an administrator moves a deactivated doctor’s patients', async () => {
    await database.asService(
      `insert into public.appointment (pat_id, doc_id, appointment_date)
       values ($1, $2, date_trunc('minute', now() + interval '2 days'))`,
      [fx.davePatId, fx.doctorCId],
    )
    const [run] = await database.asUser<{ at: string; n: number }>(
      fx.adminUserId,
      'select now()::text as at, public.admin_reassign_doctor_patients($1, $2, 1, 1) as n',
      [fx.doctorCId, fx.doctorAId],
    )

    expect(Number(run!.n)).toBe(1)
    const rows = await written(run!.at)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.at_default)).toBe(true)
  })
})

describe('migration 44, before and after', () => {
  it('adds one trigger and its function, and nothing else', async () => {
    // Against every migration before it in the repository's order, 43
    // included; production applied 44 before 43, which the last test covers.
    const [applied, through43] = await Promise.all([
      // Through 44: what later migrations add is not 44's.
      createTestDatabase({ stopAfter: MIGRATION_44 }),
      createTestDatabase({ stopAfter: MIGRATION_43 }),
    ])
    try {
      const earlier = new Set((await catalog(through43)).map((entry) => JSON.stringify(entry)))
      const added = (await catalog(applied)).filter((entry) => !earlier.has(JSON.stringify(entry)))

      expect(added.map((entry) => `${entry.kind} ${entry.name}`)).toEqual([
        'function public.notification_assign_created_at()',
        'trigger notification.notification_assign_created_at',
      ])
      // An ordinary trigger function: not SECURITY DEFINER, a fixed
      // search_path, and no EXECUTE for the API roles.
      expect(added[0]!.detail).toMatch(/ definer=false /)
      expect(added[0]!.detail).toMatch(/ config=search_path=""/)
      // Revoked, so the ACL is written out: no PUBLIC entry (`=X`), and
      // neither API role.
      const acl = added[0]!.detail.split(' acl=')[1]!
      expect(acl).not.toBe('-')
      expect(acl.split(',').some((entry) => /^(|anon|authenticated)=/.test(entry))).toBe(false)
      expect(added[1]!.detail).toMatch(/BEFORE INSERT ON public\.notification FOR EACH ROW/)
      expect((await catalog(applied)).length).toBe((await catalog(through43)).length + 2)
    } finally {
      await Promise.all([applied.close(), through43.close()])
    }
  })

  it('closes a gap that was real: before it, the doctor’s time was stored', async () => {
    const before = await createTestDatabase({ stopAfter: MIGRATION_42 })
    try {
      const fx = await seedFixture(before)
      await expect(sendTimed(before, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: false,
        as_supplied: true,
      })
    } finally {
      await before.close()
    }
  })

  it('changes no notification already stored, applied or rolled back, and a patient marking one read keeps its time', async () => {
    const database = await createTestDatabase({ stopAfter: MIGRATION_42 })
    try {
      const fx = await seedFixture(database)
      // What production holds: the system's reminders, dated by the default
      // when they were written, and a doctor's message dated by the doctor.
      await database.asService(
        `insert into public.notification (user_id, notification_type, notification_message, notification_created_at)
         values ($1, 'medication', 'Your Amoxicillin (500mg) is due at 08:00.', '2026-09-02 17:30:00.047556+00'),
                ($1, 'appointment', 'You have an upcoming appointment on Monday, 7 September at 09:00.', '2026-09-06 09:00:00+00'),
                ($2, 'chat_critical', 'A patient raised a concern in the guidance chat that may need your attention.', '2026-10-16 03:12:45.5+00')`,
        [fx.aliceUserId, fx.doctorAUserId],
      )
      await notifyAs(database, fx.doctorAUserId, {
        id: crypto.randomUUID(),
        to: fx.aliceUserId,
        createdAt: FUTURE,
      })
      const before = await stored(database)
      expect(before).toHaveLength(4)

      await database.applyMigration(MIGRATION_44)
      expect(await stored(database)).toEqual(before)

      await database.asUser(
        fx.aliceUserId,
        'update public.notification set notification_is_read = true where user_id = $1',
        [fx.aliceUserId],
      )
      expect(await stored(database)).toEqual(before)

      await database.db.exec(await script(ROLLBACK_44))
      expect(await stored(database)).toEqual(before)
    } finally {
      await database.close()
    }
  })

  it('waits at most 3 seconds for its lock, puts the setting back, and can be run again', async () => {
    // The timeout is in force before `notification` is touched, and the
    // server's default is back after the last statement.
    const lines = codeLines(await script(MIGRATION_44_FILE))
    expect(lines[0]).toBe("set lock_timeout = '3s';")
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase({ stopAfter: MIGRATION_42 })
    try {
      const fx = await seedFixture(database)
      await database.applyMigration(MIGRATION_44)
      expect(await lockTimeout(database)).toBe('0')

      // Stopped by a lock it could not get, it runs again from the top.
      await database.applyMigration(MIGRATION_44)
      const [trigger] = await database.asService<{ n: number }>(
        `select count(*)::int as n from pg_trigger where tgname = 'notification_assign_created_at'`,
      )
      expect(trigger!.n).toBe(1)
      await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: true,
        as_supplied: false,
      })
    } finally {
      await database.close()
    }
  })

  it('stopped between dropping the trigger and creating it, refuses no notification, and completes when run again', async () => {
    // Where the runner does not run the file as one transaction, a lock
    // timeout on `create trigger` leaves the function without its trigger:
    // notifications are dated as they were before 44, and none is refused.
    const database = await createTestDatabase()
    try {
      const fx = await seedFixture(database)
      await database.db.exec('drop trigger notification_assign_created_at on public.notification')
      await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: false,
        as_supplied: true,
      })

      await database.applyMigration(MIGRATION_44)
      await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: true,
        as_supplied: false,
      })
    } finally {
      await database.close()
    }
  })

  it('rolls back to exactly what the migrations before it left, refuses to run twice, and can be applied again', async () => {
    const [database, through43] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_44 }),
      createTestDatabase({ stopAfter: MIGRATION_43 }),
    ])
    try {
      const fx = await seedFixture(database)
      await database.db.exec(await script(ROLLBACK_44))

      expect(await catalog(database)).toEqual(await catalog(through43))
      // Dated by the doctor again, as before 44.
      await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: false,
        as_supplied: true,
      })

      await expect(database.db.exec(await script(ROLLBACK_44))).rejects.toThrow(
        /Migration 44 is not applied/,
      )

      await database.applyMigration(MIGRATION_44)
      await expect(sendTimed(database, fx.doctorAUserId, fx.aliceUserId, FUTURE)).resolves.toEqual({
        on_time: true,
        as_supplied: false,
      })
    } finally {
      await Promise.all([database.close(), through43.close()])
    }
  })

  it('rolls back waiting at most 3 seconds for its lock, set only once it has decided to run, and puts the setting back', async () => {
    // The check comes first and locks nothing. The timeout is set on the line
    // after it, before `notification` is touched, and the server's default is
    // back after the last statement.
    const lines = codeLines(await script(ROLLBACK_44))
    const checked = lines.indexOf('$$;')
    expect(lines.slice(0, checked + 1).some((line) => /^(drop|create|alter)\b/.test(line))).toBe(false)
    expect(lines[checked + 1]).toBe("set lock_timeout = '3s';")
    expect(lines.filter((line) => line.includes('lock_timeout'))).toHaveLength(2)
    expect(lines.at(-1)).toBe('reset lock_timeout;')

    const database = await createTestDatabase()
    try {
      await database.db.exec(await script(ROLLBACK_44))
      expect(await lockTimeout(database)).toBe('0')

      // Refused, it leaves the connection's own setting as it found it.
      await database.db.exec(`set lock_timeout = '5s'`)
      await expect(database.db.exec(await script(ROLLBACK_44))).rejects.toThrow(
        /Migration 44 is not applied/,
      )
      expect(await lockTimeout(database)).toBe('5s')
    } finally {
      await database.close()
    }
  })

  it('stopped between dropping the trigger and the function, finishes when run again', async () => {
    const [database, through43] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_44 }),
      createTestDatabase({ stopAfter: MIGRATION_43 }),
    ])
    try {
      await database.db.exec('drop trigger notification_assign_created_at on public.notification')

      await database.db.exec(await script(ROLLBACK_44))
      expect(await catalog(database)).toEqual(await catalog(through43))
    } finally {
      await Promise.all([database.close(), through43.close()])
    }
  })

  it('goes in after 42 and 41 with 43 and 34 still unapplied, as production has them; then the same schema once 43 and 34 follow', async () => {
    const [production, repository] = await Promise.all([
      createTestDatabase({ stopAfter: MIGRATION_33 }),
      createTestDatabase({ stopAfter: MIGRATION_44 }),
    ])
    try {
      const fx = await seedFixture(production)
      for (const version of [MIGRATION_35, MIGRATION_36, MIGRATION_37, MIGRATION_38, MIGRATION_42, MIGRATION_41]) {
        await production.applyMigration(version)
      }
      await production.applyMigration(MIGRATION_44)

      await expect(sendTimed(production, fx.doctorAUserId, fx.aliceUserId, PAST)).resolves.toEqual({
        on_time: true,
        as_supplied: false,
      })

      // 43 goes in after 44, as it will in production, and leaves the time
      // to the database.
      await production.applyMigration(MIGRATION_43)
      await expect(sendTimed(production, fx.doctorAUserId, fx.aliceUserId, FUTURE)).resolves.toEqual({
        on_time: true,
        as_supplied: false,
      })

      await production.applyMigration(MIGRATION_34)
      expect(await catalog(production)).toEqual(await catalog(repository))
    } finally {
      await Promise.all([production.close(), repository.close()])
    }
  })
})
