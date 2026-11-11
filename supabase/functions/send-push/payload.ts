/**
 * What a patient's lock screen shows. The same few words for every
 * reminder: no medicine, dose, doctor, diagnosis or time - anyone who picks
 * up the phone sees only that RecoverEase has something. The detail is one
 * tap and one sign-in away, inside the app.
 *
 * Built from the queue's `push_kind` alone; the notification's own text is
 * never read (migration 53). `public/sw.js` holds the same allow-list of
 * pages and the same fallback words, for a message it cannot read
 * (tests/unit/web-push-service-worker.test.ts keeps the two in step).
 */

export type PushKind = 'medication' | 'appointment'

export const PUSH_TITLE = 'RecoverEase'
export const PUSH_BODY = 'You have a reminder in RecoverEase.'

/** The page a tap opens. Both require signing in; neither is written to. */
export const PUSH_URLS: Record<PushKind, string> = {
  medication: '/patient/medications',
  appointment: '/patient/appointments',
}

export type PushPayload = {
  title: string
  body: string
  url: string
  /** Same tag, same notification: a repeat replaces rather than stacks. */
  tag: string
}

export function buildPushPayload(kind: string, notificationId: string): PushPayload {
  const url = PUSH_URLS[kind as PushKind] ?? '/patient/notifications'
  return {
    title: PUSH_TITLE,
    body: PUSH_BODY,
    url,
    tag: `recoverease-${notificationId}`,
  }
}
