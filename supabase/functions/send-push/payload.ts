/**
 * What a patient's lock screen shows: one of two fixed sentences, chosen by
 * what the notification is for. No medicine, dose, doctor, diagnosis, date
 * or time - anyone who picks up the phone sees only that RecoverEase has
 * something. The detail is one tap and one sign-in away, inside the app.
 *
 *   a medication or appointment reminder -> "You have a reminder in RecoverEase."
 *   an appointment cancelled             -> "You have an appointment update in RecoverEase."
 *
 * A cancellation is never worded as a reminder. The sentence is not even
 * sent: the message carries only `purpose`, and `public/sw.js` holds the
 * words (tests/unit/web-push-service-worker.test.ts keeps the two in step),
 * so nothing that reaches the phone can put other words on its screen.
 *
 * Built from the queue's `push_kind` alone; the notification's own text is
 * never read (migration 53).
 */

export type PushKind = 'medication_reminder' | 'appointment_reminder' | 'appointment_update'
export type PushPurpose = 'reminder' | 'appointment_update'

export const PUSH_TITLE = 'RecoverEase'
export const PUSH_BODIES: Record<PushPurpose, string> = {
  reminder: 'You have a reminder in RecoverEase.',
  appointment_update: 'You have an appointment update in RecoverEase.',
}

const KINDS: Record<PushKind, { purpose: PushPurpose; url: string }> = {
  medication_reminder: { purpose: 'reminder', url: '/patient/medications' },
  appointment_reminder: { purpose: 'reminder', url: '/patient/appointments' },
  appointment_update: { purpose: 'appointment_update', url: '/patient/appointments' },
}

/** The pages a tap may open. All require signing in; none is written to. */
export const PUSH_URLS = [...new Set(Object.values(KINDS).map((kind) => kind.url))]

export type PushPayload = {
  purpose: PushPurpose
  url: string
  /** Same tag, same notification: a repeat replaces rather than stacks. */
  tag: string
}

export function isPushKind(kind: string): kind is PushKind {
  return Object.prototype.hasOwnProperty.call(KINDS, kind)
}

/** Null for a kind this function does not know: nothing is sent for it. */
export function buildPushPayload(kind: string, notificationId: string): PushPayload | null {
  if (!isPushKind(kind)) return null
  return { ...KINDS[kind], tag: `recoverease-${notificationId}` }
}
