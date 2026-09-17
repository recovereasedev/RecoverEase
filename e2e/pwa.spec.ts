import { expect, test, type Page } from './support/fixtures'

/**
 * RecoverEase as an installable app, against the production build (QA 9/12,
 * "Integrate PWA"). Service workers are blocked for the rest of the suite;
 * these tests turn them on to check the manifest, Chrome's own installability
 * verdict, the worker, the offline page, and that care information still
 * comes from the network with the worker in control.
 */

test.use({ serviceWorkers: 'allow' })

/** Load a page, wait for the worker, and reload so it controls the page. */
async function underWorkerControl(page: Page, path: string) {
  await page.goto(path)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

test.describe('RecoverEase as an installable app', () => {
  test('links a valid manifest whose icons load', async ({ page }) => {
    await page.goto('/')
    expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe(
      '/manifest.webmanifest',
    )

    const response = await page.request.get('/manifest.webmanifest')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/application\/(manifest\+)?json/)
    const manifest = await response.json()
    expect(manifest).toMatchObject({
      name: 'RecoverEase',
      short_name: 'RecoverEase',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      // What lets a browser report RecoverEase as already installed.
      related_applications: [
        {
          platform: 'webapp',
          url: 'https://recoverease-web.vercel.app/manifest.webmanifest',
        },
      ],
    })
    expect(manifest.prefer_related_applications).toBeUndefined()

    for (const icon of manifest.icons as { src: string }[]) {
      const image = await page.request.get(icon.src)
      expect(image.status(), icon.src).toBe(200)
      expect(image.headers()['content-type'], icon.src).toContain('image/png')
    }
  })

  test('registers one service worker for the whole app', async ({ page, baseURL }) => {
    await page.goto('/')
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)

    expect(scope).toBe(`${baseURL}/`)
  })

  test('passes Chrome’s own installability checks', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })

    const cdp = await page.context().newCDPSession(page)
    const { errors: manifestErrors } = await cdp.send('Page.getAppManifest')
    expect(manifestErrors).toEqual([])

    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    // A Playwright context is a private window, and Chrome never offers to
    // install from one. That verdict is about the window, not the app.
    const aboutTheApp = installabilityErrors.filter(
      (error) => error.errorId !== 'in-incognito',
    )
    expect(aboutTheApp).toEqual([])
  })

  test('shows an honest offline page, then recovers', async ({ page, context }) => {
    await underWorkerControl(page, '/')

    await context.setOffline(true)
    await page.goto('/patient/medications')

    await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toBeVisible()
    await expect(page.getByText(/needs an internet connection to show your care information/)).toBeVisible()
    await expect(page).toHaveTitle('RecoverEase | Offline')

    await context.setOffline(false)
    await page.getByRole('link', { name: 'Try again' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toHaveCount(0)
    await expect(page).toHaveTitle('RecoverEase')
  })

  test('leaves a signed-in patient’s care information to the network', async ({
    page,
    signInAs,
  }) => {
    const fromWorker: string[] = []
    page.on('response', (response) => {
      if (response.url().includes('supabase.co') && response.fromServiceWorker()) {
        fromWorker.push(response.url())
      }
    })

    await signInAs('patient')
    await underWorkerControl(page, '/patient/medications')

    await expect(page.getByText('Take with food.')).toBeVisible()
    expect(fromWorker).toEqual([])
  })
})
