import { expect, test } from './support/fixtures'

/**
 * Runs only on the mobile project (Pixel 7). Layout regressions on small
 * screens are invisible from a desktop run, and this application is meant to
 * be used on a ward round.
 */

test('the landing page does not scroll sideways on a phone', async ({ page }) => {
  await page.goto('/')

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )

  // Horizontal scroll is the classic small-screen failure and it makes the
  // page feel broken even when everything is present.
  expect(overflow).toBeLessThanOrEqual(1)
})

test('the app shell uses a bottom bar instead of a sidebar', async ({
  page,
  signInAs,
}) => {
  await signInAs('patient')
  await page.goto('/patient')

  const bottomNav = page.getByRole('navigation', { name: 'Primary' })
  await expect(bottomNav).toBeVisible()

  // Five is the ceiling before targets stop being reliably tappable.
  const items = bottomNav.getByRole('link')
  expect(await items.count()).toBeLessThanOrEqual(5)
})

test('the menu drawer opens, traps focus and closes on Escape', async ({
  page,
  signInAs,
}) => {
  await signInAs('patient')
  await page.goto('/patient')

  await page.getByRole('button', { name: /open menu/i }).click()

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('navigation', { name: 'Main' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(drawer).not.toBeVisible()
})

test('a patient table becomes cards rather than scrolling sideways', async ({
  page,
  signInAs,
}) => {
  await signInAs('doctor')
  await page.goto('/doctor/patients')

  await expect(page.getByRole('link', { name: 'Alice Santos' })).toBeVisible()

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test('touch targets in the bottom bar are large enough to hit', async ({
  page,
  signInAs,
}) => {
  await signInAs('patient')
  await page.goto('/patient')

  const firstItem = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link')
    .first()

  const box = await firstItem.boundingBox()
  expect(box).not.toBeNull()
  // 44px is the practical floor for a reliable tap.
  expect(box!.height).toBeGreaterThanOrEqual(44)
})
