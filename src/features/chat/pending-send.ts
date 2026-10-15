/**
 * Messages the patient has sent whose save is not yet confirmed.
 *
 * Each logical submission gets its ids once, in the browser, and keeps them
 * until the save is confirmed - through retries, through the patient editing
 * the text, and through a refresh or reopening the app. Every attempt to
 * send it uses the same message id, so the database's primary key lets at
 * most one version of it be saved, whichever attempt lands.
 *
 * Only ids are kept in browser storage, never what the patient wrote. The
 * text lives in memory only, for as long as the page is open.
 */

export type PendingSend = {
  /** The id the message is saved under, whatever its final text. */
  messageId: string
  /** The conversation it goes to; null to start a new one. */
  sessionId: string | null
  /** The id a new conversation is started under, when it starts one. */
  newSessionId: string
  /** When it was first sent - old entries are let go. */
  startedAt: number
}

/** After a day an unconfirmed send is not worth reconciling any more. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function storageKey(patientId: string): string {
  return `recoverease.chat.unconfirmed-sends.v1.${patientId}`
}

function isPendingSend(value: unknown): value is PendingSend {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.messageId === 'string' &&
    (entry.sessionId === null || typeof entry.sessionId === 'string') &&
    typeof entry.newSessionId === 'string' &&
    typeof entry.startedAt === 'number'
  )
}

/**
 * The patient's unconfirmed sends. Storage can be missing, full or blocked
 * (a private window); then there is simply nothing remembered across a
 * refresh, and everything still works within the page.
 */
export function loadPendingSends(patientId: string, now = Date.now()): PendingSend[] {
  try {
    const raw = localStorage.getItem(storageKey(patientId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPendingSend).filter((entry) => now - entry.startedAt < MAX_AGE_MS)
  } catch {
    return []
  }
}

function store(patientId: string, entries: PendingSend[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(storageKey(patientId))
    else localStorage.setItem(storageKey(patientId), JSON.stringify(entries))
  } catch {
    // Not remembered across a refresh; nothing else depends on it.
  }
}

/** Remembers a send until its save is confirmed. */
export function rememberPendingSend(patientId: string, entry: PendingSend): void {
  const others = loadPendingSends(patientId).filter((e) => e.messageId !== entry.messageId)
  store(patientId, [...others, entry])
}

/** Lets a send go: its save is confirmed, or it is known not to have happened. */
export function forgetPendingSend(patientId: string, messageId: string): void {
  store(
    patientId,
    loadPendingSends(patientId).filter((entry) => entry.messageId !== messageId),
  )
}

/**
 * The unconfirmed send that belongs to the conversation on screen, if any:
 * one sent to it, or the one that started it. A send to this conversation
 * reuses its ids - it is the same submission, edited or not - rather than
 * becoming a second one.
 */
export function pendingSendFor(
  entries: PendingSend[],
  conversationId: string | null,
): PendingSend | undefined {
  return entries.find(
    (entry) =>
      entry.sessionId === conversationId || entry.newSessionId === conversationId,
  )
}
