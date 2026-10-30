import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { headersFor, readHeaderRules } from '../scripts/vercel-headers'

import { expect, IDS, test, type Page } from './support/fixtures'
import { bodyOf } from './support/printing'

/**
 * Print, as production serves it: under the Content-Security-Policy from
 * `vercel.json`, in Google Chrome, which shows PDFs itself and so takes
 * Print's frame route (`src/lib/documents/print.ts`). Playwright's own
 * headless Chromium has no PDF viewer and would take the tab route instead,
 * so this file runs only in the `desktop-pdf-viewer` project.
 *
 * Production's policy once blocked the frame - its address is the PDF's
 * blob: URL, which `default-src 'self'` does not cover - so Print could only
 * download, while every test passed under no policy at all. The last test
 * here reproduces that, under the policy as it was.
 *
 * The print dialog is the one thing a test cannot drive: inside the PDF's
 * frame the call that opens it is counted instead.
 */

const rules = readHeaderRules(fileURLToPath(new URL('../vercel.json', import.meta.url)))
const POLICY = new Map(headersFor(rules, '/patient/medications')).get('Content-Security-Policy')!

/** The reader's own clinic, which `clinic_select_member` returns to its members. */
const CLINIC = {
  clinic_id: IDS.clinic,
  clinic_name: 'Harborview Recovery Clinic',
  clinic_status: 'active',
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-01-01T00:00:00Z',
  clinic_updated_at: '2026-01-01T00:00:00Z',
}

type Printing = { framePrints: number; violations: string[] }

/** Records, from before the app loads, what printing did and what the policy refused. */
async function watchPrinting(page: Page) {
  await page.addInitScript(() => {
    if (window === window.top) {
      const record = { framePrints: 0, violations: [] as string[], blobs: new Map<string, Blob>() }
      Object.assign(window, { __printing: record })
      document.addEventListener('securitypolicyviolation', (event) => {
        record.violations.push(`${event.effectiveDirective} ${event.blockedURI}`)
      })
      const create = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (object: Blob | MediaSource) => {
        const url = create(object)
        if (object instanceof Blob) record.blobs.set(url, object)
        return url
      }
    } else {
      // The PDF's own frame: count the call that would open the dialog.
      window.print = () => {
        ;(window.top as unknown as { __printing: Printing }).__printing.framePrints += 1
      }
    }
  })
}

/**
 * What printing did, and what the policy refused - all but Zod's eval probe.
 * Zod 4 tries `Function('')` once, inside a try/catch, to see whether it may
 * compile its validators (`allowsEval`, node_modules/zod/v4/core/util.js); a
 * strict policy reports that refusal although nothing fails, on every page
 * that validates a form, in production as here. It is not Print's.
 */
const printing = (page: Page) =>
  page.evaluate(() => {
    const { framePrints, violations } = (window as unknown as { __printing: Printing }).__printing
    return { framePrints, violations: violations.filter((violation) => violation !== 'script-src eval') }
  })

/** Console errors and uncaught exceptions, for asserting there were none. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** Opens a page and checks it was served production's policy. */
async function open(page: Page, path: string, ready: string) {
  const response = await page.goto(path)
  expect(response!.headers()['content-security-policy']).toBe(POLICY)
  await expect(page.getByText(ready, { exact: true }).first()).toBeVisible()
}

/**
 * Presses Print and checks it printed from the frame - the PDF itself, in
 * Chrome's viewer, nothing blocked, nothing downloaded - then that the
 * printed PDF is the one Download saves.
 */
async function expectPrintedFromFrame(page: Page, print: string, download: string) {
  const downloads: string[] = []
  page.on('download', (file) => downloads.push(file.suggestedFilename()))

  await page.getByRole('button', { name: print, exact: true }).click()
  await expect.poll(async () => (await printing(page)).framePrints).toBe(1)

  const frame = page.frames().find((candidate) => candidate.url().startsWith('blob:'))
  expect(frame, 'the hidden frame holding the PDF').toBeDefined()
  expect(await frame!.evaluate(() => document.contentType)).toBe('application/pdf')
  expect(downloads).toEqual([])
  expect((await printing(page)).violations).toEqual([])
  await expect(page.getByText(/downloaded instead|opened in a new tab/)).toHaveCount(0)

  const printed = new Uint8Array(
    await page.evaluate(async (url) => {
      const { blobs } = (window as unknown as { __printing: { blobs: Map<string, Blob> } }).__printing
      return [...new Uint8Array(await blobs.get(url)!.arrayBuffer())]
    }, frame!.url()),
  )
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: download, exact: true }).click(),
  ])
  const saved = new Uint8Array(await readFile(await file.path()))
  expect(await bodyOf(printed)).toEqual(await bodyOf(saved))
}

test.describe('Print under production’s Content-Security-Policy, in Chrome', () => {
  test('the patient’s Print prescriptions opens the print dialog for the prescription itself', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    await watchPrinting(page)
    await signInAs('patient', { clinic: [CLINIC] })
    await open(page, '/patient/medications', 'Take with food.')

    await expectPrintedFromFrame(page, 'Print prescriptions', 'Download prescription (PDF)')
    expect(errors).toEqual([])
  })

  test('the doctor’s Print prescription does the same from the patient record', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const prescription = {
      prescription_id: 'rx-csp',
      prescription_issued_date: '2026-09-01',
      prescription_notes: 'Take with food.',
      doc_id: IDS.doctorA,
      pat_id: IDS.alicePat,
    }
    await watchPrinting(page)
    await signInAs('doctor', {
      clinic: [CLINIC],
      prescription: [prescription],
      medication_schedule: [
        {
          medication_schedule_id: 'ms-csp',
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
    await open(page, `/doctor/patients/${IDS.alicePat}?tab=medication`, 'Amoxicillin')

    await expectPrintedFromFrame(page, 'Print prescription', 'Download prescription (PDF)')
    expect(errors).toEqual([])
  })

  test('the patient’s Print plan does the same for the treatment plan', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await watchPrinting(page)
    await signInAs('patient', { clinic: [CLINIC] })
    await open(page, '/patient/treatment', 'Post-operative knee recovery')

    await expectPrintedFromFrame(page, 'Print plan', 'Download plan (PDF)')
    expect(errors).toEqual([])
  })

  test('without a PDF viewer of its own, the browser opens the PDF in a new tab under the same policy', async ({
    page,
    context,
    signInAs,
  }) => {
    await watchPrinting(page)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false })
    })
    const downloads: string[] = []
    page.on('download', (file) => downloads.push(file.suggestedFilename()))
    await signInAs('patient', { clinic: [CLINIC] })
    await open(page, '/patient/medications', 'Take with food.')

    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: 'Print prescriptions', exact: true }).click(),
    ])
    await expect.poll(() => tab.url()).toMatch(/^blob:/)
    await tab.waitForLoadState()
    expect(await tab.evaluate(() => document.contentType)).toBe('application/pdf')
    await expect(page.getByRole('status').filter({ hasText: 'opened in a new tab' })).toBeVisible()
    expect(downloads).toEqual([])
    expect((await printing(page)).violations).toEqual([])
  })

  test('under the policy as deployed before blob: frames were allowed, Print could only download', async ({
    page,
    signInAs,
  }) => {
    // vercel.json's policy without its frame-src: what production served
    // until frame-src was added, and what blocked the frame.
    const before = POLICY.split(';')
      .map((directive) => directive.trim())
      .filter((directive) => !directive.startsWith('frame-src '))
      .join('; ')
    expect(before).not.toContain('blob:')
    await page.route('**/patient/medications', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': before } })
    })
    await watchPrinting(page)
    await signInAs('patient', { clinic: [CLINIC] })
    const response = await page.goto('/patient/medications')
    expect(response!.headers()['content-security-policy']).toBe(before)
    await expect(page.getByText('Take with food.')).toBeVisible()

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Print prescriptions', exact: true }).click(),
    ])

    expect(file.suggestedFilename()).toMatch(/^recoverease-prescription-alice-santos-\d{4}-\d{2}-\d{2}\.pdf$/)
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'This browser could not open the prescription for printing, so it was downloaded instead.' }),
    ).toBeVisible()
    const { framePrints, violations } = await printing(page)
    expect(framePrints).toBe(0)
    expect(violations).toEqual(['frame-src blob'])
    // The blocked frame is taken away, not left hidden in the page.
    await expect(page.locator('iframe')).toHaveCount(0)
  })
})
