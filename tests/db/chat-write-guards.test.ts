import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Who may write what in the guidance chat (migration 26).
 *
 * The patient writes their own messages, as the patient. The assistant's
 * messages, the critical-concern flag and the summary beside it are written
 * by `chatbot-reply` alone, as service_role. Doctors and administrators write
 * none of it. Before migration 26 a patient could write an assistant message
 * into their own conversation, and set, clear or rewrite its alert.
 */
describe('writing to the guidance chat', () => {
  let database: TestDatabase
  let fx: Fixture
  let flaggedSessionId: string
  let bobSessionId: string
  let serverSessionId: string
  let aliceMessageId: string

  const REFUSED_ASSISTANT = /Only the guidance assistant can write an assistant message/
  const REFUSED_ALERT = /alert and summary are set by the guidance assistant/

  /** Runs as service_role, the role chatbot-reply's service key maps to. */
  async function asServiceRole<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await database.db.exec('begin')
    try {
      await database.db.exec('set local role service_role')
      const result = await database.db.query<T>(sql, params)
      await database.db.exec('commit')
      return result.rows
    } catch (error) {
      await database.db.exec('rollback')
      throw error
    }
  }

  async function session(id: string) {
    const [row] = await database.asService<{ flag: boolean; summary: string | null }>(
      `select chat_session_has_critical_flag as flag, chat_session_summary as summary
         from public.chat_session where chat_session_id = $1`,
      [id],
    )
    return row
  }

  async function assistantMessages(sessionId: string): Promise<number> {
    const [row] = await database.asService<{ n: number }>(
      `select count(*)::int as n from public.chat_message
        where chat_session_id = $1 and chat_message_role = 'assistant'`,
      [sessionId],
    )
    return row!.n
  }

  const newSession = async (patId: string, flagged = false, summary: string | null = null) => {
    const [row] = await database.asService<{ id: string }>(
      `insert into public.chat_session (pat_id, chat_session_has_critical_flag, chat_session_summary)
       values ($1, $2, $3) returning chat_session_id as id`,
      [patId, flagged, summary],
    )
    return row!.id
  }

  const writeMessage = (userId: string, sessionId: string, role: string) =>
    database.asUser(
      userId,
      `insert into public.chat_message (chat_session_id, chat_message_role, chat_message_content)
       values ($1, $2, 'Written directly.') returning chat_message_role`,
      [sessionId, role],
    )

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    flaggedSessionId = await newSession(
      fx.alicePatId,
      true,
      'The assistant advised seeking care now.',
    )
    bobSessionId = await newSession(fx.bobPatId)
    serverSessionId = await newSession(fx.alicePatId)

    const [message] = await database.asService<{ id: string }>(
      `select chat_message_id as id from public.chat_message where chat_session_id = $1`,
      [fx.aliceChatSessionId],
    )
    aliceMessageId = message!.id
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('a patient', () => {
    it('still writes their own message, as the patient', async () => {
      expect(await writeMessage(fx.aliceUserId, fx.aliceChatSessionId, 'patient')).toEqual([
        { chat_message_role: 'patient' },
      ])
    })

    it('cannot write a message as the assistant', async () => {
      const before = await assistantMessages(fx.aliceChatSessionId)

      await expect(
        writeMessage(fx.aliceUserId, fx.aliceChatSessionId, 'assistant'),
      ).rejects.toThrow(REFUSED_ASSISTANT)
      expect(await assistantMessages(fx.aliceChatSessionId)).toBe(before)
    })

    it('cannot change who wrote a message, or what it says', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.chat_message set chat_message_role = 'assistant'
            where chat_message_id = $1 returning chat_message_id`,
          [aliceMessageId],
        ),
      )
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.chat_message set chat_message_content = 'Rewritten.'
            where chat_message_id = $1 returning chat_message_id`,
          [aliceMessageId],
        ),
      )

      const [row] = await database.asService<{ role: string; content: string }>(
        `select chat_message_role as role, chat_message_content as content
           from public.chat_message where chat_message_id = $1`,
        [aliceMessageId],
      )
      expect(row).toEqual({ role: 'patient', content: 'Is swelling normal after two weeks?' })
    })

    it.each([
      ['flag an unflagged conversation', 'unflagged', 'chat_session_has_critical_flag = true'],
      ['clear a flag', 'flagged', 'chat_session_has_critical_flag = false'],
      ['rewrite a summary', 'unflagged', `chat_session_summary = 'Nothing to see here.'`],
      ['remove a summary', 'flagged', 'chat_session_summary = null'],
    ] as const)('cannot %s', async (_label, which, assignment) => {
      const id = which === 'flagged' ? flaggedSessionId : fx.aliceChatSessionId
      const before = await session(id)

      await expect(
        database.asUser(
          fx.aliceUserId,
          `update public.chat_session set ${assignment}
            where chat_session_id = $1 returning chat_session_id`,
          [id],
        ),
      ).rejects.toThrow(REFUSED_ALERT)
      expect(await session(id)).toEqual(before)
    })

    it.each([
      ['already flagged', 'chat_session_has_critical_flag', true],
      ['already summarised', 'chat_session_summary', 'Nothing to see here.'],
    ] as const)('cannot start a conversation %s', async (_label, column, value) => {
      await expect(
        database.asUser(
          fx.aliceUserId,
          `insert into public.chat_session (pat_id, ${column}) values ($1, $2)
           returning chat_session_id`,
          [fx.alicePatId, value],
        ),
      ).rejects.toThrow(REFUSED_ALERT)
    })

    it('still starts a conversation, and may write what a session already holds', async () => {
      expect(
        await database.asUser(
          fx.aliceUserId,
          `insert into public.chat_session (pat_id) values ($1)
           returning chat_session_has_critical_flag as flag, chat_session_summary as summary`,
          [fx.alicePatId],
        ),
      ).toEqual([{ flag: false, summary: null }])

      const before = await session(flaggedSessionId)
      await database.asUser(
        fx.aliceUserId,
        `update public.chat_session
            set chat_session_has_critical_flag = true,
                chat_session_summary = 'The assistant advised seeking care now.'
          where chat_session_id = $1`,
        [flaggedSessionId],
      )
      expect(await session(flaggedSessionId)).toEqual(before)
    })

    it('leaves the session’s other columns as they were', async () => {
      const [row] = await database.asUser<{ ended: string | null }>(
        fx.aliceUserId,
        `update public.chat_session set chat_session_ended_at = now()
          where chat_session_id = $1 returning chat_session_ended_at as ended`,
        [fx.aliceChatSessionId],
      )
      expect(row?.ended).not.toBeNull()
    })

    it('cannot write into, or change, another patient’s conversation', async () => {
      await expectDenied(() => writeMessage(fx.aliceUserId, bobSessionId, 'patient'))
      await expectDenied(() =>
        database.asUser(
          fx.aliceUserId,
          `update public.chat_session set chat_session_has_critical_flag = true
            where chat_session_id = $1 returning chat_session_id`,
          [bobSessionId],
        ),
      )
      expect(await session(bobSessionId)).toEqual({ flag: false, summary: null })
    })
  })

  describe('a doctor', () => {
    it('reads their patient’s conversation', async () => {
      const rows = await database.asUser(
        fx.doctorAUserId,
        `select 1 from public.chat_message where chat_session_id = $1`,
        [fx.aliceChatSessionId],
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it('writes nothing into it', async () => {
      await expectDenied(() => writeMessage(fx.doctorAUserId, fx.aliceChatSessionId, 'patient'))
      await expectDenied(() => writeMessage(fx.doctorAUserId, fx.aliceChatSessionId, 'assistant'))
      await expectDenied(() =>
        database.asUser(
          fx.doctorAUserId,
          `update public.chat_session set chat_session_has_critical_flag = false
            where chat_session_id = $1 returning chat_session_id`,
          [flaggedSessionId],
        ),
      )
      expect(await session(flaggedSessionId)).toEqual({
        flag: true,
        summary: 'The assistant advised seeking care now.',
      })
    })

    it('cannot read another doctor’s patient’s conversation', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.doctorBUserId,
          `select 1 from public.chat_message where chat_session_id = $1`,
          [fx.aliceChatSessionId],
        ),
      )
    })
  })

  describe('an administrator and a visitor', () => {
    it('neither reads nor writes a conversation', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.adminUserId,
          `select 1 from public.chat_message where chat_session_id = $1`,
          [fx.aliceChatSessionId],
        ),
      )
      await expectDenied(() => writeMessage(fx.adminUserId, fx.aliceChatSessionId, 'assistant'))
      await expectDenied(() =>
        database.asAnon(
          `insert into public.chat_message (chat_session_id, chat_message_role, chat_message_content)
           values ($1, 'assistant', 'Written directly.') returning chat_message_id`,
          [fx.aliceChatSessionId],
        ),
      )
    })
  })

  describe('the server, as chatbot-reply writes', () => {
    it('writes the assistant’s reply', async () => {
      expect(
        await asServiceRole(
          `insert into public.chat_message (chat_session_id, chat_message_role, chat_message_content)
           values ($1, 'assistant', 'Some stiffness is common.') returning chat_message_role`,
          [serverSessionId],
        ),
      ).toEqual([{ chat_message_role: 'assistant' }])
    })

    it('raises the alert with its summary', async () => {
      await asServiceRole(
        `update public.chat_session
            set chat_session_has_critical_flag = true,
                chat_session_summary = 'The assistant suggested contacting the care team.'
          where chat_session_id = $1`,
        [serverSessionId],
      )

      expect(await session(serverSessionId)).toEqual({
        flag: true,
        summary: 'The assistant suggested contacting the care team.',
      })
    })
  })
})
