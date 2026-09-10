import type { Locator } from '@playwright/test'

import { expect, test, type Page } from './support/fixtures'

/**
 * The shared patient picker, in both places a doctor uses it, driven through
 * a long caseload in a real browser with real layout.
 *
 * Nothing used to scroll the list, so the keyboard highlight left it — at the
 * second press in the scheduling dialog, the fifth on Reports — and on a
 * small phone the last options sat under the fixed navigation bar. The first
 * fix (3b1fc5b) was reverted in production for two regressions that only a
 * real browser shows, and both are pinned here:
 *
 *  - Chrome tells whichever row scrolls under a pointer that has not moved
 *    that the pointer is now over it. The list took that for the user
 *    pointing, so a pointer resting over it took the highlight as End
 *    scrolled, and Enter chose the wrong patient.
 *  - A list scrolled by hand jumped back to the highlight when the page
 *    re-rendered: on Reports, every time the tab regained focus.
 *
 * The unit tests pin the logic against a stated geometry; these check what
 * the browser does.
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

const LAST = CASELOAD.length - 1

function name(index: number) {
  return `Case ${String(index).padStart(2, '0')}`
}

type Point = { x: number; y: number }
type SignIn = (role: 'doctor') => Promise<unknown>

type Picker = {
  title: string
  selector: string
  open: (page: Page) => Promise<void>
}

const PICKERS: Picker[] = [
  {
    title: 'Reports',
    selector: 'main [role=combobox]',
    open: async (page) => {
      await page.goto('/doctor/reports')
    },
  },
  {
    title: 'scheduling dialog',
    selector: 'dialog[open] [role=combobox]',
    open: async (page) => {
      await page.goto('/doctor/appointments')
      await page.getByRole('button', { name: /^Schedule appointment$/ }).first().click()
      await expect(page.locator('dialog[open]')).toBeVisible()
    },
  },
]

/**
 * Signs in, serves a caseload long enough to scroll in place of the
 * fixture's two, and opens the picker's list. Nothing leaves the browser.
 */
async function openList(
  page: Page,
  signInAs: SignIn,
  picker: Picker,
  viewport = { width: 1280, height: 720 },
): Promise<Locator> {
  await page.setViewportSize(viewport)
  await signInAs('doctor')
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
  await picker.open(page)

  const input = page.locator(picker.selector)
  await input.click()
  await expect(page.locator('[role=listbox] [role=option]')).toHaveCount(CASELOAD.length)
  await settle(page)
  return input
}

/**
 * Lets the page finish reacting: the scroll, the browser's hover update for
 * whatever moved under the pointer, and React's commit. The hover update
 * arrives after the scroll, so reading any sooner would miss exactly the
 * event that took the highlight in 3b1fc5b.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    for (let i = 0; i < 5; i++) await frame()
    await new Promise((resolve) => setTimeout(resolve, 250))
    await frame()
    await frame()
  })
}

/** The option the input names as active, and what a person sees of it. */
async function highlight(page: Page, selector: string) {
  await settle(page)
  return page.evaluate((sel) => {
    const input = document.querySelector(sel) as HTMLInputElement
    const list = document.getElementById(input.getAttribute('aria-controls') as string) as HTMLElement
    const id = input.getAttribute('aria-activedescendant')
    const option = id ? document.getElementById(id) : null
    if (!option) return null
    const listRect = list.getBoundingClientRect()
    const rect = option.getBoundingClientRect()
    const topmost = document.elementFromPoint(
      rect.left + Math.min(20, rect.width / 2),
      rect.top + rect.height / 2,
    )
    return {
      label: option.textContent?.trim() ?? '',
      // The option a screen reader hears is the one drawn highlighted.
      painted:
        option.classList.contains('bg-brand-50') &&
        list.querySelectorAll('[role=option].bg-brand-50').length === 1,
      insideList: rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1,
      // Nothing — a bar, a border, another card — is painted over it.
      uncovered: !!topmost && option.contains(topmost),
    }
  }, selector)
}

async function expectShown(page: Page, selector: string, expected: string) {
  const h = await highlight(page, selector)
  expect(h?.label, 'the active option').toBe(expected)
  expect(h?.painted, `${expected} drawn highlighted`).toBe(true)
  expect(h?.insideList, `${expected} inside the list`).toBe(true)
  expect(h?.uncovered, `${expected} not covered`).toBe(true)
}

async function activeLabel(page: Page, selector: string) {
  return (await highlight(page, selector))?.label
}

async function listScrollTop(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel) as HTMLInputElement
    return Math.round(
      (document.getElementById(input.getAttribute('aria-controls') as string) as HTMLElement)
        .scrollTop,
    )
  }, selector)
}

/** Waits for a scroll to finish, and returns where it ended. */
async function scrollComesToRest(page: Page, selector: string) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    await settle(page)
    const now = await listScrollTop(page, selector)
    if (now === last) return now
    last = now
  }
  throw new Error('the list never stopped scrolling')
}

/**
 * The scroll position of everything around the picker — the dialog body,
 * the page. Only the list itself may scroll.
 */
async function surroundingScroll(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const positions: number[] = []
    for (let el = document.querySelector(sel)?.parentElement; el; el = el.parentElement) {
      positions.push(Math.round(el.scrollTop))
    }
    positions.push(Math.round(window.scrollY))
    return positions
  }, selector)
}

async function listBox(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel) as HTMLInputElement
    const r = (document.getElementById(input.getAttribute('aria-controls') as string) as HTMLElement)
      .getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, bottom: r.bottom }
  }, selector)
}

/** The option drawn at a point on screen. */
async function optionAt(page: Page, at: Point) {
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y)?.closest('[role=option]')
    return hit?.textContent?.trim() ?? null
  }, at)
}

/** Moves the pointer onto the list's second row and leaves it there. */
async function restPointerOnList(page: Page, selector: string): Promise<Point> {
  const box = await listBox(page, selector)
  const at = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 60) }
  await page.mouse.move(at.x, at.y, { steps: 5 })
  await settle(page)
  return at
}

for (const picker of PICKERS) {
  test.describe(`the ${picker.title} patient picker`, () => {
    test('walks a long caseload by keyboard with the highlight in view', async ({
      page,
      signInAs,
    }) => {
      const input = await openList(page, signInAs, picker)
      const around = await surroundingScroll(page, picker.selector)
      await expectShown(page, picker.selector, name(0))

      for (let step = 1; step <= 12; step++) {
        await page.keyboard.press('ArrowDown')
        await expectShown(page, picker.selector, name(step))
      }

      await page.keyboard.press('End')
      await expectShown(page, picker.selector, name(LAST))
      await page.keyboard.press('ArrowDown')
      await expectShown(page, picker.selector, name(0))
      await page.keyboard.press('ArrowUp')
      await expectShown(page, picker.selector, name(LAST))
      await page.keyboard.press('Home')
      await expectShown(page, picker.selector, name(0))
      await page.keyboard.press('End')
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowUp')
      await expectShown(page, picker.selector, name(26))

      // Only the list moved: not the dialog body, not the page.
      expect(await surroundingScroll(page, picker.selector)).toEqual(around)

      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(name(26))
      await expect(input).toHaveAttribute('aria-expanded', 'false')

      // Reopened, the choice is where the list opens; Escape keeps it.
      await input.click()
      await expectShown(page, picker.selector, name(26))
      await page.keyboard.press('Home')
      await page.keyboard.press('Escape')
      await expect(input).toHaveValue(name(26))
    })

    test('a pointer resting over the list does not take the highlight as End scrolls it', async ({
      page,
      signInAs,
    }) => {
      const input = await openList(page, signInAs, picker)
      const at = await restPointerOnList(page, picker.selector)
      // The pointer did move onto the list, and pointed at Case 01.
      expect(await activeLabel(page, picker.selector)).toBe(name(1))

      await page.keyboard.press('End')

      // Another row now sits under the pointer, which has not moved…
      const under = await optionAt(page, at)
      expect(under).not.toBeNull()
      expect(under).not.toBe(name(1))
      expect(under).not.toBe(name(LAST))
      // …and the keyboard's choice stands, for the eye and for Enter.
      await expectShown(page, picker.selector, name(LAST))
      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(name(LAST))
    })

    test('a mousemove repeating the resting position is ignored', async ({ page, signInAs }) => {
      // What some engines send after a scroll, in addition to hover events.
      const input = await openList(page, signInAs, picker)
      const at = await restPointerOnList(page, picker.selector)
      await page.keyboard.press('End')
      await settle(page)

      const under = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement
        for (const type of ['mouseover', 'mousemove']) {
          hit.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
        }
        return hit.closest('[role=option]')?.textContent?.trim()
      }, at)
      expect(under).not.toBe(name(LAST))

      await expectShown(page, picker.selector, name(LAST))
      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(name(LAST))
    })

    test('moving the pointer moves the highlight, without scrolling the list', async ({
      page,
      signInAs,
    }) => {
      const input = await openList(page, signInAs, picker)
      const at = await restPointerOnList(page, picker.selector)
      await page.keyboard.press('End')
      await settle(page)
      const scrolled = await listScrollTop(page, picker.selector)

      const to = { x: at.x, y: at.y + 44 }
      await page.mouse.move(to.x, to.y, { steps: 4 })
      const pointedAt = await optionAt(page, to)

      expect(pointedAt).not.toBeNull()
      expect(await highlight(page, picker.selector)).toMatchObject({
        label: pointedAt,
        painted: true,
      })
      expect(await listScrollTop(page, picker.selector)).toBe(scrolled)
      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(pointedAt as string)
    })

    test('a list wheeled away from the highlight stays put through a tab return', async ({
      page,
      signInAs,
    }) => {
      await openList(page, signInAs, picker)
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowDown')
      await expectShown(page, picker.selector, name(3))

      // A wheel over the list with no pointer movement first — as when the
      // list opened under a pointer that has not moved since. Chrome then
      // sends no hover events at all, the state in which 3b1fc5b's list,
      // still "following", snapped back on the next render.
      const box = await listBox(page, picker.selector)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: box.left + box.width / 2,
        y: box.top + 30,
        deltaX: 0,
        deltaY: 300,
      })
      const scrolled = await scrollComesToRest(page, picker.selector)
      expect(scrolled).toBeGreaterThan(200)

      // The tab regains focus: supabase-js re-validates the session and the
      // auth provider re-resolves the profile, re-rendering Reports.
      const revalidated = page.waitForResponse((r) => r.url().includes('/rest/v1/user_account'))
      // Bubbling, as the browser sends it: supabase-js listens on window.
      await page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
      )
      await revalidated
      await settle(page)

      expect(await listScrollTop(page, picker.selector)).toBe(scrolled)
      expect(await activeLabel(page, picker.selector)).toBe(name(3))

      // The next key press asks to follow again.
      await page.keyboard.press('ArrowUp')
      await expectShown(page, picker.selector, name(2))
    })

    test('a wheel under the pointer moves neither the highlight nor itself back', async ({
      page,
      signInAs,
    }) => {
      await openList(page, signInAs, picker)
      await restPointerOnList(page, picker.selector)
      expect(await activeLabel(page, picker.selector)).toBe(name(1))

      await page.mouse.wheel(0, 300)
      const scrolled = await scrollComesToRest(page, picker.selector)
      expect(scrolled).toBeGreaterThan(200)

      // Rows scrolled under the resting pointer; none of them took over.
      expect(await activeLabel(page, picker.selector)).toBe(name(1))
      expect(await listScrollTop(page, picker.selector)).toBe(scrolled)

      await page.keyboard.press('ArrowDown')
      await expectShown(page, picker.selector, name(2))
    })
  })
}

test.describe('the picker and the mobile navigation bar', () => {
  /** The top of any fixed element across the lower half of the screen. */
  async function barTop(page: Page) {
    return page.evaluate(() => {
      const bars = [...document.querySelectorAll<HTMLElement>('body *')].filter(
        (el) =>
          getComputedStyle(el).position === 'fixed' &&
          el.getBoundingClientRect().top > window.innerHeight / 2 &&
          el.getBoundingClientRect().height > 0,
      )
      return bars.length ? Math.min(...bars.map((el) => el.getBoundingClientRect().top)) : null
    })
  }

  const [reports, scheduler] = PICKERS

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 360, height: 640 },
    { width: 320, height: 568 },
  ]) {
    const size = `${viewport.width}×${viewport.height}`

    test(`on a ${size} phone, the Reports list ends above the bar`, async ({ page, signInAs }) => {
      const input = await openList(page, signInAs, reports, viewport)
      const top = await barTop(page)
      expect(top, 'a navigation bar is drawn').not.toBeNull()
      expect((await listBox(page, reports.selector)).bottom).toBeLessThanOrEqual(top as number)

      const around = await surroundingScroll(page, reports.selector)
      await page.keyboard.press('End')
      await expectShown(page, reports.selector, name(LAST))
      expect(await surroundingScroll(page, reports.selector)).toEqual(around)

      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(name(LAST))
    })

    test(`on a ${size} phone, the scheduling dialog's list fits the dialog`, async ({
      page,
      signInAs,
    }) => {
      const input = await openList(page, signInAs, scheduler, viewport)
      const bodyBottom = await page.evaluate(() => {
        const input = document.querySelector('dialog[open] [role=combobox]') as HTMLElement
        for (let el = input.parentElement; el; el = el.parentElement) {
          if (getComputedStyle(el).overflowY !== 'visible') return el.getBoundingClientRect().bottom
        }
        return null
      })
      expect(bodyBottom, 'the dialog body clips the list').not.toBeNull()
      expect((await listBox(page, scheduler.selector)).bottom).toBeLessThanOrEqual(
        bodyBottom as number,
      )

      const around = await surroundingScroll(page, scheduler.selector)
      await page.keyboard.press('End')
      await expectShown(page, scheduler.selector, name(LAST))
      expect(await surroundingScroll(page, scheduler.selector)).toEqual(around)

      await page.keyboard.press('Enter')
      await expect(input).toHaveValue(name(LAST))
    })
  }

  test('on a desktop, where no bar is drawn, the Reports list keeps its full height', async ({
    page,
    signInAs,
  }) => {
    await openList(page, signInAs, reports)
    expect(await barTop(page)).toBeNull()
    const maxHeight = await page.evaluate(
      () => (document.querySelector('[role=listbox]') as HTMLElement).style.maxHeight,
    )
    expect(maxHeight).toBe('256px')
  })
})
