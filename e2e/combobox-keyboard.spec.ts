import type { Locator } from '@playwright/test'

import { expect, test, type Page } from './support/fixtures'

/**
 * The shared patient picker, driven by the keyboard through a long caseload,
 * in a real browser with real layout.
 *
 * Before this fix the highlight left the visible list — at the second press
 * in the scheduling dialog, at the fifth on Reports — while the list never
 * scrolled; and on a small phone the last options sat under the fixed
 * navigation bar. The unit tests pin the logic against a stated geometry;
 * these check the geometry the browser actually produces.
 */

const CASELOAD = Array.from({ length: 30 }, (_, i) => ({
  pat_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  doc_id: 'aaaa1111-1111-4111-8111-dddddddddddd',
  user_id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  pat_first_name: 'Case',
  pat_last_name: String(i).padStart(2, '0'),
  pat_status: 'active',
  pat_created_at: '2026-01-01T00:00:00Z',
}))

function name(index: number) {
  return `Case ${String(index).padStart(2, '0')}`
}

/** A caseload long enough to scroll, served in place of the fixture's two. */
async function withLongCaseload(page: Page) {
  await page.route(
    (url) => url.pathname.endsWith('/rest/v1/patient'),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CASELOAD),
      })
    },
  )
}

/** The option the input names as active, and whether a person can see it. */
async function highlight(page: Page, selector: string) {
  return page.evaluate(async (sel) => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
    )
    const input = document.querySelector(sel) as HTMLInputElement
    const list = document.getElementById(
      input.getAttribute('aria-controls') as string,
    ) as HTMLElement
    const id = input.getAttribute('aria-activedescendant') as string
    const option = document.getElementById(id) as HTMLElement
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    const topmost = document.elementFromPoint(
      optionRect.left + Math.min(20, optionRect.width / 2),
      optionRect.top + optionRect.height / 2,
    )
    return {
      label: option.textContent?.trim() ?? '',
      namesTheOption: option.getAttribute('role') === 'option' && option.id === id,
      insideList:
        optionRect.top >= listRect.top - 1 && optionRect.bottom <= listRect.bottom + 1,
      // Nothing — a bar, a border, another card — is painted over it.
      nothingDrawnOverIt: !!topmost && option.contains(topmost),
    }
  }, selector)
}

async function expectVisible(page: Page, selector: string, expected: string) {
  const h = await highlight(page, selector)
  expect(h.label).toBe(expected)
  expect(h.namesTheOption).toBe(true)
  expect(h.insideList, `${expected} inside the list`).toBe(true)
  expect(h.nothingDrawnOverIt, `${expected} not covered`).toBe(true)
}

async function walkChooseAndKeep(page: Page, picker: Locator, selector: string) {
  await picker.click()
  await expect(page.locator('[role=listbox] [role=option]')).toHaveCount(30)
  await expectVisible(page, selector, name(0))

  for (let step = 1; step <= 12; step++) {
    await picker.press('ArrowDown')
    await expectVisible(page, selector, name(step))
  }

  await picker.press('End')
  await expectVisible(page, selector, name(29))
  await picker.press('Home')
  await expectVisible(page, selector, name(0))
  await picker.press('ArrowUp')
  await expectVisible(page, selector, name(29))
  for (let step = 0; step < 3; step++) await picker.press('ArrowUp')
  await expectVisible(page, selector, name(26))

  await picker.press('Enter')
  await expect(picker).toHaveValue(name(26))

  // Escape after another walk keeps what was chosen.
  await picker.click()
  await picker.press('Home')
  await picker.press('Escape')
  await expect(picker).toHaveValue(name(26))
}

test.describe('shared patient picker: the keyboard highlight stays on screen', () => {
  test('in the Reports picker, through a long caseload', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await signInAs('doctor')
    await withLongCaseload(page)
    await page.goto('/doctor/reports')

    const selector = 'main [role=combobox]'
    await walkChooseAndKeep(page, page.locator(selector), selector)
  })

  test('in the scheduling dialog, through a long caseload', async ({
    page,
    signInAs,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await signInAs('doctor')
    await withLongCaseload(page)
    await page.goto('/doctor/appointments')
    await page.getByRole('button', { name: /^Schedule appointment$/ }).first().click()
    await expect(page.locator('dialog[open]')).toBeVisible()

    const selector = 'dialog[open] [role=combobox]'
    await walkChooseAndKeep(page, page.locator(selector), selector)
  })

  test('on a small phone, above the bottom navigation bar', async ({
    page,
    signInAs,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await signInAs('doctor')
    await withLongCaseload(page)
    await page.goto('/doctor/reports')

    const selector = 'main [role=combobox]'
    const picker = page.locator(selector)
    await picker.click()
    await expect(page.locator('[role=listbox] [role=option]')).toHaveCount(30)

    // The list ends above the bar rather than running underneath it…
    const clearance = await page.evaluate(() => {
      const list = (document.querySelector('[role=listbox]') as HTMLElement).getBoundingClientRect()
      const bars = [...document.querySelectorAll<HTMLElement>('body *')].filter(
        (el) =>
          getComputedStyle(el).position === 'fixed' &&
          el.getBoundingClientRect().top > window.innerHeight / 2 &&
          el.getBoundingClientRect().height > 0,
      )
      const barTop = Math.min(...bars.map((el) => el.getBoundingClientRect().top))
      return { listBottom: list.bottom, barTop }
    })
    expect(clearance.listBottom).toBeLessThanOrEqual(clearance.barTop)

    // …so the last option, reached by keyboard, is on screen and uncovered.
    await picker.press('End')
    await expectVisible(page, selector, name(29))
    await picker.press('Enter')
    await expect(picker).toHaveValue(name(29))
  })
})
