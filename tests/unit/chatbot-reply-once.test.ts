import { describe, expect, it } from 'vitest'

import {
  REPLY_ID_NAMESPACE,
  ReplyIdConflictError,
  replyIdFor,
  saveReplyOnce,
  type ReplyStore,
  type SavedMessage,
  uuidV5,
} from '../../supabase/functions/_shared/reply-once'

/**
 * One reply per patient message (`_shared/reply-once.ts`). The reply is
 * saved under an id derived from the message it answers, so the database's
 * primary key - not a check that a concurrent request can slip past - is
 * what refuses a second reply. `tests/db/chat-idempotency.test.ts` shows
 * Postgres refusing the duplicate; this shows the function's side of it.
 */

describe('uuidV5', () => {
  it('matches the published RFC 9562 example', async () => {
    // RFC 9562 appendix A.4, and Python's uuid.uuid5(NAMESPACE_DNS, ...).
    expect(await uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    )
  })
})

describe('replyIdFor', () => {
  const message = 'c1c1c1c1-1111-4111-8111-111111111111'

  it('gives the same message the same reply id, every time', async () => {
    expect(await replyIdFor(message)).toBe(await replyIdFor(message))
  })

  it('gives different messages different reply ids', async () => {
    expect(await replyIdFor(message)).not.toBe(
      await replyIdFor('c2c2c2c2-2222-4222-8222-222222222222'),
    )
  })

  it('is a valid UUID that is not the message’s own id', async () => {
    const id = await replyIdFor(message)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).not.toBe(message)
    expect(id).not.toBe(REPLY_ID_NAMESPACE)
  })
})

type Row = SavedMessage & { chat_message_content: string }

/**
 * A table with a primary key, like `chat_message`. Every call yields first,
 * so concurrent saves interleave the way two requests do.
 */
function table() {
  const rows = new Map<string, Row>()
  let inserts = 0
  const store = (id: string, row: Omit<Row, 'chat_message_id'>): ReplyStore<Row> => ({
    async insert() {
      await Promise.resolve()
      inserts += 1
      if (rows.has(id)) return { duplicate: true }
      const saved = { chat_message_id: id, ...row }
      rows.set(id, saved)
      return { row: saved }
    },
    async find() {
      await Promise.resolve()
      return rows.get(id) ?? null
    },
  })
  return { rows, store, inserts: () => inserts }
}

describe('saveReplyOnce', () => {
  const session = 's1s1s1s1-1111-4111-8111-111111111111'

  it('saves a reply that is not there yet', async () => {
    const db = table()
    const id = await replyIdFor('m1')
    const result = await saveReplyOnce(
      db.store(id, { chat_session_id: session, chat_message_role: 'assistant', chat_message_content: 'A' }),
      session,
    )
    expect(result.savedHere).toBe(true)
    expect(db.rows.size).toBe(1)
  })

  it('saves one reply when two requests answer the same message at once', async () => {
    const db = table()
    const id = await replyIdFor('m1')
    const [first, second] = await Promise.all([
      saveReplyOnce(
        db.store(id, { chat_session_id: session, chat_message_role: 'assistant', chat_message_content: 'First answer' }),
        session,
      ),
      saveReplyOnce(
        db.store(id, { chat_session_id: session, chat_message_role: 'assistant', chat_message_content: 'Second answer' }),
        session,
      ),
    ])

    // Both requests tried to save; the table holds one reply, and both
    // requests return that same one.
    expect(db.inserts()).toBe(2)
    expect(db.rows.size).toBe(1)
    expect(first.row).toEqual(second.row)
    expect([first.savedHere, second.savedHere].sort()).toEqual([false, true])
  })

  it('does not adopt a message that is not this conversation’s assistant reply', async () => {
    const db = table()
    const id = await replyIdFor('m1')
    // Something else already holds the id: a patient message, deliberately.
    db.rows.set(id, {
      chat_message_id: id,
      chat_session_id: session,
      chat_message_role: 'patient',
      chat_message_content: 'Not a reply',
    })
    await expect(
      saveReplyOnce(
        db.store(id, { chat_session_id: session, chat_message_role: 'assistant', chat_message_content: 'A' }),
        session,
      ),
    ).rejects.toBeInstanceOf(ReplyIdConflictError)

    // Nor a reply in a different conversation.
    db.rows.set(id, {
      chat_message_id: id,
      chat_session_id: 'other-session',
      chat_message_role: 'assistant',
      chat_message_content: 'Elsewhere',
    })
    await expect(
      saveReplyOnce(
        db.store(id, { chat_session_id: session, chat_message_role: 'assistant', chat_message_content: 'A' }),
        session,
      ),
    ).rejects.toBeInstanceOf(ReplyIdConflictError)
  })
})
