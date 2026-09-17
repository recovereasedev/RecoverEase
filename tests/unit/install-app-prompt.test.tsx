import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { InstallAppPrompt } from '@/components/layout/install-app-prompt'
import {
  INSTALL_PROMPT_DISMISSED_KEY,
  type InstallPromptEvent,
  type InstallPromptStore,
} from '@/lib/pwa-install'

/**
 * RecoverEase's own offer to install itself as an app.
 *
 * The popup is RecoverEase's; the installation is always the browser's. Where
 * the browser has handed over its install event, Install triggers it and
 * nothing else; where it has not, the popup says what to do by hand and never
 * pretends an installation is under way.
 *
 * It is offered on a visit, once, and not at all to a window that already is
 * the installed app - nor where the browser can say RecoverEase is installed
 * on the device already. "Maybe Later" answers it for this visit only.
 */

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

beforeAll(() => {
  // jsdom has the element but not its modal behaviour.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

/**
 * A store holding whatever the browser is pretended to have offered, and able
 * to hand one over later - which is what Chromium actually does.
 */
function storeHolding(event: InstallPromptEvent | null): InstallPromptStore & {
  clear: ReturnType<typeof vi.fn>
  deliver: (event: InstallPromptEvent) => void
} {
  let held = event
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) listener()
  }

  return {
    start: vi.fn(),
    stop: vi.fn(),
    get: () => held,
    clear: vi.fn(() => {
      held = null
      publish()
    }),
    deliver: (arrived: InstallPromptEvent) => {
      held = arrived
      publish()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Chrome's event, answered the way the test asks. */
function browserPrompt(outcome: 'accepted' | 'dismissed') {
  const prompt = vi.fn(async () => undefined)
  return {
    event: { prompt, userChoice: Promise.resolve({ outcome }) } as unknown as InstallPromptEvent,
    prompt,
  }
}

/** Properties jsdom's navigator has on its prototype, overridden per test. */
const overridden: string[] = []

/** Properties put on the window itself, removed again after each test. */
const windowProperties: string[] = []

function pretendDevice(
  properties: Partial<{
    userAgent: string
    platform: string
    maxTouchPoints: number
    standalone: boolean
  }>,
) {
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(window.navigator, key, { value, configurable: true })
    overridden.push(key)
  }
}

/** Makes the browser answer `getInstalledRelatedApps` as given, or not at all. */
function pretendBrowserReports(
  getInstalledRelatedApps: (() => Promise<unknown>) | undefined,
) {
  Object.defineProperty(window.navigator, 'getInstalledRelatedApps', {
    value: getInstalledRelatedApps,
    configurable: true,
  })
  overridden.push('getInstalledRelatedApps')
}

/** Gives the window the event Chromium defines, without firing one. */
function pretendBrowserHasInstallEvent() {
  Object.defineProperty(window, 'onbeforeinstallprompt', {
    value: null,
    configurable: true,
    writable: true,
  })
  windowProperties.push('onbeforeinstallprompt')
}

const RECOVEREASE_WEB_APP = {
  platform: 'webapp',
  url: 'https://recoverease-web.vercel.app/manifest.webmanifest',
}

/** Makes `window.matchMedia` answer true for one display mode. */
function pretendRunningAs(displayMode: string) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: query.includes(displayMode) }) as MediaQueryList,
  )
}

/**
 * Let the page finish loading, the appearance delay run out, and the
 * browser's answer about installed apps come back.
 */
async function waitForTheOffer() {
  await act(async () => {
    window.dispatchEvent(new Event('load'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const popup = () => screen.queryByRole('heading', { name: 'Install RecoverEase' })
const installButton = () => screen.getByRole('button', { name: /install recoverease/i })
const maybeLater = () => screen.getByRole('button', { name: 'Maybe Later' })

beforeEach(() => {
  window.sessionStorage.clear()
  pretendDevice({ userAgent: WINDOWS_CHROME, platform: 'Win32', maxTouchPoints: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of overridden.splice(0)) {
    Reflect.deleteProperty(window.navigator, key)
  }
  for (const key of windowProperties.splice(0)) {
    Reflect.deleteProperty(window, key)
  }
})

describe('offering to install RecoverEase', () => {
  it('offers the app, in its own words, once the page has loaded', async () => {
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).toBeInTheDocument()
    expect(
      screen.getByText(
        'Install RecoverEase on your device for easier access and a more convenient experience.',
      ),
    ).toBeInTheDocument()
    expect(installButton()).toBeEnabled()
    expect(maybeLater()).toBeEnabled()
  })

  it('stays out of the way of the first screen', () => {
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={1500} />)

    expect(popup()).not.toBeInTheDocument()
  })

  it('says nothing to a window that already is the installed app', async () => {
    pretendRunningAs('standalone')

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).not.toBeInTheDocument()
  })

  it('says nothing in an installed app on iPhone, which reports it the older way', async () => {
    pretendDevice({ userAgent: IPHONE, standalone: true })

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).not.toBeInTheDocument()
  })
})

describe('when the browser can say the app is already installed', () => {
  it('says nothing where the browser reports RecoverEase installed', async () => {
    pretendBrowserReports(async () => [RECOVEREASE_WEB_APP])

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).not.toBeInTheDocument()
  })

  it('offers where the browser reports some other app installed', async () => {
    pretendBrowserReports(async () => [{ platform: 'play', id: 'com.example.other' }])

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).toBeInTheDocument()
  })

  it('offers as before where the browser has no such method', async () => {
    pretendBrowserReports(undefined)

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).toBeInTheDocument()
  })

  it('offers as before where the browser refuses to answer', async () => {
    pretendBrowserReports(async () => {
      throw new Error('not supported on this platform')
    })

    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).toBeInTheDocument()
  })
})

describe('answering the offer', () => {
  it('closes on Maybe Later, and remembers it for this visit only', async () => {
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    fireEvent.click(maybeLater())

    expect(popup()).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe('1')
    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBeNull()
  })

  it('does not come back later in the same visit', async () => {
    const { unmount } = render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />,
    )
    await waitForTheOffer()
    fireEvent.click(maybeLater())
    unmount()

    // A later page of the same visit.
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).not.toBeInTheDocument()
  })

  it('offers again on the next visit', async () => {
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()
    fireEvent.click(maybeLater())

    // A new visit is a new session, which is where the dismissal was kept.
    window.sessionStorage.clear()
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    expect(popup()).toBeInTheDocument()
  })
})

describe('installing through the browser', () => {
  it('asks the browser to install, and closes once the person has accepted', async () => {
    const { event, prompt } = browserPrompt('accepted')
    const store = storeHolding(event)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(store.clear).toHaveBeenCalled()
    expect(popup()).not.toBeInTheDocument()
  })

  it('closes, and keeps nothing, when the person declines the browser', async () => {
    const { event, prompt } = browserPrompt('dismissed')
    const store = storeHolding(event)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(store.clear).toHaveBeenCalled()
    expect(popup()).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot install RecoverEase/)).not.toBeInTheDocument()
  })

  it('steps aside as soon as the browser’s dialog is up, answer or none', async () => {
    // A dialog dismissed by a click elsewhere can leave `userChoice` pending
    // for ever. The popup must not wait on it.
    const prompt = vi.fn(async () => undefined)
    const event = {
      prompt,
      userChoice: new Promise<{ outcome: 'accepted' | 'dismissed' }>(() => {}),
    } as unknown as InstallPromptEvent
    const store = storeHolding(event)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(popup()).not.toBeInTheDocument()
    expect(store.clear).toHaveBeenCalled()
  })

  it('records the answer the moment the browser is asked', async () => {
    // Chrome closes this popup itself while its own dialog is up, without
    // telling the page. The visit must still know it was answered.
    const prompt = vi.fn(async () => undefined)
    const event = {
      prompt,
      userChoice: new Promise<{ outcome: 'accepted' | 'dismissed' }>(() => {}),
    } as unknown as InstallPromptEvent
    render(<InstallAppPrompt store={storeHolding(event)} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(window.sessionStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe('1')
    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBeNull()
  })

  it('closes when the app is installed, however that happened', async () => {
    render(<InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'))
    })

    expect(popup()).not.toBeInTheDocument()
  })

  it('falls back to guidance when the browser refuses its own prompt', async () => {
    const event = {
      prompt: vi.fn(async () => {
        throw new Error('already used')
      }),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    } as unknown as InstallPromptEvent
    const store = storeHolding(event)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(screen.getByText(/This browser cannot install RecoverEase/)).toBeInTheDocument()
    expect(store.clear).toHaveBeenCalled()
  })
})

describe('when the browser hands its install event over late', () => {
  it('asks the browser with an event that arrives while the popup is open', async () => {
    const { event, prompt } = browserPrompt('accepted')
    const store = storeHolding(null)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} graceMs={50} />)
    await waitForTheOffer()

    // Chromium offers it after the popup is already on screen.
    await act(async () => {
      store.deliver(event)
    })
    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(popup()).not.toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('waits for an event that has not arrived when Install is pressed', async () => {
    const { event, prompt } = browserPrompt('accepted')
    const store = storeHolding(null)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} graceMs={500} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
      // Still nothing to install with: the popup waits rather than deciding
      // the browser cannot install.
      await new Promise((resolve) => setTimeout(resolve, 20))
      store.deliver(event)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(popup()).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot install RecoverEase/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has not offered to install/)).not.toBeInTheDocument()
  })

  it('drops the instructions when an event turns up afterwards', async () => {
    pretendBrowserHasInstallEvent()
    const { event, prompt } = browserPrompt('accepted')
    const store = storeHolding(null)
    render(<InstallAppPrompt store={store} appearsAfterMs={0} graceMs={0} />)
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })
    expect(
      screen.getByText(/Your browser has not offered to install RecoverEase/),
    ).toBeInTheDocument()

    // Chromium offers the event late. The button can work now, so the
    // instructions have no business being on screen.
    await act(async () => {
      store.deliver(event)
    })

    expect(
      screen.queryByText(/Your browser has not offered to install RecoverEase/),
    ).not.toBeInTheDocument()
    expect(popup()).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(installButton())
    })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('says how to install from the browser’s own menu when none arrives', async () => {
    // A browser that has the event, but has not fired one here - Chromium
    // with the app already installed, most often.
    pretendBrowserHasInstallEvent()
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={0} />,
    )
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(
      screen.getByText(/Your browser has not offered to install RecoverEase/),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(
      screen.getByText(/Already installed RecoverEase\? Open it from your list of apps/),
    ).toBeInTheDocument()
    // The untrue thing it used to say to an installable browser.
    expect(screen.queryByText(/cannot install RecoverEase/)).not.toBeInTheDocument()
  })

  it('still adds by hand on an iPhone, without waiting for an event', async () => {
    pretendDevice({ userAgent: IPHONE })
    pretendBrowserHasInstallEvent()
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={5000} />,
    )
    await waitForTheOffer()

    // No await: iOS is answered at once, because no event can ever arrive.
    fireEvent.click(installButton())

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText(/On iPhone and iPad you add RecoverEase yourself/)).toBeInTheDocument()
  })
})

describe('where the browser offers no install event', () => {
  it('shows an iPhone the three steps, and no pretend installation', async () => {
    pretendDevice({ userAgent: IPHONE })
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={0} />,
    )
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps[0]).toHaveTextContent('Tap the Share button')
    expect(steps[1]).toHaveTextContent('Tap Add to Home Screen.')
    expect(steps[2]).toHaveTextContent('Tap Add.')
    expect(screen.queryByText(/cannot install RecoverEase/)).not.toBeInTheDocument()
    // The browser has nothing to trigger, so the button that would is gone.
    expect(screen.queryByRole('button', { name: /install recoverease/i })).not.toBeInTheDocument()
    expect(maybeLater()).toBeEnabled()
  })

  it('tells an iPad it is the same three steps', async () => {
    pretendDevice({ userAgent: WINDOWS_CHROME, platform: 'MacIntel', maxTouchPoints: 5 })
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={0} />,
    )
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('names Safari to an iPhone browsing in something else', async () => {
    pretendDevice({ userAgent: IPHONE.replace('Version/17.5', 'CriOS/126.0') })
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={0} />,
    )
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(
      screen.getByText(/If you are using another browser, open RecoverEase in Safari first/),
    ).toBeInTheDocument()
  })

  it('says so plainly where the browser cannot install at all', async () => {
    render(
      <InstallAppPrompt store={storeHolding(null)} appearsAfterMs={0} graceMs={0} />,
    )
    await waitForTheOffer()

    await act(async () => {
      fireEvent.click(installButton())
    })

    expect(screen.getByText(/This browser cannot install RecoverEase/)).toBeInTheDocument()
    expect(screen.getByText(/Chrome or Microsoft Edge/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})
