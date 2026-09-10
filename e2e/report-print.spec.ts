import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * The patient report, previewed and printed in a real browser.
 *
 * The unit tests pin what the report says. These check what only a browser
 * can: that printing leaves the application behind and sends just the
 * document, on A4, across as many pages as the record needs, without a
 * table running off the paper — and that the preview itself works on a
 * phone. The record is served by the browser-only stub; nothing is written
 * anywhere.
 */

function daysAgo(days: number): string {
  const when = new Date()
  when.setDate(when.getDate() - days)
  return when.toISOString().slice(0, 10)
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

const LONG_NOTE =
  'Walked to the end of the road and back twice with the frame, then practised the stairs at home with the rail. ' +
  'Some stiffness in the evening that eased after the exercises; slept through the night. '.repeat(3)

const NOTE = 'Wound healing well.\nContinue physiotherapy twice weekly.'

/** Seventy days of journal: enough to run the report onto several pages. */
function journal(days: number) {
  return Array.from({ length: days }, (_, index) => ({
    recovery_log_id: `log-${index}`,
    pat_id: IDS.alicePat,
    recovery_log_date: daysAgo(index),
    recovery_log_notes:
      index === 3
        ? LONG_NOTE
        : index % 6 === 0
          ? null
          : `Exercises done; ${index % 3 === 0 ? 'some stiffness in the evening' : 'felt steady'}.`,
    recovery_log_mood_rating: index % 7 === 0 ? null : (index % 5) + 1,
    recovery_log_created_at: `${daysAgo(index)}T09:00:00Z`,
  }))
}

const PRESCRIPTION = {
  prescription_id: 'rx-e2e',
  pat_id: IDS.alicePat,
  doc_id: IDS.doctorA,
  prescription_issued_date: daysAgo(30),
  prescription_notes: 'Take with food.',
  prescription_created_at: `${daysAgo(30)}T00:00:00Z`,
}

const RECORD = {
  recovery_log: journal(70),
  medication_schedule: [
    {
      medication_schedule_id: 'ms-1',
      prescription_id: PRESCRIPTION.prescription_id,
      medication_schedule_name: 'Paracetamol',
      medication_schedule_dosage: '500mg',
      medication_schedule_frequency: 2,
      medication_schedule_times: ['08:00:00', '20:00:00'],
      medication_schedule_start_date: daysAgo(30),
      medication_schedule_end_date: null,
      medication_schedule_created_at: `${daysAgo(30)}T00:00:00Z`,
      prescription: PRESCRIPTION,
    },
  ],
  medication_log: [
    ['taken', 30],
    ['taken', 20],
    ['missed', 10],
  ].map(([status, hours], index) => ({
    medication_log_id: `dose-${index}`,
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: hoursAgo(hours as number),
    medication_log_status: status,
    medication_log_taken_at: status === 'taken' ? hoursAgo(hours as number) : null,
    medication_schedule: {
      medication_schedule_name: 'Paracetamol',
      medication_schedule_dosage: '500mg',
      prescription: { pat_id: IDS.alicePat },
    },
  })),
  doctor_note: [
    {
      doctor_note_id: 'note-1',
      pat_id: IDS.alicePat,
      doc_id: IDS.doctorA,
      doctor_note_text: NOTE,
      doctor_note_created_at: hoursAgo(48),
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

async function generateFor(page: Page, name: string) {
  await page.goto('/doctor/reports')
  const picker = page.getByRole('combobox', { name: /patient/i })
  await picker.click()
  await page.getByRole('option', { name }).click()
  await page.getByRole('button', { name: /generate report/i }).click()

  const preview = page.getByRole('region', { name: 'Report preview' })
  await expect(preview.locator('[data-report-document]')).toBeVisible()
  return preview
}

/** Pages in a PDF, and its page size in points (A4 is 595 × 842). */
async function printToPdf(page: Page) {
  const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1')
  const box = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/)
  return {
    pages: (pdf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length,
    width: Number(box?.[1]),
    height: Number(box?.[2]),
  }
}

test.describe('the patient report', () => {
  test('previews the report just generated, in both copies', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)

    const preview = await generateFor(page, 'Alice Santos')
    const sheet = preview.locator('[data-report-document]')

    await expect(sheet.getByRole('heading', { name: /patient care report/i })).toBeVisible()
    await expect(sheet.getByText('Alice Santos', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Paracetamol')).toBeVisible()
    await expect(sheet.getByText(/2 taken, 1 missed, 0 skipped of 3/)).toBeVisible()
    await expect(sheet.getByText(/Wound healing well/)).toBeVisible()
    await expect(sheet.getByRole('img', { name: 'RecoverEase' })).toBeVisible()

    await preview.getByRole('button', { name: 'Patient copy' }).click()
    await expect(sheet.getByRole('heading', { name: /patient recovery report/i })).toBeVisible()
    await expect(sheet.getByText(/Wound healing well/)).toHaveCount(0)

    // The patient appears in the document and nowhere else.
    await expect(page).toHaveTitle('RecoverEase | Reports')
    await expect(page).toHaveURL(/\/doctor\/reports$/)
    expect(errors).toEqual([])
  })

  test('prints only the document, on A4, across the pages it needs', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    const preview = await generateFor(page, 'Alice Santos')

    await page.emulateMedia({ media: 'print' })

    // The application stays on screen; the document goes to paper.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await expect(page.getByRole('banner')).toBeHidden()
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeHidden()
    await expect(page.getByRole('button', { name: /generate report/i })).toBeHidden()
    await expect(preview.getByRole('button', { name: /print or save as pdf/i })).toBeHidden()
    await expect(preview.getByRole('button', { name: 'Patient copy' })).toBeHidden()
    await expect(preview.locator('[data-report-document]')).toBeVisible()

    // A long table's header row repeats on each page it runs onto.
    const headerDisplay = await preview
      .locator('[data-report-document] thead')
      .first()
      .evaluate((head) => getComputedStyle(head).display)
    expect(headerDisplay).toBe('table-header-group')

    const pdf = await printToPdf(page)
    expect(Math.round(pdf.width)).toBe(595)
    expect(Math.round(pdf.height)).toBe(842)
    expect(pdf.pages).toBeGreaterThan(1)
    expect(errors).toEqual([])
  })

  test('fits the A4 width in print, with no table running off the page', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    await generateFor(page, 'Alice Santos')

    // 210mm less 14mm margins either side is about 688 CSS pixels.
    await page.setViewportSize({ width: 688, height: 1000 })
    await page.emulateMedia({ media: 'print' })

    for (const variant of ['Clinical copy', 'Patient copy']) {
      if (variant === 'Patient copy') {
        await page.emulateMedia({ media: 'screen' })
        await page.getByRole('button', { name: variant }).click()
        await page.emulateMedia({ media: 'print' })
      }
      const overflow = await page.locator('[data-report-document]').evaluate((sheet) => {
        const wide = [sheet, ...sheet.querySelectorAll<HTMLElement>('table, div, p, dl')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => `${element.tagName}.${element.className}`.slice(0, 80))
        return {
          sheet: { scroll: sheet.scrollWidth, client: sheet.clientWidth },
          wide,
        }
      })
      expect(overflow.wide, `${variant}: nothing wider than its box`).toEqual([])
      expect(overflow.sheet.scroll).toBeLessThanOrEqual(overflow.sheet.client + 1)
    }
  })

  test('prints an empty record as intentional empty sections on one page', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor')
    const preview = await generateFor(page, 'Bob Reyes')
    const sheet = preview.locator('[data-report-document]')

    await expect(sheet.getByText('No recovery entries recorded')).toBeVisible()
    await expect(sheet.getByText('No treatment plan on record')).toBeVisible()
    await expect(sheet.getByText('No prescriptions on record')).toBeVisible()
    await expect(sheet.getByText('No clinical notes recorded')).toBeVisible()
    await expect(sheet.locator('table')).toHaveCount(0)

    const pdf = await printToPdf(page)
    expect(pdf.pages).toBe(1)
  })

  test('still prints the list of reports when the list is asked for', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', RECORD)
    const preview = await generateFor(page, 'Alice Santos')

    // The print dialog itself is the browser's; stand it in so the page's
    // own choice of what to print can be inspected.
    await page.evaluate(() => {
      window.print = () => {}
    })
    await page.getByRole('button', { name: /print list/i }).click()
    await page.emulateMedia({ media: 'print' })

    await expect(page.getByRole('heading', { name: 'Generated reports' })).toBeVisible()
    await expect(preview.locator('[data-report-document]')).toBeHidden()
  })
})

test.describe('the report preview on smaller screens', () => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
  ]) {
    test(`is readable at ${viewport.width}×${viewport.height} without widening the page`, async ({
      page,
      signInAs,
    }) => {
      await page.setViewportSize(viewport)
      await signInAs('doctor', RECORD)
      const preview = await generateFor(page, 'Alice Santos')

      await expect(preview.getByRole('button', { name: /print or save as pdf/i })).toBeVisible()
      await expect(preview.locator('[data-report-document]').getByText('Alice Santos', { exact: true })).toBeVisible()

      const page_ = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }))
      expect(page_.scroll).toBeLessThanOrEqual(page_.inner)
    })
  }
})

test('a patient cannot reach the report preview', async ({ page, signInAs }) => {
  await signInAs('patient')
  await page.goto('/doctor/reports')

  await expect(page).not.toHaveURL(/\/doctor\/reports/)
  await expect(page.getByRole('region', { name: 'Report preview' })).toHaveCount(0)
})
