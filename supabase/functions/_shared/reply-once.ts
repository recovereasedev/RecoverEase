/**
 * One reply per patient message, enforced by the database.
 *
 * A check such as "is the latest message already an answer?" cannot stop two
 * requests that run at the same time - a retry overlapping a slow request,
 * or the same conversation open on two devices: both check, both find it
 * unanswered, both save. So the reply's id is not random. It is derived from
 * the id of the message it answers, and the second reply to the same message
 * collides with the first on `chat_message`'s primary key. Whichever request
 * saves second is refused by Postgres and adopts the reply that is there.
 *
 * The derivation is keyed by a server-only secret. A patient chooses the ids
 * of their own messages, so a derivation anyone could compute - a public
 * hash of the message id - would let them work out a reply's id in advance
 * and take it with a message of their own, blocking the reply. Without the
 * key the id cannot be predicted, by the patient or anyone else.
 *
 * No schema change: the primary key already exists.
 *
 * Free of `Deno` and of any database client, like `assistant.ts`, so it is
 * tested in Node; `chatbot-reply` supplies the key and the database side.
 */

/** Keeps these ids apart from anything else the same key might derive. */
const REPLY_ID_CONTEXT = 'recoverease/chat-reply-id/v1'

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The id the reply to `patientMessageId` is saved under: the same one every
 * time for the same key, and unpredictable without the key. A UUID version 8
 * (RFC 9562's custom version) carrying the first 122 bits of
 * HMAC-SHA-256(key, context + message id).
 */
export async function replyIdFor(patientMessageId: string, key: string): Promise<string> {
  if (!key) throw new Error('A reply id needs its key')
  const encoder = new TextEncoder()
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(`${REPLY_ID_CONTEXT}:${patientMessageId}`)),
  )
  const bytes = mac.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80 // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 9562 variant
  return formatUuid(bytes)
}

export type SavedMessage = {
  chat_message_id: string
  chat_session_id: string
  chat_message_role: string | null
}

/** The database side of saving a reply once; `chatbot-reply` supplies it. */
export type ReplyStore<Row extends SavedMessage> = {
  /** Inserts the reply under its id, or reports that the id is taken. */
  insert(): Promise<{ row: Row } | { duplicate: true }>
  /** The message already saved under the reply's id, if any. */
  find(): Promise<Row | null>
}

/**
 * The id was taken, but not by this conversation's assistant reply. With a
 * keyed derivation nobody can aim for it, and by chance it would take a
 * 122-bit collision. Should it happen anyway it is a failure to save: the
 * request does not claim an answer it does not have, does not show what the
 * other row says, and the doctor is asked to review the conversation.
 */
export class ReplyIdConflictError extends Error {
  constructor() {
    super('The reply id is taken by a different message')
    this.name = 'ReplyIdConflictError'
  }
}

/**
 * Saves the reply, or - when another request has already saved the reply
 * to the same message - returns that one instead. `savedHere` says which,
 * so only the request that saved the reply acts on what it says.
 */
export async function saveReplyOnce<Row extends SavedMessage>(
  store: ReplyStore<Row>,
  chatSessionId: string,
): Promise<{ row: Row; savedHere: boolean }> {
  const attempt = await store.insert()
  if ('row' in attempt) return { row: attempt.row, savedHere: true }

  const existing = await store.find()
  if (
    existing &&
    existing.chat_message_role === 'assistant' &&
    existing.chat_session_id === chatSessionId
  ) {
    return { row: existing, savedHere: false }
  }
  throw new ReplyIdConflictError()
}
