import type { Page } from '@playwright/test'

import { expect, test } from './support/fixtures'

/**
 * One press of Save as draft or Publish now creates one announcement.
 *
 * The composer has two submit buttons sharing one mutation, and a loading
 * button ignores presses only on itself: while Save as draft was saving,
 * Publish now still sent a second request, leaving a draft and a published
 * copy of the same notice. Two presses in one task got through the same way,
 * because React Query tells the page a mutation is pending on a later task
 * (see "one action creates one appointment" in production-hardening.spec.ts).
 */

/** Every announcement the page asks the server to create. */
function watchCreates(page: Page): string[] {
  const posted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/rest/v1/announcement')) {
      posted.push(request.postData() ?? '')
    }
  })
  return posted
}

async function openComposer(page: Page) {
  await page.goto('/admin/announcements')
  await page.getByRole('button', { name: /new announcement/i }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Clinic closed on Monday')
  await dialog.getByLabel('Message').fill('The clinic is closed for the public holiday.')
  return dialog
}

/** Presses the named buttons in order within one task, before React renders. */
async function pressInOneTask(page: Page, names: string[]) {
  await page.evaluate((labels) => {
    const dialog = document.querySelector('dialog[open]')!
    const find = (label: string) =>
      [...dialog.querySelectorAll('button')].find(
        (button) => (button.textContent ?? '').trim() === label,
      ) as HTMLButtonElement
    for (const label of labels) find(label).click()
  }, names)
}

test.describe('one press creates one announcement', () => {
  test('Save as draft pressed twice in one task sends one request', async ({ page, signInAs }) => {
    await signInAs('admin')
    const posted = watchCreates(page)
    const dialog = await openComposer(page)

    await pressInOneTask(page, ['Save as draft', 'Save as draft'])

    await expect(dialog).toBeHidden()
    await page.waitForTimeout(1000)
    expect(posted).toHaveLength(1)
  })

  test('Publish now while Save as draft is still saving sends nothing more', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    const posted = watchCreates(page)
    // Hold the first save open, so the second press lands while it is saving.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/rest/v1/announcement**', async (route) => {
      if (route.request().method() === 'POST') await held
      await route.fallback()
    })
    const dialog = await openComposer(page)

    await dialog.getByRole('button', { name: 'Save as draft', exact: true }).click()
    await expect.poll(() => posted.length).toBe(1)
    await dialog.getByRole('button', { name: 'Publish now', exact: true }).click()
    release()

    await expect(dialog).toBeHidden()
    await page.waitForTimeout(1000)
    expect(posted).toHaveLength(1)
    // It was saved as the draft the first press asked for.
    expect(JSON.parse(posted[0]!)).toMatchObject({ announcement_published_at: null })
  })

  test('a failed save can be retried', async ({ page, signInAs }) => {
    await signInAs('admin')
    let attempt = 0
    await page.route('**/rest/v1/announcement**', async (route) => {
      if (route.request().method() === 'POST') {
        attempt += 1
        if (attempt === 1) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'upstream unavailable' }),
          })
        }
      }
      return route.fallback()
    })
    const dialog = await openComposer(page)

    await dialog.getByRole('button', { name: 'Save as draft', exact: true }).click()
    // The failure is reported and the guard released, not stuck.
    await expect(dialog.getByRole('alert')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save as draft', exact: true }).click()

    await expect.poll(() => attempt, { timeout: 5000 }).toBe(2)
    await expect(dialog).toBeHidden()
  })
})
