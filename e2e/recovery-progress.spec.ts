import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'
import { RECOVERY_WEEK } from './support/recovery-week'

/**
 * Recovery progress (the 2nd-half plan's progress charts) in a real browser:
 * the patient's panel on My recovery and the clinician's at the top of the
 * record's Recovery tab, the controls from the keyboard, and the layout at
 * 360px. The arithmetic is covered in tests/unit/recovery-progress.test.ts.
 *
 * Alice's week is RECOVERY_WEEK (e2e/support/recovery-week.ts): five of the
 * seven days have records, averaging 70%, and yesterday is the latest, at
 * 87.5%.
 */

const WEEK = RECOVERY_WEEK

function panel(page: Page) {
  return page.getByRole('region', { name: 'Recovery progress', exact: true })
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

test.describe('the patient’s recovery progress', () => {
  test('summarises the week below the journal', async ({ page, signInAs }) => {
    await signInAs('patient', WEEK)
    await page.goto('/patient/recovery')

    const progress = panel(page)
    await expect(progress.getByText('70%', { exact: true })).toBeVisible()
    await expect(progress.getByText('Based on 5 of 7 days with records.')).toBeVisible()
    await expect(progress.getByRole('radio', { name: '7 days' })).toBeChecked()

    // Below the entry and the journal, full width.
    const journal = await page.getByRole('heading', { name: 'Your journal' }).boundingBox()
    const heading = await progress.getByRole('heading', { name: 'Recovery progress', exact: true }).boundingBox()
    expect(heading!.y).toBeGreaterThan(journal!.y)
  })

  test('is driven from the keyboard', async ({ page, signInAs }) => {
    await signInAs('patient', WEEK)
    await page.goto('/patient/recovery')
    const progress = panel(page)
    await expect(progress.getByText('70%', { exact: true })).toBeVisible()

    // The period is a radio group: the arrow keys move the choice.
    await progress.getByRole('radio', { name: '7 days' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(progress.getByRole('radio', { name: '30 days' })).toBeChecked()
    await expect(progress.getByText('Based on 5 of 30 days with records.')).toBeVisible()

    // The chart is one tab stop, and the arrows read it a day at a time.
    const chart = progress.getByRole('group', { name: /Overall recovery progress by day/ })
    await chart.focus()
    const announcement = chart.locator('[data-chart-announcement]')
    await expect(announcement).toHaveText('Yesterday, 88%, Mood 75%, Medication 100%')
    await page.keyboard.press('ArrowRight')
    await expect(announcement).toHaveText('Today, No data, No rating and no resolved doses')
    await expect(chart.getByText('No rating and no resolved doses', { exact: true })).toBeVisible()

    // The indicator is a second radio group.
    await progress.getByRole('radio', { name: 'Mood' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(progress.getByRole('radio', { name: 'Medication' })).toBeChecked()
    await expect(progress.getByText('Doses taken', { exact: true })).toBeVisible()
    // 3 of 5 resolved doses taken across the period.
    await expect(progress.getByText('60%', { exact: true })).toBeVisible()

    // And every day is in a table, on request.
    const toggle = progress.getByRole('button', { name: 'Show the data table' })
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(progress.getByRole('table')).toBeVisible()
    await expect(progress.getByRole('table').getByRole('row')).toHaveCount(31)
  })

  test('fits a 360px phone without sideways scrolling, its tooltip inside the chart', async ({
    page,
    signInAs,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('patient', WEEK)
    await page.goto('/patient/recovery')
    const progress = panel(page)
    await expect(progress.getByText('70%', { exact: true })).toBeVisible()

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

    const chart = progress.getByRole('group', { name: /Overall recovery progress by day/ })
    await chart.scrollIntoViewIfNeeded()
    const box = (await chart.boundingBox())!
    expect(box.height).toBeCloseTo(180, 0)

    // Touch the last days, where a tooltip is most likely to spill out.
    await page.mouse.click(box.x + box.width - 16, box.y + box.height / 2)
    const tooltip = chart.locator('[aria-hidden="true"].absolute')
    await expect(tooltip).toBeVisible()
    const tip = (await tooltip.boundingBox())!
    expect(tip.x).toBeGreaterThanOrEqual(box.x - 1)
    expect(tip.x + tip.width).toBeLessThanOrEqual(box.x + box.width + 1)

    for (const indicator of ['Medication', 'Treatment goals']) {
      await progress.getByText(indicator, { exact: true }).click()
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    }
  })
})

test.describe('the clinician’s recovery progress', () => {
  test('heads the Recovery tab, above the recovery log', async ({ page, signInAs }) => {
    await signInAs('doctor', WEEK)
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=recovery`)

    const progress = panel(page)
    await expect(progress.getByText('70%', { exact: true })).toBeVisible()

    const log = await page.getByRole('heading', { name: 'Recovery log' }).boundingBox()
    const heading = await progress.getByRole('heading', { name: 'Recovery progress', exact: true }).boundingBox()
    expect(heading!.y).toBeLessThan(log!.y)

    // The overview keeps its own mood trend, unchanged.
    await page.getByRole('tab', { name: 'Overview' }).click()
    await expect(page.getByRole('heading', { name: 'Recovery trend' })).toBeVisible()
    await expect(panel(page)).toHaveCount(0)
  })

  test('shows the goals as they stand, not as a history', async ({ page, signInAs }) => {
    await signInAs('doctor', WEEK)
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=recovery`)
    const progress = panel(page)

    await progress.getByText('Treatment goals', { exact: true }).click()

    await expect(progress.getByText('0 of 1', { exact: false })).toBeVisible()
    await expect(progress.getByText(/does not follow the 7 or 30 days above/)).toBeVisible()
  })

  test('fits a 360px phone without sideways scrolling', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('doctor', WEEK)
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=recovery`)
    await expect(panel(page).getByText('70%', { exact: true })).toBeVisible()

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })
})
