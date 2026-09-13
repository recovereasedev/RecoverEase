/*
 * RecoverEase service worker.
 *
 * It exists for two things only: to make RecoverEase installable as an app,
 * and to show an honest page when a screen is opened with no connection. It
 * deliberately does nothing else.
 *
 * - Page loads go to the network, every time. Only when the network cannot be
 *   reached is the offline page shown instead. No page is ever kept, so the
 *   next load after a deployment is always the deployed version.
 * - Every other request - the app's own code, the Supabase API, sign-in - is
 *   left entirely to the browser. Nothing is intercepted and no response is
 *   stored, so no clinical record, token or session can end up in a cache.
 * - The only thing stored is the offline page, which is self-contained and
 *   holds no data.
 *
 * Changing this file (VERSION, for instance) is what installs a new worker;
 * the new one removes the old one's storage when it takes over.
 */

const VERSION = 'v1'
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
