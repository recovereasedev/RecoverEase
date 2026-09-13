import { expect, test, type Page } from './support/fixtures'

/**
 * QA 9/13 — the patient's printed prescription, in a real browser.
 *
 * The unit tests pin what the page marks for paper. These check what only a
 * browser can: that printing leaves the application and the rest of the page
 * behind and sends a letterhead naming the patient and their doctor above the
 * prescriptions, that it fits the paper, and that the screen is unchanged.
 * The record is served by the browser-only stub; nothing is written anywhere.
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

/** Pages in a PDF of what the browser would print. */
async function printedPages(page: Page): Promise<number> {
  const pdf = (await page.pdf({ printBackground: true })).toString('latin1')
  return (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

test.describe('the printed prescription', () => {
  test('leaves the screen as it was', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient')
    await page.goto('/patient/medications')

    await expect(page.getByText('Take with food.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Medication' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Due today' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible()
    await expect(page.locator('[data-prescription-print-header]')).toBeHidden()
  })

  test('prints the prescriptions under the patient and doctor names, and nothing else', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient')
    await page.goto('/patient/medications')
    await expect(page.getByText('Take with food.')).toBeVisible()

    await page.emulateMedia({ media: 'print' })

    // The application and the rest of the page stay on screen.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('heading', { level: 1, name: 'Medication' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Due today' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Coming up' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'This week' })).toBeHidden()

    // The letterhead names both, from the records.
    const letterhead = page.locator('[data-prescription-print-header]')
    await expect(letterhead).toBeVisible()
    await expect(letterhead.getByRole('heading', { name: 'Prescription', exact: true })).toBeVisible()
    await expect(letterhead.getByText('Alice Santos', { exact: true })).toBeVisible()
    await expect(letterhead.getByText('Dr. Alan Cruz', { exact: true })).toBeVisible()

    // The prescription itself, as the page already showed it.
    await expect(page.getByRole('heading', { name: 'Your prescriptions' })).toBeVisible()
    const prescription = page.locator('li').filter({ hasText: '08:00, 20:00' })
    await expect(prescription).toBeVisible()
    await expect(prescription).toContainText('Paracetamol')
    await expect(prescription).toContainText('500mg')
    await expect(prescription).toContainText('ongoing')
    await expect(page.getByText('Take with food.')).toBeVisible()

    // Nothing to press on paper.
    expect(await page.locator('main button:visible').count()).toBe(0)

    expect(await printedPages(page)).toBe(1)
    expect(errors).toEqual([])
  })

  test('fits the paper width, with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient')
    await page.goto('/patient/medications')
    await expect(page.getByText('Take with food.')).toBeVisible()

    // About the printable width of A4 or Letter paper, in CSS pixels.
    await page.setViewportSize({ width: 688, height: 1000 })
    await page.emulateMedia({ media: 'print' })

    const overflow = await page.locator('main').evaluate((main) => ({
      page: { scroll: document.documentElement.scrollWidth, inner: window.innerWidth },
      wide: [...main.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.offsetParent !== null)
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => `${element.tagName}.${element.className}`.slice(0, 80)),
    }))
    expect(overflow.wide).toEqual([])
    expect(overflow.page.scroll).toBeLessThanOrEqual(overflow.page.inner)
  })

  test('says the doctor is not available rather than naming anyone', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', { doctor: [] })
    await page.goto('/patient/medications')
    await expect(page.getByText('Take with food.')).toBeVisible()

    await page.emulateMedia({ media: 'print' })

    const letterhead = page.locator('[data-prescription-print-header]')
    await expect(letterhead.getByText('Alice Santos', { exact: true })).toBeVisible()
    await expect(letterhead.getByText('Not available', { exact: true })).toBeVisible()
    await expect(letterhead.getByText(/Dr\./)).toHaveCount(0)
  })
})
