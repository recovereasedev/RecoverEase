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
 * The store the application uses, started in `src/main.tsx` before the first
 * render: Chrome offers `beforeinstallprompt` once, early, and an offer that
 * arrives before React has mounted would otherwise be lost.
 */
export const installPromptStore = createInstallPromptStore()
