import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createInstallPromptStore,
  INSTALL_PROMPT_DISMISSED_KEY,
  isAppInstalled,
  isIosDevice,
  isIosSafari,
  rememberInstallPromptDismissed,
  wasInstallPromptDismissed,
  type InstallPromptEvent,
} from '@/lib/pwa-install'

/**
 * What the install popup is built on: whether this window is the installed
 * app, what the device can do about installing it, where a dismissal is kept,
 * and the browser's own install event held until the person asks for it.
 */

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'
const IPAD_OS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** A window reporting one display mode, and optionally Safari's own flag. */
function browserWindow({
  displayMode,
  iosStandalone,
}: { displayMode?: string; iosStandalone?: boolean } = {}): Window {
  return {
    matchMedia: (query: string) =>
      ({ matches: displayMode !== undefined && query.includes(displayMode) }) as MediaQueryList,
    navigator: { standalone: iosStandalone } as unknown as Navigator,
  } as unknown as Window
}

function navigatorFor(
  userAgent: string,
  { platform = 'Win32', maxTouchPoints = 0 } = {},
): Navigator {
  return { userAgent, platform, maxTouchPoints } as Navigator
}

/** A window whose session storage is a plain map. */
function windowWithStorage(): Window & { stored: Map<string, string> } {
  const stored = new Map<string, string>()
  return {
    stored,
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value)
      },
    } as unknown as Storage,
  } as unknown as Window & { stored: Map<string, string> }
}

/** Chrome's event, as far as the code under test is concerned. */
function installEvent(target: EventTarget): InstallPromptEvent {
  const event = new Event('beforeinstallprompt', {
    cancelable: true,
  }) as InstallPromptEvent
  Object.assign(event, {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('knowing whether this window is the installed app', () => {
  it('is the app in every display mode an installed RecoverEase runs in', () => {
    for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
      expect(isAppInstalled(browserWindow({ displayMode: mode })), mode).toBe(true)
    }
  })

  it('is the app where Safari reports it the older way', () => {
    expect(isAppInstalled(browserWindow({ iosStandalone: true }))).toBe(true)
  })

  it('is a visit to the website in an ordinary browser tab', () => {
    expect(isAppInstalled(browserWindow())).toBe(false)
    expect(isAppInstalled(browserWindow({ iosStandalone: false }))).toBe(false)
  })

  it('does not fall over where the browser has no matchMedia', () => {
    const window = { navigator: {} as Navigator } as unknown as Window
    expect(isAppInstalled(window)).toBe(false)
  })
})

describe('knowing what the device can install with', () => {
  it('recognises an iPhone', () => {
    expect(isIosDevice(navigatorFor(IPHONE))).toBe(true)
  })

  it('recognises an iPad calling itself a Mac, by its touch screen', () => {
    expect(
      isIosDevice(navigatorFor(IPAD_OS, { platform: 'MacIntel', maxTouchPoints: 5 })),
    ).toBe(true)
  })

  it('does not mistake a Mac for an iPad', () => {
    expect(
      isIosDevice(navigatorFor(IPAD_OS, { platform: 'MacIntel', maxTouchPoints: 0 })),
    ).toBe(false)
  })

  it('is not an iOS device on a Windows browser', () => {
    expect(isIosDevice(navigatorFor(WINDOWS_CHROME))).toBe(false)
    expect(isIosSafari(navigatorFor(WINDOWS_CHROME))).toBe(false)
  })

  it('tells Safari on iOS from the other browsers there', () => {
    expect(isIosSafari(navigatorFor(IPHONE))).toBe(true)
    expect(isIosSafari(navigatorFor(IPHONE_CHROME))).toBe(false)
  })
})

describe('remembering that the offer was answered', () => {
  it('remembers it for this visit, in session storage', () => {
    const window = windowWithStorage()

    expect(wasInstallPromptDismissed(window)).toBe(false)
    rememberInstallPromptDismissed(window)

    expect(wasInstallPromptDismissed(window)).toBe(true)
    expect(window.stored.get(INSTALL_PROMPT_DISMISSED_KEY)).toBe('1')
  })

  it('never writes it anywhere that outlives the visit', () => {
    const localStorage = { setItem: vi.fn(), getItem: vi.fn() }
    const window = windowWithStorage() as Window & { stored: Map<string, string> }
    Object.assign(window, { localStorage })

    rememberInstallPromptDismissed(window)

    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('carries on where the browser has blocked site data', () => {
    const window = {
      get sessionStorage(): Storage {
        throw new Error('access denied')
      },
    } as unknown as Window

    expect(() => rememberInstallPromptDismissed(window)).not.toThrow()
    expect(wasInstallPromptDismissed(window)).toBe(false)
  })
})

describe('holding the browser’s install event', () => {
  it('keeps the event and takes the browser’s own bar out of the way', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()

    const event = installEvent(target)

    expect(store.get()).toBe(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('tells the popup when one arrives', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()
    const listener = vi.fn()
    store.subscribe(listener)

    installEvent(target)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops the event once it has been used, because it may only be used once', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()
    installEvent(target)
    const listener = vi.fn()
    store.subscribe(listener)

    store.clear()

    expect(store.get()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops the event when the app is installed', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()
    installEvent(target)

    target.dispatchEvent(new Event('appinstalled'))

    expect(store.get()).toBeNull()
  })

  it('holds one event however many times it is started', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    const listener = vi.fn()
    store.subscribe(listener)

    store.start()
    store.start()
    installEvent(target)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing once stopped', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()
    store.stop()

    installEvent(target)

    expect(store.get()).toBeNull()
  })

  it('has nothing to offer where the browser never offers one', () => {
    const store = createInstallPromptStore(new EventTarget())
    store.start()

    expect(store.get()).toBeNull()
  })

  it('stops a listener that has unsubscribed', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.start()
    const listener = vi.fn()
    store.subscribe(listener)()

    installEvent(target)

    expect(listener).not.toHaveBeenCalled()
  })
})
