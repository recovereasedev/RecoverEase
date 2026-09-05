/**
 * A short message that has to survive one redirect.
 *
 * Router state does not, in the one case that needs it. When the session
 * cannot be rebuilt after a password change the application signs out, and
 * the route guard immediately redirects to the sign-in page on its own — a
 * navigation nobody passed state to. Anything attached to the deliberate
 * `navigate` call is replaced by the guard's before it is ever rendered.
 *
 * So the message is left where a redirect cannot touch it and picked up on
 * arrival. It is read once and removed, so a reload does not repeat news
 * about something that already happened.
 *
 * Only ever plain UI copy written by the application. No credential, token
 * or personal detail goes in here — `sessionStorage` is readable by any
 * script running on the origin.
 */
const KEY = 'recoverease.flash'

export function setFlash(message: string): void {
  try {
    sessionStorage.setItem(KEY, message)
  } catch {
    // Private modes and storage-blocked browsers throw. The message is a
    // courtesy; losing it must not break the navigation it accompanies.
  }
}

export function takeFlash(): string | null {
  try {
    const message = sessionStorage.getItem(KEY)
    if (message) sessionStorage.removeItem(KEY)
    return message
  } catch {
    return null
  }
}
