import { expect, test, type Page } from './support/fixtures'

/**
 * The patient's treatment plan, printed in a real browser (module 3.5).
 * "Print or save as PDF" stays on screen; printing sends the plan without it,
 * or any other control, and fits the paper. Served by the browser-only stub;
 * nothing is written anywhere.
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

async function openTreatmentPlan(page: Page) {
  await page.goto('/patient/treatment')
  await expect(page.getByText('Post-operative knee recovery')).toBeVisible()
}

test.describe('printing the treatment plan', () => {
  test('keeps "Print or save as PDF" on screen', async ({ page, signInAs }) => {
    await signInAs('patient')
    await openTreatmentPlan(page)

    await expect(page.getByRole('button', { name: /print or save as pdf/i })).toBeVisible()
  })

  test('prints the plan without its print control', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient')
    await openTreatmentPlan(page)

    await page.emulateMedia({ media: 'print' })

    await expect(page.getByRole('button', { name: /print or save as pdf/i })).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()

    // The plan, as the page already showed it.
    await expect(page.getByRole('heading', { level: 1, name: 'Treatment plan' })).toBeVisible()
    await expect(page.getByText('Post-operative knee recovery')).toBeVisible()
    await expect(page.getByText('Twelve week programme.')).toBeVisible()
    await expect(page.getByText('Walk 500 metres unaided')).toBeVisible()

    // Nothing to press on paper.
    expect(await page.locator('main button:visible').count()).toBe(0)

    expect(await printedPages(page)).toBe(1)
    expect(errors).toEqual([])
  })

  test('fits the paper width, with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient')
    await openTreatmentPlan(page)

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
})
