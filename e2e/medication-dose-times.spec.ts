import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * Setting a medication schedule by frequency and interval, in a real browser
 * (group QA 9/12/26, item 4). The doctor gives 3 a day, every 4 hours, from
 * 08:00; the form shows 08:00, 12:00 and 16:00 and saves those times.
 *
 * Served by the browser-only stub, so nothing is written anywhere. The stub
 * has no database trigger, so the doses generated from these times are
 * covered by tests/db/medication-dose-times.test.ts instead.
 */

/** Console errors and uncaught exceptions, for asserting there were none. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

const doseTimes = (page: Page) => page.getByRole('list', { name: 'Dose times' }).getByRole('listitem')

test.describe('a medication schedule set by frequency and interval', () => {
  test('works out 08:00, 12:00 and 16:00 from 3 a day every 4 hours, and saves them', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    const stub = await signInAs('doctor')

    // Bob has no prescription yet, so this issues one with its first medicine.
    await page.goto(`/doctor/patients/${IDS.bobPat}?tab=medication`)
    await page.getByRole('button', { name: /^Add prescription$/ }).click()

    await page.getByLabel(/medicine/i).fill('Amoxicillin')
    await page.getByLabel(/dosage/i).fill('500 mg')
    await page.getByLabel(/doses a day/i).fill('3')
    await page.getByLabel(/hours between doses/i).fill('4')
    await page.getByLabel(/first dose at/i).fill('08:00')

    await expect(doseTimes(page)).toHaveText(['08:00', '12:00', '16:00'])
    await expect(page.getByRole('button', { name: /add another time/i })).toHaveCount(0)

    await page.getByRole('button', { name: /^Add prescription$/ }).click()

    // The saved row carries the worked-out times, and a frequency to match.
    await expect
      .poll(() =>
        stub
          .rowsIn('medication_schedule')
          .filter((row) => row.medication_schedule_name === 'Amoxicillin'),
      )
      .toHaveLength(1)
    const [saved] = stub
      .rowsIn('medication_schedule')
      .filter((row) => row.medication_schedule_name === 'Amoxicillin')
    expect(saved).toMatchObject({
      medication_schedule_frequency: 3,
      medication_schedule_times: ['08:00', '12:00', '16:00'],
    })

    // And the record reads it back as the clinician set it.
    await expect(page.getByText('Amoxicillin')).toBeVisible()
    await expect(page.getByText(/3× daily at/)).toBeVisible()
    await expect(page.getByText('08:00, 12:00, 16:00')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('updates the times as the fields change, and refuses a day that runs past midnight', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.bobPat}?tab=medication`)
    await page.getByRole('button', { name: /^Add prescription$/ }).click()

    // One dose a day needs no interval.
    await expect(page.getByLabel(/hours between doses/i)).toBeDisabled()
    await expect(doseTimes(page)).toHaveText(['08:00'])

    await page.getByLabel(/doses a day/i).fill('4')
    await page.getByLabel(/hours between doses/i).fill('6')
    await page.getByLabel(/first dose at/i).fill('00:00')
    await expect(doseTimes(page)).toHaveText(['00:00', '06:00', '12:00', '18:00'])

    await page.getByLabel(/first dose at/i).fill('06:00')
    await expect(doseTimes(page)).toHaveCount(0)
    await expect(page.getByText(/would run past midnight/).first()).toBeVisible()

    await page.getByLabel(/medicine/i).fill('Ibuprofen')
    await page.getByLabel(/dosage/i).fill('200 mg')
    await page.getByRole('button', { name: /^Add prescription$/ }).click()

    await expect(page.getByLabel(/first dose at/i)).toHaveAttribute('aria-invalid', 'true')
    expect(stub.rowsIn('prescription').filter((row) => row.pat_id === IDS.bobPat)).toHaveLength(0)
    expect(stub.rowsIn('medication_schedule').filter((row) => row.medication_schedule_name === 'Ibuprofen')).toHaveLength(0)
  })

  test('fits a phone without widening the page', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.bobPat}?tab=medication`)
    await page.getByRole('button', { name: /^Add prescription$/ }).click()

    await page.getByLabel(/doses a day/i).fill('3')
    await page.getByLabel(/hours between doses/i).fill('4')
    await expect(doseTimes(page)).toHaveText(['08:00', '12:00', '16:00'])

    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }))
    expect(width.scroll).toBeLessThanOrEqual(width.inner)
  })
})
