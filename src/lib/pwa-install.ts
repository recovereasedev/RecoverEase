/**
 * What RecoverEase needs in order to offer installing itself as an app: is it
 * already installed, what can this device do about installing it, and the
 * browser's own install event, held back until the person actually asks.
 *
 * Nothing here installs anything. Only the browser can do that, and only
 * through the event it hands over in `beforeinstallprompt`. Where that event
 * is not offered — Safari on iPhone and iPad, and every browser that cannot
 * install at all — the answer is instructions or an honest "not from here",
 * never an imitation of the browser's own prompt.
 *
 * The popup that uses all of this lives in
 * `src/components/layout/install-app-prompt.tsx`.
 */

/**
 * Chrome's `beforeinstallprompt`, which the DOM type definitions do not carry
 * because it is not a standard.
 */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>
}

/**
 * Display modes an installed RecoverEase can be running in. `standalone` is
 * what the manifest asks for; a browser may honour a request with a nearby
 * mode, and in all of them the app is installed rather than being visited.
 */
const INSTALLED_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui'] as const

/**
 * Whether this page is the installed app rather than a visit to the website.
 *
 * A browser tab cannot be asked whether the app is installed *somewhere* —
 * only whether this window is it. That is the question the popup needs.
 */
export function isAppInstalled(win: Window = window): boolean {
  const asApp = INSTALLED_DISPLAY_MODES.some(
    (mode) => win.matchMedia?.(`(display-mode: ${mode})`).matches === true,
  )

  // Safari predates `display-mode` and reports the same fact here instead.
  const iosAsApp =
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true

  return asApp || iosAsApp
}

/**
 * `navigator.getInstalledRelatedApps()`, which the DOM type definitions do not
 * carry: it is Chromium-only, and not on a standards track everywhere.
 */
type RelatedApplication = {
  platform?: string
  url?: string
  id?: string
  version?: string
}

type NavigatorWithRelatedApps = Navigator & {
  getInstalledRelatedApps?: () => Promise<RelatedApplication[]>
}

/** The manifest path this app is served from, on any of its hosts. */
const MANIFEST_PATH = '/manifest.webmanifest'

/**
 * The web-app relationship declared in `public/manifest.webmanifest`. A
 * browser only reports an installed related app that the manifest claims a
 * relationship with, so the two have to say the same thing.
 */
export const RELATED_WEB_APP_MANIFEST_URL =
  'https://recoverease-web.vercel.app/manifest.webmanifest'

/** Whether a reported related app is RecoverEase itself. */
function isRecoverEase(app: RelatedApplication, win: Window): boolean {
  if (app.platform !== 'webapp' || !app.url) return false

  try {
    const manifest = new URL(app.url, win.location.href)
    if (manifest.pathname !== MANIFEST_PATH) return false

    // The relationship the manifest declares, or this deployment's own
    // manifest — a preview build is the same app under another host.
    return (
      manifest.href === RELATED_WEB_APP_MANIFEST_URL ||
      manifest.origin === win.location.origin
    )
  } catch {
    return false
  }
}

/**
 * Whether RecoverEase is already installed on this device, asked of the
 * browser rather than of this window.
 *
 * `isAppInstalled` can only answer for the window it is running in, so a
 * person who installed RecoverEase and later opened the website in an
 * ordinary tab would be offered the installation again. Chromium can answer
 * the wider question; everything else cannot, and says so by not having the
 * method at all.
 *
 * Every failure — no method, a rejected promise, a browser that throws, an
 * answer in an unexpected shape — is answered `false`, which leaves the
 * existing behaviour exactly as it was. Nothing here may keep the popup from
 * working, let alone the site.
 */
export async function isAppInstalledElsewhere(
  win: Window = window,
): Promise<boolean> {
  const query = (win.navigator as NavigatorWithRelatedApps)
    .getInstalledRelatedApps

  if (typeof query !== 'function') return false

  try {
    const installed = await query.call(win.navigator)
    if (!Array.isArray(installed)) return false

    return installed.some((app) => Boolean(app) && isRecoverEase(app, win))
  } catch {
    return false
  }
}

/**
 * Whether this browser has an install event of its own at all.
 *
 * `beforeinstallprompt` is defined on the window object in every browser that
 * implements it, whether or not one has fired yet. The difference matters to
 * what the popup says: a Chromium browser that has simply not offered the
 * event on this page can still install RecoverEase from its own menu, and
 * telling that person the browser "cannot install RecoverEase" would be
 * false.
 */
export function supportsInstallPromptEvent(win: Window = window): boolean {
  return 'onbeforeinstallprompt' in win
}

/** An iPhone or iPad, where installing means "Add to Home Screen". */
export function isIosDevice(nav: Navigator = navigator): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true

  // An iPad on iPadOS 13 and later calls itself a Mac. A Mac has no touch
  // screen, which is what tells the two apart.
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1
}

/**
 * Whether an iOS device is in Safari, the only browser on iOS that can add a
 * site to the home screen. The others are worth naming that fact to.
 */
export function isIosSafari(nav: Navigator = navigator): boolean {
  return isIosDevice(nav) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(nav.userAgent)
}

/**
 * Where a dismissal is remembered.
 *
 * `sessionStorage`, deliberately, and never `localStorage`: "Maybe later"
 * means later, so the offer comes back on the next visit. Within one visit it
 * survives a reload and every page in the app, so nobody is asked twice.
 */
export const INSTALL_PROMPT_DISMISSED_KEY = 'recoverease.install-prompt.dismissed'

/**
 * Storage throws rather than returning null where the browser has blocked
 * site data, so every use of it is guarded. A browser that cannot remember
 * the dismissal shows the popup once per page instead of once per visit,
 * which is the mildest possible failure.
 */
function visitStorage(win: Window): Storage | undefined {
  try {
    return win.sessionStorage
  } catch {
    return undefined
  }
}

export function wasInstallPromptDismissed(win: Window = window): boolean {
  try {
    return visitStorage(win)?.getItem(INSTALL_PROMPT_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberInstallPromptDismissed(win: Window = window): void {
  try {
    visitStorage(win)?.setItem(INSTALL_PROMPT_DISMISSED_KEY, '1')
  } catch {
    // Nothing the person can act on, and nothing that stops the app working.
  }
}

/** Holds the browser's install event until the popup asks for it. */
export type InstallPromptStore = {
  /** Begins listening. Calling it again while listening does nothing. */
  start: () => void
  stop: () => void
  /** The held event, or `null` where the browser has not offered one. */
  get: () => InstallPromptEvent | null
  /** Drops the held event; the browser allows exactly one use of it. */
  clear: () => void
  subscribe: (listener: () => void) => () => void
}

export function createInstallPromptStore(
  target: EventTarget | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): InstallPromptStore {
  let deferred: InstallPromptEvent | null = null
  let stopListening: (() => void) | null = null
  const listeners = new Set<() => void>()

  const publish = () => {
    for (const listener of listeners) listener()
  }

  const onBeforeInstallPrompt = (event: Event) => {
    // Preventing the default is what keeps the browser's own bar out of the
    // way and lets RecoverEase ask in its own words, when the person asks.
    event.preventDefault()
    deferred = event as InstallPromptEvent
    publish()
  }

  const onAppInstalled = () => {
    // Installed: the event is spent and will not be offered again.
    deferred = null
    publish()
  }

  return {
    start() {
      if (stopListening || !target) return

      target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      target.addEventListener('appinstalled', onAppInstalled)

      stopListening = () => {
        target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
        target.removeEventListener('appinstalled', onAppInstalled)
      }
    },

    stop() {
      stopListening?.()
      stopListening = null
    },

    get: () => deferred,

    clear() {
      if (deferred === null) return
      deferred = null
      publish()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * How long to give the browser to hand over its install event after someone
 * has asked to install.
 *
 * Chromium decides for itself when to offer `beforeinstallprompt`, and it can
 * arrive after the page has settled — or after the person has already pressed
 * Install. Treating "not here yet" as "this browser cannot install" is what
 * put an installable Chrome in front of instructions it did not need.
 */
export const INSTALL_PROMPT_GRACE_MS = 2000

/**
 * The held event, or the next one to arrive within `timeoutMs`, or `null`.
 *
 * It waits on the store's own notifications rather than asking again and
 * again: nothing here polls, and the wait ends as soon as an event lands.
 */
export function waitForInstallPrompt(
  store: InstallPromptStore,
  timeoutMs: number = INSTALL_PROMPT_GRACE_MS,
): Promise<InstallPromptEvent | null> {
  const held = store.get()
  if (held) return Promise.resolve(held)

  return new Promise((resolve) => {
    let settled = false

    const finish = (event: InstallPromptEvent | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    }

    const unsubscribe = store.subscribe(() => {
      const arrived = store.get()
      if (arrived) finish(arrived)
    })

    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * The store the application uses, started in `src/main.tsx` before the first
 * render: Chrome offers `beforeinstallprompt` once, early, and an offer that
 * arrives before React has mounted would otherwise be lost.
 */
export const installPromptStore = createInstallPromptStore()
