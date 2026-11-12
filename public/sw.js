/*
 * RecoverEase service worker.
 *
 * It exists for three things only: to make RecoverEase installable as an
 * app, to show an honest page when a screen is opened with no connection, and
 * to show a patient's reminder notification while the app is closed (Web
 * Push, migration 53). It deliberately does nothing else.
 *
 * - Page loads go to the network, every time. Only when the network cannot be
 *   reached is the offline page shown instead. No page is ever kept, so the
 *   next load after a deployment is always the deployed version.
 * - Every other request - the app's own code, the Supabase API, sign-in - is
 *   left entirely to the browser. Nothing is intercepted and no response is
 *   stored, so no clinical record, token or session can end up in a cache.
 * - The only thing stored is the offline page, which is self-contained and
 *   holds no data.
 * - A push shows a generic notification - never a medicine, dose, doctor or
 *   time - and a tap opens one of a few signed-in pages. The worker reads and
 *   writes no record: nothing is marked taken from a notification.
 *
 * Changing this file (VERSION, for instance) is what installs a new worker;
 * the new one removes the old one's storage when it takes over.
 */

const VERSION = 'v2'
const CACHE = `recoverease-offline-${VERSION}`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `reload` skips the HTTP cache, so the stored page is the deployed one.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('recoverease-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Anything but a page load is the browser's business: API calls, sign-in,
  // the app's own code. Not calling respondWith leaves it untouched.
  if (request.mode !== 'navigate' || request.method !== 'GET') return

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL).then((page) => page || Response.error()),
    ),
  )
})

// ---------------------------------------------------------------------------
// Web Push (migration 53)
// ---------------------------------------------------------------------------
// The server sends { purpose, url, tag } (supabase/functions/send-push/
// payload.ts) - no words at all. The words shown are the fixed ones below,
// chosen by `purpose`: a reminder, or an appointment update (a cancellation,
// which is never worded as a reminder). A title or body in the message is
// ignored, an unknown or unreadable message gets the neutral sentence, and a
// tap can only open a page on this list. So no message, however malformed,
// can put clinical words on a lock screen or send the patient somewhere else.

const PUSH_TITLE = 'RecoverEase'
const PUSH_BODIES = {
  reminder: 'You have a reminder in RecoverEase.',
  appointment_update: 'You have an appointment update in RecoverEase.',
}
const PUSH_NEUTRAL_BODY = 'You have a new notification in RecoverEase.'
const PUSH_FALLBACK_URL = '/patient/notifications'
const PUSH_URLS = ['/patient/medications', '/patient/appointments', PUSH_FALLBACK_URL]

function readPush(data) {
  let message = {}
  try {
    message = (data && data.json()) || {}
  } catch {
    message = {}
  }
  const known = typeof message.purpose === 'string' && Object.keys(PUSH_BODIES).includes(message.purpose)
  return {
    title: PUSH_TITLE,
    body: known ? PUSH_BODIES[message.purpose] : PUSH_NEUTRAL_BODY,
    url: PUSH_URLS.includes(message.url) ? message.url : PUSH_FALLBACK_URL,
    tag: typeof message.tag === 'string' && /^recoverease-[\w-]{1,64}$/.test(message.tag)
      ? message.tag
      : 'recoverease-reminder',
  }
}

self.addEventListener('push', (event) => {
  const push = readPush(event.data)
  event.waitUntil(
    self.registration.showNotification(push.title, {
      body: push.body,
      tag: push.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: push.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const wanted = event.notification.data && event.notification.data.url
  const url = PUSH_URLS.includes(wanted) ? wanted : PUSH_FALLBACK_URL

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Reuse an open RecoverEase window rather than stacking another. The
      // app's own sign-in guard decides what it shows.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) {
        return open
          .focus()
          .then((focused) => (focused || open).navigate(url))
          .catch(() => self.clients.openWindow(url))
      }
      return self.clients.openWindow(url)
    }),
  )
})
