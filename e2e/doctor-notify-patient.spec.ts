import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Module 7.1 from the doctor's Notifications page, in a real browser: choose
 * one of your patients, write, send - once, even when the first answer is
 * lost on the way back. The database's own rules are in
 * tests/db/doctor-notifications.test.ts; the stub here stands in for it.
 */

async function choosePatient(page: Page, name: string) {
  const picker = page.getByRole('combobox', { name: 'Patient' })
  await picker.click()
  await picker.fill(name.split(' ')[0]!)
  await page.getByRole('option', { name }).click()
}

test.describe('notifying a patient from the Notifications page', () => {
  test('sends a general message to the patient chosen', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor')
    await page.goto('/doctor/notifications')

    await choosePatient(page, 'Bob Reyes')
    await page.getByLabel('Message').fill('Please bring your medication list on Thursday.')
    await page.getByRole('button', { name: /send notification/i }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Sent to Bob Reyes.' })).toBeVisible()
    const sent = stub.rowsIn('notification').filter((row) => row['user_id'] === IDS.bobUser)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      notification_type: 'general',
      notification_message: 'Please bring your medication list on Thursday.',
    })
  })

  test('sends it once when the first answer is lost and Send is pressed again', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('doctor')
    // The first send reaches the database, and its answer never comes back.
    let lost = false
    await page.route('**/rest/v1/notification**', async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.fallback()
      lost = true
      stub.addRows('notification', [JSON.parse(route.request().postData() ?? '{}')])
      await route.abort('failed')
    })
    await page.goto('/doctor/notifications')

    await choosePatient(page, 'Alice Santos')
    await page.getByLabel('Message').fill('Your next dose is at 20:00.')
    const send = page.getByRole('button', { name: /send notification/i })
    await send.click()
    await expect(page.getByRole('alert').filter({ hasText: 'No connection' })).toBeVisible()

    await send.click()

    await expect(page.getByRole('status').filter({ hasText: 'Sent to Alice Santos.' })).toBeVisible()
    const toAlice = stub
      .rowsIn('notification')
      .filter((row) => row['notification_message'] === 'Your next dose is at 20:00.')
    expect(toAlice).toHaveLength(1)
  })

  test('holds a message to 1,000 characters', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto('/doctor/notifications')
    await choosePatient(page, 'Alice Santos')

    await page.getByLabel('Message').fill('x'.repeat(1200))

    await expect(page.getByLabel('Message')).toHaveValue('x'.repeat(1000))
    await expect(page.getByText('1,000 / 1,000')).toBeVisible()
  })

  test('fits a 360px phone, after the notifications themselves', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('doctor')
    await page.goto('/doctor/notifications')
    await expect(page.getByRole('heading', { name: 'Send a notification' })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
