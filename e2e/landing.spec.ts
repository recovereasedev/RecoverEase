import type { Page } from '@playwright/test'

import { expect, test } from './support/fixtures'

/**
 * The public landing page in a real browser: its sign-in route and in-page
 * links, the sticky header, the one-time reveal and what reduced motion does
 * to it, the hero portrait, and the layout at 360px. Its outline, links and
 * claims are also checked in tests/unit/landing-page.test.tsx; contrast in
 * both themes is in contrast-audit.spec.ts.
 */

async function opacityOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((element) => getComputedStyle(element).opacity)
}

test.describe('the landing page', () => {
  test('signs in through the application’s own route', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Recovery support, beyond the clinic.',
    )

    await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/sign-in$/)
  })

  test('jumps to a section without hiding its heading under the sticky header', async ({
    page,
  }) => {
    await page.goto('/')

    await page.getByRole('banner').getByRole('link', { name: 'See how it works' }).click()
    await expect(page).toHaveURL(/#how-it-works$/)

    const heading = page.getByRole('heading', { level: 2, name: 'How it works' })
    await expect(heading).toBeInViewport()
    const header = (await page.getByRole('banner').boundingBox())!
    const top = (await heading.boundingBox())!
    expect(top.y).toBeGreaterThanOrEqual(header.y + header.height)

    // The header has lifted off the page now that the page is under it.
    await expect(page.getByRole('banner')).toHaveAttribute('data-scrolled', 'true')
  })

  test('reveals each section once as it comes into view', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-reveal-ready]')).toHaveCount(1)
    await expect(page.getByRole('banner')).toHaveAttribute('data-scrolled', 'false')

    // Below the fold: waiting for its moment.
    const faq = '#questions [data-reveal]'
    expect(await opacityOf(page, faq)).toBe('0')

    await page.locator('#questions').scrollIntoViewIfNeeded()
    await expect.poll(() => opacityOf(page, faq)).toBe('1')

    // The heading was never part of it.
    await expect(page.getByRole('heading', { level: 1 }).locator('xpath=ancestor-or-self::*[@data-reveal]')).toHaveCount(0)
  })

  test('shows everything at once under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await expect(page.locator('[data-reveal-ready]')).toHaveCount(0)
    // Far below the fold, and never scrolled to: still fully visible.
    expect(await opacityOf(page, '#questions [data-reveal]')).toBe('1')
    expect(await opacityOf(page, '[data-reveal="line"]')).toBe('1')
    const transform = await page
      .locator('[data-reveal="line"]')
      .evaluate((element) => getComputedStyle(element).transform)
    expect(transform).toBe('none')
  })

  test('loads its own hero portrait, sized and within its budget', async ({ page, request }) => {
    await page.goto('/')

    const portrait = page.getByRole('img', { name: 'A clinician holding a tablet.' })
    await expect(portrait).toBeVisible()
    expect(await portrait.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(736)

    const response = await request.get('/landing/hero-clinician.webp')
    expect(response.ok()).toBe(true)
    expect((await response.body()).byteLength).toBeLessThanOrEqual(150 * 1024)
  })

  test('loads every picture on the page once it is scrolled to', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const images = page.locator('main img')
    const count = await images.count()
    expect(count).toBeGreaterThan(3)
    for (let index = 0; index < count; index += 1) {
      const image = images.nth(index)
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth))
        .toBeGreaterThan(0)
    }
  })

  test('fits a 360px phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)

    // The day card stays on the screen beside the portrait.
    const card = (await page.getByText('Alice Santos').locator('xpath=ancestor::div[contains(@class,"shadow")][1]').boundingBox())!
    expect(card.x).toBeGreaterThanOrEqual(0)
    expect(card.x + card.width).toBeLessThanOrEqual(360)
  })

  test('opens and closes a question from the keyboard', async ({ page }) => {
    await page.goto('/')
    const question = page.getByText('How do I get an account?')

    await question.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText(/Your care team creates it/)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByText(/Your care team creates it/)).toBeHidden()
  })
})
