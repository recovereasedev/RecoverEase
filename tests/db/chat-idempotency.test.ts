import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { replyIdFor } from '../../supabase/functions/_shared/reply-once'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The guidance chat never saves the same thing twice - and it is Postgres's
 * primary key that guarantees it, not a check in the browser or the function.
 *
 * - The browser chooses the id of a patient's message (and of a new
 *   conversation) once, and reuses it when sending again after a save whose
 *   answer was lost. The second save is refused as a duplicate.
 * - `chatbot-reply` saves a reply under an id derived from the message it
 *   answers. A second reply to the same message is refused as a duplicate,
 *   however the two requests interleave.
 *
 * No schema change: these are the existing primary keys and grants.
 */
describe('saving to the guidance chat at most once', () => {
  let database: TestDatabase
  let fx: Fixture

  const DUPLICATE = { code: '23505' }
  /** Stands in for the service key chatbot-reply derives reply ids with. */
  const KEY = 'test-service-key-not-a-real-secret'

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

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = await database.asService<{ n: number }>(sql, params)
    return row!.n
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('a patient sending again after an unconfirmed save', () => {
    it('starts one conversation under the id the browser chose, never two', async () => {
      const id = 'd1d1d1d1-1111-4111-8111-111111111111'
      const start = () =>
        database.asUser(
          fx.aliceUserId,
          `insert into public.chat_session (chat_session_id, pat_id)
           values ($1, $2) returning chat_session_id`,
          [id, fx.alicePatId],
        )

      expect(await start()).toEqual([{ chat_session_id: id }])
      await expect(start()).rejects.toMatchObject(DUPLICATE)
      expect(
        await count(
          'select count(*)::int as n from public.chat_session where chat_session_id = $1',
          [id],
        ),
      ).toBe(1)
    })

    it('saves the message once under the id the browser chose, never twice', async () => {
      const id = 'd2d2d2d2-2222-4222-8222-222222222222'
      const send = () =>
        database.asUser(
          fx.aliceUserId,
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ($1, $2, 'patient', 'Is it normal to feel tired in the afternoons?')
           returning chat_message_id`,
          [id, fx.aliceChatSessionId],
        )

      expect(await send()).toEqual([{ chat_message_id: id }])
      await expect(send()).rejects.toMatchObject(DUPLICATE)
      expect(
        await count(
          `select count(*)::int as n from public.chat_message
            where chat_session_id = $1
              and chat_message_content = 'Is it normal to feel tired in the afternoons?'`,
          [fx.aliceChatSessionId],
        ),
      ).toBe(1)
    })

    it('can still find the saved message to confirm it, and only their own', async () => {
      const id = 'd2d2d2d2-2222-4222-8222-222222222222'
      expect(
        await database.asUser(
          fx.aliceUserId,
          'select chat_message_id from public.chat_message where chat_message_id = $1',
          [id],
        ),
      ).toEqual([{ chat_message_id: id }])
      // Another patient cannot confirm it - or learn it exists.
      await expectDenied(() =>
        database.asUser(
          fx.bobUserId,
          'select chat_message_id from public.chat_message where chat_message_id = $1',
          [id],
        ),
      )
    })

    it('cannot use a chosen id to write into someone else’s conversation', async () => {
      await expectDenied(() =>
        database.asUser(
          fx.bobUserId,
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ('d3d3d3d3-3333-4333-8333-333333333333', $1, 'patient', 'Not mine to write.')
           returning chat_message_id`,
          [fx.aliceChatSessionId],
        ),
      )
    })
  })

  describe('an id that is already taken', () => {
    it('is refused, never overwritten: a patient row under an id stays theirs', async () => {
      const id = 'd4d4d4d4-4444-4444-8444-444444444444'
      await database.asUser(
        fx.aliceUserId,
        `insert into public.chat_message
           (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
         values ($1, $2, 'patient', 'Holding this id.') returning chat_message_id`,
        [id, fx.aliceChatSessionId],
      )
      // A reply saved under that id - which chatbot-reply never aims for,
      // since a patient cannot work out a reply id - is refused...
      await expect(
        asServiceRole(
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ($1, $2, 'assistant', 'A reply.') returning chat_message_id`,
          [id, fx.aliceChatSessionId],
        ),
      ).rejects.toMatchObject(DUPLICATE)
      // ...and the patient's row is untouched.
      const [row] = await database.asService<{ role: string; content: string }>(
        `select chat_message_role as role, chat_message_content as content
           from public.chat_message where chat_message_id = $1`,
        [id],
      )
      expect(row).toEqual({ role: 'patient', content: 'Holding this id.' })
    })

    it('tells another patient nothing of what is saved under it', async () => {
      // Bob reuses an id Alice's message holds. He is refused as a duplicate,
      // and the refusal names the id he sent - not her conversation, not her
      // words.
      const id = 'd4d4d4d4-4444-4444-8444-444444444444'
      const [bobSession] = await database.asService<{ id: string }>(
        `insert into public.chat_session (pat_id) values ($1) returning chat_session_id as id`,
        [fx.bobPatId],
      )
      const refusal = await database
        .asUser(
          fx.bobUserId,
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ($1, $2, 'patient', 'Mine.') returning chat_message_id`,
          [id, bobSession!.id],
        )
        .then(
          () => null,
          (error: unknown) => error as { code?: string; message?: string; detail?: string },
        )
      expect(refusal).toMatchObject(DUPLICATE)
      const said = `${refusal?.message ?? ''} ${refusal?.detail ?? ''}`
      expect(said).not.toContain('Holding this id')
      expect(said).not.toContain(fx.aliceChatSessionId)
      // And he still cannot read it.
      await expectDenied(() =>
        database.asUser(
          fx.bobUserId,
          'select chat_message_content from public.chat_message where chat_message_id = $1',
          [id],
        ),
      )
    })
  })

  describe('chatbot-reply answering the same message twice', () => {
    it('saves one reply, however two requests interleave', async () => {
      const [question] = await database.asUser<{ id: string }>(
        fx.aliceUserId,
        `insert into public.chat_message (chat_session_id, chat_message_role, chat_message_content)
         values ($1, 'patient', 'How should I rest this week?') returning chat_message_id as id`,
        [fx.aliceChatSessionId],
      )
      const replyId = await replyIdFor(question!.id, KEY)
      const reply = (text: string) =>
        asServiceRole(
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ($1, $2, 'assistant', $3) returning chat_message_id`,
          [replyId, fx.aliceChatSessionId, text],
        )

      expect(await reply('Rest when you need to.')).toEqual([{ chat_message_id: replyId }])
      // The second request, a retry or another device, is refused...
      await expect(reply('A second answer.')).rejects.toMatchObject(DUPLICATE)
      // ...so the conversation holds the one reply.
      expect(
        await count(
          'select count(*)::int as n from public.chat_message where chat_message_id = $1',
          [replyId],
        ),
      ).toBe(1)
      const [saved] = await database.asService<{ content: string }>(
        'select chat_message_content as content from public.chat_message where chat_message_id = $1',
        [replyId],
      )
      expect(saved!.content).toBe('Rest when you need to.')
    })

    it('answers a different message under a different id', async () => {
      const [question] = await database.asUser<{ id: string }>(
        fx.aliceUserId,
        `insert into public.chat_message (chat_session_id, chat_message_role, chat_message_content)
         values ($1, 'patient', 'And what about stairs?') returning chat_message_id as id`,
        [fx.aliceChatSessionId],
      )
      expect(
        await asServiceRole(
          `insert into public.chat_message
             (chat_message_id, chat_session_id, chat_message_role, chat_message_content)
           values ($1, $2, 'assistant', 'Take them slowly.') returning chat_message_id`,
          [await replyIdFor(question!.id, KEY), fx.aliceChatSessionId],
        ),
      ).toHaveLength(1)
    })
  })
})
