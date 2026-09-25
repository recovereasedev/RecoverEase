import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * The administrator's system-wide report, printed in a real browser (modules
 * 9.3 and 9.4). "Print or save as PDF" and "Generate report" stay on screen;
 * printing sends the system summary and the list of generated reports without
 * them, or any other control, under the recovery report's letterhead, on A4,
 * and fits the paper. Served by the browser-only stub; nothing is written
 * anywhere.
 */

const RECORD = {
  'rpc/admin_dashboard_stats': [
    {
      patients: { total: 7, active: 6 },
      doctors: { total: 3, active: 2 },
      accounts: { admin: 1, doctor: 3, patient: 7 },
      appointments: { upcoming: 5 },
      generated_at: new Date().toISOString(),
    },
  ],
  report: [
    {
      report_id: 'rep-1',
      user_id: IDS.adminUser,
      pat_id: null,
      report_type: 'system_wide',
      report_generated_at: '2026-09-12T10:00:00Z',
      patient: null,
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

/** Every request that could change data. The figures are read through a
 *  database function, which supabase-js calls with POST, so those are reads. */
function watchForWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const isData = url.includes('/rest/v1/') || url.includes('/functions/v1/')
    const isRead =
      request.method() === 'GET' ||
      request.method() === 'HEAD' ||
      url.includes('/rest/v1/rpc/admin_dashboard_stats')
    if (isData && !isRead) writes.push(`${request.method()} ${url}`)
  })
  return writes
}

/** Pages in a PDF of what the browser would print. */
async function printedPages(page: Page): Promise<number> {
  const pdf = (await page.pdf({ printBackground: true })).toString('latin1')
  return (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

/** The page sizes, in points, of what Chrome's "Save as PDF" would produce. */
async function printedPaper(page: Page): Promise<string[]> {
  const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1')
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
  return [...new Set(boxes.map((box) => `${Math.round(Number(box[1]))}x${Math.round(Number(box[2]))}`))]
}

/** The generated report's row in the list, not the letterhead's title. */
const reportRow = (page: Page) =>
  page.getByRole('listitem').getByText('System-wide report', { exact: true })

async function openReports(page: Page) {
  await page.goto('/admin/reports')
  await expect(reportRow(page)).toBeVisible()
  await expect(page.getByText('Patients on record')).toBeVisible()
}

test.describe('printing the system-wide report', () => {
  test('keeps Print or save as PDF and Generate report on screen', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', RECORD)
    await openReports(page)

    await expect(page.getByRole('button', { name: /print or save as pdf/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /generate report/i })).toBeVisible()
  })

  test('prints the report without its controls, and writes nothing', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('admin', RECORD)
    await openReports(page)

    await page.emulateMedia({ media: 'print' })

    await expect(page.getByRole('button', { name: /print or save as pdf/i })).toBeHidden()
    await expect(page.getByRole('button', { name: /generate report/i })).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()

    // The letterhead in place of the page header: what this is, when it was
    // printed and by whom.
    await expect(page.getByRole('heading', { level: 2, name: 'System-wide report' })).toBeVisible()
    await expect(page.getByText('Printed', { exact: true })).toBeVisible()
    await expect(page.getByText('Prepared by', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeHidden()

    // The report, as the page already showed it.
    await expect(page.getByText('System summary')).toBeVisible()
    await expect(page.getByText('Patients on record')).toBeVisible()
    await expect(page.getByText('6 active')).toBeVisible()
    await expect(page.getByText('Upcoming appointments')).toBeVisible()
    await expect(page.getByText('Recently generated reports')).toBeVisible()
    await expect(reportRow(page)).toBeVisible()

    // Nothing to press on paper.
    expect(await page.locator('main button:visible').count()).toBe(0)

    expect(await printedPages(page)).toBe(1)
    // A4, the recovery report's paper, not the browser's default Letter.
    expect(await printedPaper(page)).toEqual(['595x842'])
    expect(errors).toEqual([])
    expect(writes).toEqual([])
  })

  test('fits the paper width, with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('admin', RECORD)
    await openReports(page)

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
