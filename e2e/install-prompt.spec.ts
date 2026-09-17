import { expect, test, type Browser, type Page } from './support/fixtures'

/**
 * RecoverEase's own offer to install itself as an app, in a real browser.
 *
 * It is offered on the way in - the landing page and the auth pages - and
 * never over a clinical screen.
 *
 * This is the one spec that lets the popup appear; every other spec answers
 * it first (see `e2e/support/fixtures.ts`).
 *
 * Chromium under Playwright never fires `beforeinstallprompt` of its own
 * accord, so the tests that need one dispatch the event the way the browser
 * would - after the page has loaded, into the listener the app registered
 * before the first render. Everything downstream of that is the real thing:
 * the real build, the real store, the real button.
 *
 * The tests that need no event cover the other half: Install must never claim
 * an installable browser cannot install RecoverEase.
 */

test.use({ installPrompt: 'allow' })

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Long enough for an offer that waits for the page, and then a moment. */
const APPEARS_WITHIN_MS = 4000

function offer(page: Page) {
  return page.getByRole('dialog')
}

test.describe('offering to install RecoverEase', () => {
  test('offers the app to a visitor, in RecoverEase’s own words', async ({ page }) => {
    await page.goto('/')

    const popup = offer(page)
    await expect(popup.getByRole('heading', { name: 'Install RecoverEase' })).toBeVisible({
      timeout: APPEARS_WITHIN_MS,
    })
    await expect(
      popup.getByText(
        'Install RecoverEase on your device for easier access and a more convenient experience.',
      ),
    ).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Install RecoverEase' })).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Maybe Later' })).toBeVisible()
  })

  test('is answered by Maybe Later for the rest of the visit', async ({ page }) => {
    await page.goto('/')
    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })

    await popup.getByRole('button', { name: 'Maybe Later' }).click()
    await expect(popup).toBeHidden()

    // The same visit, on another page and after a reload. Waited out rather
    // than asserted on the spot: the offer is on a timer, so an immediate
    // check would pass whether or not it was coming.
    await page.goto('/sign-in')
    await page.waitForTimeout(APPEARS_WITHIN_MS)
    await expect(offer(page)).toHaveCount(0)

    await page.reload()
    await page.waitForTimeout(APPEARS_WITHIN_MS)
    await expect(offer(page)).toHaveCount(0)
  })

  test('asks again on the next visit', async ({ browser }) => {
    const context = await browser.newContext()
    const first = await context.newPage()
    await first.goto('/')
    await expect(offer(first)).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await first.getByRole('button', { name: 'Maybe Later' }).click()
    await first.close()

    // A new browser session is a new visit, and nothing was kept beyond one.
    const next = await browser.newContext()
    const later = await next.newPage()
    await later.goto('/')

    await expect(
      offer(later).getByRole('heading', { name: 'Install RecoverEase' }),
    ).toBeVisible({ timeout: APPEARS_WITHIN_MS })

    await context.close()
    await next.close()
  })

  test('says nothing at all to the installed app', async ({ browser }) => {
    const context = await browser.newContext()
    // Chrome answers `display-mode: standalone` in an installed window. There
    // is no way to install one from a test, so the window is made to answer
    // the way an installed one does.
    await context.addInitScript(() => {
      const browserMatchMedia = window.matchMedia.bind(window)
      window.matchMedia = (query: string) =>
        query.includes('display-mode: standalone')
          ? ({
              matches: true,
              media: query,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              addListener: () => {},
              removeListener: () => {},
              dispatchEvent: () => false,
            } as MediaQueryList)
          : browserMatchMedia(query)
    })

    const page = await context.newPage()
    await page.goto('/')
    await page.waitForTimeout(APPEARS_WITHIN_MS)

    await expect(offer(page)).toHaveCount(0)
    await context.close()
  })

  test('says nothing when the browser reports RecoverEase already installed', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    // Chromium only reports an app that is genuinely installed, which a test
    // cannot arrange. The browser is made to answer the way it would once
    // RecoverEase had been installed from another window.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'getInstalledRelatedApps', {
        configurable: true,
        value: async () => [
          {
            platform: 'webapp',
            url: 'https://recoverease-web.vercel.app/manifest.webmanifest',
          },
        ],
      })
    })

    const page = await context.newPage()
    await page.goto('/')
    await page.waitForTimeout(APPEARS_WITHIN_MS)

    await expect(offer(page)).toHaveCount(0)
    await context.close()
  })

  test('still offers when the browser cannot answer that question', async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'getInstalledRelatedApps', {
        configurable: true,
        value: async () => {
          throw new Error('not supported on this platform')
        },
      })
    })

    const page = await context.newPage()
    await page.goto('/')

    await expect(
      offer(page).getByRole('heading', { name: 'Install RecoverEase' }),
    ).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await context.close()
  })

  test('shows an iPhone how to add it by hand, and installs nothing itself', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      userAgent: IPHONE,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()
    await page.goto('/')

    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await popup.getByRole('button', { name: 'Install RecoverEase' }).click()

    const steps = popup.getByRole('listitem')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toContainText('Tap the Share button')
    await expect(steps.nth(1)).toContainText('Add to Home Screen')
    await expect(steps.nth(2)).toContainText('Tap Add')
    await expect(popup.getByRole('button', { name: 'Install RecoverEase' })).toHaveCount(0)
    await expect(popup.getByRole('button', { name: 'Maybe Later' })).toBeVisible()

    await context.close()
  })

  /**
   * Chromium's own event, dispatched as Chromium dispatches it: after load,
   * to whatever registered a listener beforehand. `promptCalls` is what the
   * test is really asking about - whether the button reached the browser.
   */
  async function withBrowserInstallEvent(
    browser: Browser,
    { delayMs = 0 }: { delayMs?: number } = {},
  ) {
    const context = await browser.newContext()
    await context.addInitScript((wait) => {
      const state = { promptCalls: 0, choiceRead: false }
      ;(window as unknown as { __install: typeof state }).__install = state

      const event = new Event('beforeinstallprompt', { cancelable: true })
      Object.assign(event, {
        platforms: ['web'],
        prompt: async () => {
          state.promptCalls += 1
        },
        get userChoice() {
          state.choiceRead = true
          return Promise.resolve({ outcome: 'accepted', platform: 'web' })
        },
      })

      window.addEventListener('load', () => {
        setTimeout(() => window.dispatchEvent(event), wait)
      })
    }, delayMs)

    const page = await context.newPage()
    return { context, page }
  }

  const promptCalls = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __install: { promptCalls: number } }).__install.promptCalls,
    )

  test('Install asks the browser, with an event captured before the popup appears', async ({
    browser,
  }) => {
    const { context, page } = await withBrowserInstallEvent(browser)
    await page.goto('/')

    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await popup.getByRole('button', { name: 'Install RecoverEase' }).click()

    // The browser's own installation ran, and no instructions were shown in
    // its place.
    await expect.poll(() => promptCalls(page)).toBe(1)
    await expect(offer(page)).toBeHidden()
    await context.close()
  })

  test('Install asks the browser, with an event captured after the popup appears', async ({
    browser,
  }) => {
    // Chromium can offer the event well after the page has settled - after
    // this popup is already on screen.
    const { context, page } = await withBrowserInstallEvent(browser, { delayMs: 2500 })
    await page.goto('/')

    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await page.waitForTimeout(3000)
    await popup.getByRole('button', { name: 'Install RecoverEase' }).click()

    await expect.poll(() => promptCalls(page)).toBe(1)
    await expect(offer(page)).toBeHidden()
    await context.close()
  })

  test('never tells an installable browser that it cannot install', async ({ page }) => {
    await page.goto('/')
    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })

    // No event at all in this context. Chromium can still install from its
    // own menu, so that is what it must be told - after waiting for an event
    // that never comes.
    await popup.getByRole('button', { name: 'Install RecoverEase' }).click()

    await expect(
      popup.getByText(/Your browser has not offered to install RecoverEase/),
    ).toBeVisible()
    await expect(popup.getByRole('listitem')).toHaveCount(3)
    await expect(popup.getByText('This browser cannot install RecoverEase.')).toHaveCount(0)
  })

  test('closes on Escape, like any other dialog', async ({ page }) => {
    await page.goto('/')
    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })

    await page.keyboard.press('Escape')

    await expect(popup).toBeHidden()
  })

  // The pages a patient's care, and a clinician's record of it, are on. A
  // modal asking about the browser has no business in front of any of them.
  const CLINICAL_SCREENS = [
    ['patient', '/patient', 'dashboard'],
    ['patient', '/patient/medications', 'medications'],
    ['patient', '/patient/treatment', 'treatment plan'],
    ['doctor', '/doctor', 'dashboard'],
    ['doctor', '/doctor/patients', 'patient records'],
    ['admin', '/admin', 'dashboard'],
  ] as const

  for (const [role, path, screen] of CLINICAL_SCREENS) {
    test(`says nothing over the ${role} ${screen}`, async ({ page, signInAs }) => {
      await signInAs(role)
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

      // Waited out rather than asserted on the spot: the offer is on a timer,
      // so an immediate check would pass whether or not it was coming.
      await page.waitForTimeout(APPEARS_WITHIN_MS)

      await expect(offer(page)).toHaveCount(0)
    })
  }

  test('leaves the page behind it usable once it is answered', async ({ page }) => {
    await page.goto('/')
    const popup = offer(page)
    await expect(popup).toBeVisible({ timeout: APPEARS_WITHIN_MS })
    await popup.getByRole('button', { name: 'Maybe Later' }).click()

    await page.getByRole('link', { name: 'Sign in' }).first().click()

    await expect(page).toHaveURL(/\/sign-in$/)
  })
})
