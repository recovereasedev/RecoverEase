import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  chronologicalWindow,
  HISTORY_LIMIT,
} from '../../supabase/functions/_shared/assistant'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * The guidance assistant's history read, against PostgreSQL.
 *
 * `chatbot-reply` asks PostgREST for this conversation's messages ordered by
 * `chat_message_created_at desc, chat_message_id desc` and limited to the
 * window; this is the same statement. It runs as the service role, as the
 * function does, after the function has proved the conversation is the
 * caller's.
 */
describe('reading a conversation’s newest messages', () => {
  let database: TestDatabase
  let fx: Fixture
  let sessionId: string

  const HISTORY_QUERY = `
    select chat_message_role, chat_message_content, chat_message_created_at
      from public.chat_message
     where chat_session_id = $1
     order by chat_message_created_at desc, chat_message_id desc
     limit $2`

  type Row = {
    chat_message_role: string
    chat_message_content: string
    chat_message_created_at: string
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)

    const [session] = await database.asService<{ id: string }>(
      `insert into public.chat_session (pat_id) values ($1) returning chat_session_id as id`,
      [fx.alicePatId],
    )
    sessionId = session!.id

    // Fifty messages a second apart, ending on the patient, except that
    // messages 45 and 46 share a timestamp.
    await database.asService(
      `insert into public.chat_message
         (chat_session_id, chat_message_role, chat_message_content, chat_message_created_at)
       select $1,
              case when n % 2 = 0 then 'patient' else 'assistant' end,
              'Message ' || n,
              timestamptz '2026-09-01 00:00:00+00'
                + make_interval(secs => case when n = 46 then 45 else n end)
         from generate_series(1, 50) as n`,
      [sessionId],
    )
  })

  afterAll(async () => {
    await database?.close()
  })

  const read = async () =>
    chronologicalWindow(
      await database.asService<Row>(HISTORY_QUERY, [sessionId, HISTORY_LIMIT]),
    )

  it('returns the newest forty of this conversation, oldest first', async () => {
    const window = await read()
    const numbers = window.map((row) => Number(row.chat_message_content.replace('Message ', '')))

    expect(window).toHaveLength(40)
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 11),
    )
    expect(window.at(-1)).toMatchObject({
      chat_message_role: 'patient',
      chat_message_content: 'Message 50',
    })

    const times = window.map((row) => new Date(row.chat_message_created_at).getTime())
    expect(times.every((time, index) => index === 0 || time >= times[index - 1]!)).toBe(true)
  })

  it('never includes another conversation’s messages, even newer ones', async () => {
    // The fixture's own conversation for Alice holds a message written now,
    // newer than every message above.
    const window = await read()

    expect(window.map((row) => row.chat_message_content)).not.toContain(
      'Is swelling normal after two weeks?',
    )
  })

  it('returns the same window every time, identical timestamps included', async () => {
    const first = await read()
    const second = await read()

    expect(second).toEqual(first)
  })

  it('leaves every stored message in place', async () => {
    await read()

    const [count] = await database.asService<{ n: number }>(
      `select count(*)::int as n from public.chat_message where chat_session_id = $1`,
      [sessionId],
    )
    expect(count!.n).toBe(50)
  })
})
