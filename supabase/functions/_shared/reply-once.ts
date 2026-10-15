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
 * No schema change: the primary key already exists.
 *
 * Free of `Deno` and of any database client, like `assistant.ts`, so it is
 * tested in Node; `chatbot-reply` supplies the database side.
 */

/**
 * The namespace reply ids are derived in. Fixed: changing it would let a
 * request deployed after the change answer a message a request deployed
 * before it had already answered.
 */
export const REPLY_ID_NAMESPACE = '2f6b8d0e-6f3c-4c6a-9a51-6e1d7c3b9f42'

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a UUID: ${uuid}`)
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A name-based UUID, version 5 (RFC 9562): SHA-1 of the namespace and the name. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(16 + nameBytes.length)
  input.set(uuidBytes(namespace), 0)
  input.set(nameBytes, 16)

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input))
  const bytes = hash.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 9562 variant
  return formatUuid(bytes)
}

/** The id the reply to `patientMessageId` is saved under - always the same one. */
export function replyIdFor(patientMessageId: string): Promise<string> {
  return uuidV5(REPLY_ID_NAMESPACE, patientMessageId)
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
 * The id was taken, but not by this conversation's assistant reply. By
 * chance it cannot happen in practice; it would take a patient deliberately
 * saving one of their own messages under the id of its reply. Either way it
 * is a failure to save - the request does not claim an answer it does not
 * have, and the doctor is asked to review the conversation.
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
