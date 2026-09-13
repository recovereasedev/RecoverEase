import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * QA 9/12 — on the clinician's patient record, printing lives on the
 * Medication tab only, as "Print prescription"; the other tabs are covered by
 * Reports. In a real browser: which tabs offer printing, what the printed
 * prescription carries, that it fits the paper, that the screen is unchanged,
 * and that printing sends nothing but reads. Served by the browser-only stub.
 */

const PRESCRIPTION = {
  prescription_id: 'rx-print',
  prescription_issued_date: '2026-09-01',
  prescription_notes: 'Take with food.',
  pat_id: IDS.alicePat,
}

const RECORD = {
  prescription: [PRESCRIPTION],
  medication_schedule: [
    {
      medication_schedule_id: 'ms-print',
      prescription_id: PRESCRIPTION.prescription_id,
      medication_schedule_name: 'Amoxicillin',
      medication_schedule_dosage: '500mg',
      medication_schedule_frequency: 2,
      medication_schedule_times: ['08:00:00', '20:00:00'],
      medication_schedule_start_date: '2026-09-01',
      medication_schedule_end_date: null,
      medication_schedule_created_at: '2026-09-01T00:00:00Z',
      prescription: PRESCRIPTION,
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

/** Every request that could change data: anything but a read. */
function watchForWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const isData = url.includes('/rest/v1/') || url.includes('/functions/v1/')
    const isRead =
      request.method() === 'GET' ||
      request.method() === 'HEAD' ||
      url.includes('/rest/v1/rpc/app_today')
    if (isData && !isRead) writes.push(`${request.method()} ${url}`)
  })
  return writes
}

/** Pages in a PDF of what the browser would print. */
async function printedPages(page: Page): Promise<number> {
  const pdf = (await page.pdf({ printBackground: true })).toString('latin1')
  return (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

async function openMedicationTab(page: Page) {
  await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
  await expect(page.getByText('Amoxicillin', { exact: true })).toBeVisible()
}

test.describe('printing from the patient record', () => {
  test('offers nothing to print on overview, recovery, treatment or notes', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', RECORD)
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Alice Santos' })).toBeVisible()

    for (const tab of ['Overview', 'Recovery', 'Treatment', 'Notes']) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: /print/i }), tab).toHaveCount(0)
    }
  })

  test('prints the prescription from the medication tab, and writes nothing', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await openMedicationTab(page)

    // The print dialog is the browser's; stand it in to see the button use it.
    await page.evaluate(() => {
      ;(window as unknown as { printed: number }).printed = 0
      window.print = () => {
        ;(window as unknown as { printed: number }).printed += 1
      }
    })
    await page.getByRole('button', { name: 'Print prescription' }).click()
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)

    await page.emulateMedia({ media: 'print' })

    // The application, the record's header, its tabs and its controls stay on screen.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('heading', { level: 1, name: 'Alice Santos' })).toBeHidden()
    await expect(page.getByRole('tablist')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Print prescription' })).toBeHidden()
    await expect(page.getByRole('button', { name: /end medication/i })).toBeHidden()
    await expect(page.getByRole('button', { name: /add another medicine/i })).toBeHidden()

    // The letterhead names both, from the records.
    const letterhead = page.locator('[data-prescription-print-header]')
    await expect(letterhead).toBeVisible()
    await expect(letterhead.getByRole('heading', { name: 'Prescription', exact: true })).toBeVisible()
    await expect(letterhead.getByText('Alice Santos', { exact: true })).toBeVisible()
    await expect(letterhead.getByText('Dr. Alan Cruz', { exact: true })).toBeVisible()

    // The prescription itself, with its notes.
    const prescription = page.locator('li').filter({ hasText: '08:00, 20:00' })
    await expect(prescription).toBeVisible()
    await expect(prescription).toContainText('Amoxicillin')
    await expect(prescription).toContainText('500mg')
    await expect(prescription).toContainText('ongoing')
    await expect(prescription.getByText('Take with food.')).toBeVisible()

    // Nothing to press on paper.
    expect(await page.locator('main button:visible').count()).toBe(0)

    expect(await printedPages(page)).toBe(1)
    expect(errors).toEqual([])
    expect(writes).toEqual([])
  })

  test('fits the paper width, with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await openMedicationTab(page)

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

  test('leaves the screen as it was', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await openMedicationTab(page)

    await expect(page.getByRole('heading', { level: 1, name: 'Alice Santos' })).toBeVisible()
    await expect(page.getByRole('tablist')).toBeVisible()
    await expect(page.getByRole('button', { name: /end medication/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /add another medicine/i })).toBeVisible()
    await expect(page.locator('[data-prescription-print-header]')).toBeHidden()
    await expect(page.getByText('Take with food.')).toBeHidden()
  })
})
