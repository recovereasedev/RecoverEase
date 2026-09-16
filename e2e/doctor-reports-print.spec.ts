import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * The doctor's list of generated reports, printed in a real browser (module
 * 9.2). The page header, "Generate a recovery report" and "Print list" stay on
 * screen; printing the list sends its heading and its reports without them,
 * or any other control, and fits the paper. Served by the browser-only stub;
 * nothing is generated or written anywhere.
 */

const RECORD = {
  report: [
    {
      report_id: 'rep-1',
      user_id: IDS.doctorAUser,
      pat_id: IDS.alicePat,
      report_type: 'patient_recovery',
      report_generated_at: '2026-09-12T10:00:00Z',
      report_file_path: null,
      patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
    },
    {
      report_id: 'rep-2',
      user_id: IDS.doctorAUser,
      pat_id: IDS.bobPat,
      report_type: 'patient_recovery',
      report_generated_at: '2026-09-10T08:30:00Z',
      report_file_path: null,
      patient: { pat_first_name: 'Bob', pat_last_name: 'Reyes' },
    },
  ],
}

/** Console errors and uncaught exceptions, for asserting there were none. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** Every request that could change data. */
function watchForWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const isData = url.includes('/rest/v1/') || url.includes('/functions/v1/')
    const isRead = request.method() === 'GET' || request.method() === 'HEAD'
    if (isData && !isRead) writes.push(`${request.method()} ${url}`)
  })
  return writes
}

/** Pages in a PDF of what the browser would print. */
async function printedPages(page: Page): Promise<number> {
  const pdf = (await page.pdf({ printBackground: true })).toString('latin1')
  return (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

const reportRow = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ hasText: name })

async function openReports(page: Page) {
  await page.goto('/doctor/reports')
  await expect(reportRow(page, 'Alice Santos')).toBeVisible()
  await expect(reportRow(page, 'Bob Reyes')).toBeVisible()
}

test.describe('printing the list of generated reports', () => {
  test('keeps the page header, the Generate form and Print list on screen', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', RECORD)
    await openReports(page)

    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Generate a recovery report' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /patient/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /generate report/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /print list/i })).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'Generated reports' })).toBeVisible()
  })

  test('prints the list without its controls, and writes nothing', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await openReports(page)

    // The print dialog itself is the browser's; stand it in so the page's
    // own choice of what to print can be inspected.
    await page.evaluate(() => {
      window.print = () => {}
    })
    await page.getByRole('button', { name: /print list/i }).click()
    await page.emulateMedia({ media: 'print' })

    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Generate a recovery report' })).toBeHidden()
    await expect(page.getByRole('combobox', { name: /patient/i })).toBeHidden()
    await expect(page.getByRole('button', { name: /generate report/i })).toBeHidden()
    await expect(page.getByRole('button', { name: /print list/i })).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()

    // The list, as the page already showed it.
    await expect(page.getByRole('heading', { name: 'Generated reports' })).toBeVisible()
    await expect(reportRow(page, 'Alice Santos')).toBeVisible()
    await expect(reportRow(page, 'Bob Reyes')).toBeVisible()

    // Nothing to press or fill in on paper.
    expect(await page.locator('main button:visible').count()).toBe(0)
    expect(await page.locator('main :is(input, select, textarea):visible').count()).toBe(0)

    expect(await printedPages(page)).toBe(1)
    expect(errors).toEqual([])
    expect(writes).toEqual([])
  })

  test('fits the paper width, with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await openReports(page)

    // About the printable width of A4 or Letter paper, in CSS pixels.
    await page.setViewportSize({ width: 688, height: 1000 })
    await page.emulateMedia({ media: 'print' })

    await expect(reportRow(page, 'Alice Santos')).toBeVisible()
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
