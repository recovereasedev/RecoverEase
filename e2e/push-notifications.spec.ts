import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * The patient's "Reminders on this phone" switch (migration 53), in the
 * production build.
 *
 * A real push service cannot be reached from a test, so the browser's side
 * is stood in for: a service worker registration whose PushManager hands
 * out a fixed subscription, and a Notification permission that answers as
 * told. Everything RecoverEase itself does - the switch, the permission
 * request from the tap, the call that saves the device, what it sends - is
 * the real build. The server's checks are tests/db/web-push.test.ts; the
 * worker's push and tap handling is tests/unit/web-push-service-worker.test.ts.
 */

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device'

async function standInForPush(page: Page, answer: 'granted' | 'denied') {
  await page.addInitScript(
    ({ endpoint, answer }) => {
      let permission: NotificationPermission = 'default'
      let subscription: unknown = null
      const make = () => ({
        endpoint,
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: { p256dh: 'B' + 'K'.repeat(86), auth: 'abcdefghijklmnopqrstuv' } }),
        unsubscribe: async () => {
          subscription = null
          return true
        },
      })
      const pushManager = {
        getSubscription: async () => subscription,
        subscribe: async () => (subscription = make()),
      }
      Object.defineProperty(Notification, 'permission', { get: () => permission })
      Notification.requestPermission = async () => {
        ;(window as unknown as { permissionAsked: number }).permissionAsked =
          ((window as unknown as { permissionAsked?: number }).permissionAsked ?? 0) + 1
        permission = answer
        return permission
      }
      ServiceWorkerContainer.prototype.getRegistration = async () =>
        ({ pushManager }) as unknown as ServiceWorkerRegistration
    },
    { endpoint: ENDPOINT, answer },
  )
}

test.describe('phone reminders', () => {
  test('a patient turns them on for this phone, and off again', async ({ page, signInAs }) => {
    await standInForPush(page, 'granted')
    const stub = await signInAs('patient')

    const registered: Record<string, unknown>[] = []
    stub.setRpcHandler('register_push_subscription', (args) => {
      registered.push(args)
      stub.addRows('push_subscription', [{ push_endpoint: args['endpoint'], user_id: IDS.aliceUser }])
      return { result: 'sub-1' }
    })
    const unregistered: Record<string, unknown>[] = []
    stub.setRpcHandler('unregister_push_subscription', (args) => {
      unregistered.push(args)
      return { result: true }
    })

    await page.goto('/patient/profile')
    const toggle = page.getByRole('switch', { name: 'Reminders on this phone' })
    await expect(page.getByText('You have a reminder in RecoverEase.', { exact: false })).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toBeEnabled()
    expect(await page.evaluate(() => (window as unknown as { permissionAsked?: number }).permissionAsked)).toBeUndefined()

    await toggle.click()

    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(await page.evaluate(() => (window as unknown as { permissionAsked?: number }).permissionAsked)).toBe(1)
    expect(registered).toHaveLength(1)
    // The device's endpoint and public keys, and the browser's name: nothing
    // about the patient, the medicine or the reminder.
    expect(Object.keys(registered[0]!).sort()).toEqual(['auth_key', 'endpoint', 'p256dh', 'user_agent'])
    expect(registered[0]!['endpoint']).toBe(ENDPOINT)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(unregistered).toEqual([{ endpoint: ENDPOINT }])
  })

  test('a refused permission is explained, and nothing is saved', async ({ page, signInAs }) => {
    await standInForPush(page, 'denied')
    const stub = await signInAs('patient')
    let calls = 0
    stub.setRpcHandler('register_push_subscription', () => {
      calls++
      return { result: 'x' }
    })

    await page.goto('/patient/profile')
    const toggle = page.getByRole('switch', { name: 'Reminders on this phone' })
    await toggle.click()

    await expect(page.getByRole('alert')).toContainText('blocked for RecoverEase')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(calls).toBe(0)
  })

  test('without a running service worker the switch is explained, not offered', async ({ page, signInAs }) => {
    // The suite blocks service workers, so this is the real build as a
    // browser tab that has not installed RecoverEase sees it. Headless
    // Chromium reports notifications as denied; a phone that was never asked
    // reports 'default', which is what this stands in for.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' })
    })
    await signInAs('patient')
    await page.goto('/patient/profile')
    await expect(page.getByText('Open RecoverEase from the app on your home screen')).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Reminders on this phone' })).toBeDisabled()

    // @axe-core/playwright types its Page against an older Playwright (as in
    // contrast-audit.spec.ts).
    const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page']
    const results = await new AxeBuilder({ page: axePage }).include('main').analyze()
    expect(results.violations).toEqual([])
  })
})
