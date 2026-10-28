import { readFile } from 'node:fs/promises'

import { strFromU8, unzipSync } from 'fflate'

import { pdfLines } from '../tests/unit/support/pdf-text'
import type { Download } from '@playwright/test'

import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * Modules 3.5, 4.10 and 9.4 in a real browser: each Download button hands the
 * browser a real file - a download event, with a proper file name - whose
 * contents are the record the page shows. The unit tests pin what each file
 * says; these check that the browser actually receives it, on a desktop and
 * a phone, that nothing is written anywhere, and that nothing errors. The
 * record is served by the browser-only stub.
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

/** Every request that could change data. Database functions are POSTed by
 *  supabase-js, so the report's figures read that way count as reads. */
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

async function downloadFrom(page: Page, name: string): Promise<{ file: Download; bytes: Uint8Array }> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name, exact: true }).click(),
  ])
  const path = await file.path()
  return { file, bytes: new Uint8Array(await readFile(path)) }
}

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'

/** The reader's own clinic, which `clinic_select_member` returns to its members. */
const CLINIC = {
  clinic_id: IDS.clinic,
  clinic_name: 'Harborview Recovery Clinic',
  clinic_status: 'active',
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-01-01T00:00:00Z',
  clinic_updated_at: '2026-01-01T00:00:00Z',
}

test.describe('downloading documents', () => {
  test('the patient downloads their prescription as a PDF', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await signInAs('patient', { clinic: [CLINIC] })
    await page.goto('/patient/medications')
    await expect(page.getByText('Take with food.')).toBeVisible()
    await expect(page.getByText(/^Issued 1 February( 2026)? · Prescribed by Dr\. Alan Cruz$/)).toBeVisible()

    const { file, bytes } = await downloadFrom(page, 'Download prescription (PDF)')

    expect(file.suggestedFilename()).toMatch(/^recoverease-prescription-alice-santos-\d{4}-\d{2}-\d{2}\.pdf$/)
    expect(isPdf(bytes)).toBe(true)
    const text = (await pdfLines(bytes)).join(' ')
    for (const expected of [
      'Harborview Recovery Clinic Prescription',
      'Prescribing physician',
      'Dr. Alan Cruz',
      'Date issued 1 Feb 2026',
      'Alice Santos',
      'Paracetamol',
      'Take with food.',
    ]) {
      expect(text, expected).toContain(expected)
    }
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })

  test('the patient with nothing prescribed is told why there is nothing to download', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', { medication_schedule: [], medication_log: [] })
    await page.goto('/patient/medications')

    const button = page.getByRole('button', { name: 'Download prescription (PDF)', exact: true })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAccessibleDescription(/no prescription to download yet/)
  })

  test('the patient downloads their treatment plan as a PDF', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await signInAs('patient')
    await page.goto('/patient/treatment')
    await expect(page.getByRole('heading', { name: 'Post-operative knee recovery' })).toBeVisible()

    const { file, bytes } = await downloadFrom(page, 'Download plan (PDF)')

    expect(file.suggestedFilename()).toMatch(/^recoverease-treatment-plan-alice-santos-\d{4}-\d{2}-\d{2}\.pdf$/)
    expect(isPdf(bytes)).toBe(true)
    expect(await pdfLines(bytes)).toEqual(
      expect.arrayContaining(['Treatment plan', 'Alice Santos', 'Post-operative knee recovery']),
    )
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })

  test('the doctor downloads a patient’s prescription from the record', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    // The record as the doctor's print spec serves it: one prescription.
    const prescription = {
      prescription_id: 'rx-download',
      prescription_issued_date: '2026-09-01',
      prescription_notes: 'Take with food.',
      doc_id: IDS.doctorA,
      pat_id: IDS.alicePat,
    }
    await signInAs('doctor', {
      clinic: [CLINIC],
      prescription: [prescription],
      medication_schedule: [
        {
          medication_schedule_id: 'ms-download',
          prescription_id: prescription.prescription_id,
          medication_schedule_name: 'Amoxicillin',
          medication_schedule_dosage: '500mg',
          medication_schedule_frequency: 2,
          medication_schedule_times: ['08:00:00', '20:00:00'],
          medication_schedule_start_date: '2026-09-01',
          medication_schedule_end_date: null,
          medication_schedule_created_at: '2026-09-01T00:00:00Z',
          prescription,
        },
      ],
    })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    await expect(page.getByRole('button', { name: 'Print prescription' })).toBeVisible()

    const { file, bytes } = await downloadFrom(page, 'Download prescription (PDF)')

    expect(file.suggestedFilename()).toMatch(/^recoverease-prescription-alice-santos-/)
    expect(isPdf(bytes)).toBe(true)
    const text = (await pdfLines(bytes)).join(' ')
    for (const expected of [
      'Harborview Recovery Clinic Prescription',
      'Alice Santos',
      'Dr. Alan Cruz',
      'Licence no.: LIC-A-001',
      'Amoxicillin',
      '500mg',
      '2 times a day at 08:00, 20:00',
      'Take with food.',
    ]) {
      expect(text, expected).toContain(expected)
    }
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })

  test('the Clinic Admin exports the system-wide report as a PDF and as Excel', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await signInAs('admin', {
      'rpc/admin_dashboard_stats': [
        {
          patients: { total: 7, active: 6 },
          doctors: { total: 3, active: 2 },
          accounts: { admin: 1, doctor: 3, patient: 7 },
          appointments: { upcoming: 5 },
          generated_at: new Date().toISOString(),
        },
      ],
    })
    await page.goto('/admin/reports')
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeEnabled()

    const pdf = await downloadFrom(page, 'Download PDF')
    expect(pdf.file.suggestedFilename()).toMatch(/^recoverease-system-wide-report-\d{4}-\d{2}-\d{2}\.pdf$/)
    expect(isPdf(pdf.bytes)).toBe(true)
    expect(await pdfLines(pdf.bytes)).toEqual(
      expect.arrayContaining(['System-wide report', 'Patients on record', '7', '6', 'Upcoming appointments', '5']),
    )

    const xlsx = await downloadFrom(page, 'Download Excel')
    expect(xlsx.file.suggestedFilename()).toMatch(/^recoverease-system-wide-report-\d{4}-\d{2}-\d{2}\.xlsx$/)
    const parts = unzipSync(xlsx.bytes)
    expect(strFromU8(parts['xl/worksheets/sheet1.xml']!)).toContain('Patients on record')

    // Exporting is not generating: nothing is recorded.
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })
})
