/**
 * A new random id (UUID v4) for a row the browser is about to write, chosen
 * here so that sending the same write again cannot create it twice: the
 * repeat carries the same primary key, and the database refuses it as a
 * duplicate.
 *
 * `crypto.randomUUID` is missing from some older phones still in use (iOS
 * Safari before 15.4), so the same id is built from `getRandomValues`, which
 * they have - the approach `newChatId` takes for the guidance chat.
 */
export function newRecordId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 9562 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Postgres's "duplicate key" error, as PostgREST reports it. */
export function isDuplicateKey(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505'
}
