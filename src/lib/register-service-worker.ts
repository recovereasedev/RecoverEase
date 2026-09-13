/**
 * Registers the service worker that makes RecoverEase installable
 * (`public/sw.js`).
 *
 * Production builds only: in development Vite serves modules on demand and a
 * worker would only get in the way. A failed registration is not something
 * the user can act on - the app works exactly as it did without one - so it
 * is swallowed rather than reported.
 */
export function registerServiceWorker({
  container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined,
  isProduction = import.meta.env.PROD,
}: {
  container?: ServiceWorkerContainer | undefined
  isProduction?: boolean
} = {}): void {
  if (!isProduction || !container) return

  const register = () => {
    // `updateViaCache: 'none'` has the browser ask the server for a newer
    // worker on every visit instead of trusting its own HTTP cache.
    container
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => undefined)
  }

  // After load, so registering never competes with the first screen.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
