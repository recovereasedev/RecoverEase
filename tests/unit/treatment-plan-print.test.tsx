import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The patient's treatment plan as a document (module 3.5): Download saves
 * the designed PDF, and Print prints that same PDF - never the web page.
 * Both buttons are controls: on screen, off any printout of the page.
 */

const plans = vi.hoisted(() => ({ data: [] as unknown[] }))
const doctor = vi.hoisted(() => ({ data: null as unknown }))
const clinic = vi.hoisted(() => ({ name: vi.fn() }))

// Print hands the built PDF to the print path (`@/lib/documents/print`),
// which only a real browser can follow; here it records what it was given.
const printing = vi.hoisted(() => ({
  outcome: 'printed' as 'printed' | 'opened' | 'downloaded',
  files: [] as { bytes: Uint8Array; fileName: string; mimeType: string }[],
}))

vi.mock('@/lib/documents/print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/print')>()),
  printRoute: () => 'frame',
  openPrintTab: () => null,
  printFile: async (file: { bytes: Uint8Array; fileName: string; mimeType: string }) => {
    printing.files.push(file)
    return printing.outcome
  },
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-1',
    role: 'patient',
    profile: {
      kind: 'patient',
      patient: {
        pat_id: 'p-1',
        doc_id: 'd-1',
        pat_first_name: 'Maria',
        pat_last_name: 'Reyes',
        pat_birth_date: '1990-05-14',
        pat_gender: 'Female',
      },
    },
  }),
}))

vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({ data: doctor.data, isLoading: false, error: null }),
}))

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchOwnClinicName: clinic.name,
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({
    data: plans.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

import { captureDownloads } from './support/capture-download'
import { pdfLines } from './support/pdf-text'

const { PatientTreatmentPage } = await import(
  '@/features/treatment-plans/pages/patient-treatment-page'
)

const DR_LIM = {
  doc_id: 'd-1',
  doc_first_name: 'Ana',
  doc_last_name: 'Lim',
  doc_specialization: 'Physiotherapy',
  doc_license_no: 'LIC-1',
  doc_contact_no: null,
}

const PLAN = {
  treatment_plan_id: 'plan-1',
  pat_id: 'p-1',
  doc_id: 'd-1',
  treatment_plan_title: 'Shoulder rehabilitation',
  treatment_plan_description: 'Six week programme.',
  treatment_plan_start_date: '2026-09-01',
  treatment_plan_end_date: null,
  treatment_plan_status: 'active',
  treatment_plan_created_at: '2026-09-01T00:00:00Z',
  treatment_plan_updated_at: '2026-09-01T00:00:00Z',
  treatment_goal: [
    {
      treatment_goal_id: 'goal-1',
      treatment_plan_id: 'plan-1',
      treatment_goal_description: 'Raise arm above shoulder',
      treatment_goal_target_date: '2026-10-01',
      treatment_goal_status: 'achieved',
      treatment_goal_created_at: '2026-09-01T00:00:00Z',
    },
    {
      treatment_goal_id: 'goal-2',
      treatment_plan_id: 'plan-1',
      treatment_goal_description: 'Carry a shopping bag',
      treatment_goal_target_date: null,
      treatment_goal_status: 'in_progress',
      treatment_goal_created_at: '2026-09-01T00:00:00Z',
    },
  ],
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

const printButton = () => screen.getByRole('button', { name: 'Print plan' })
const downloadButton = () => screen.getByRole('button', { name: 'Download plan (PDF)' })

/** A PDF's text as one string, so a wrapped cell reads whole. */
const pdfText = async (bytes: Uint8Array) => (await pdfLines(bytes)).join(' ')

beforeEach(() => {
  plans.data = [PLAN]
  doctor.data = DR_LIM
  clinic.name.mockReset().mockResolvedValue('Harbor Clinic')
  printing.files = []
  printing.outcome = 'printed'
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('printing the treatment plan', () => {
  it('prints the designed plan itself, not this page', async () => {
    render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
    fireEvent.click(printButton())

    await waitFor(() => expect(printing.files).toHaveLength(1))
    expect(window.print).not.toHaveBeenCalled()
    expect(printing.files[0]!.mimeType).toBe('application/pdf')
    const text = await pdfText(printing.files[0]!.bytes)
    for (const expected of [
      'Harbor Clinic Treatment plan',
      'Maria Reyes',
      'Shoulder rehabilitation',
      'Doctor Dr. Ana Lim',
      'Status Active',
      'Raise arm above shoulder 1 Oct 2026 Achieved',
      'Carry a shopping bag No target date In progress',
    ]) {
      expect(text, expected).toContain(expected)
    }
  })

  it('prints exactly what Download saves', async () => {
    const capture = captureDownloads()
    try {
      render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
      fireEvent.click(downloadButton())
      await waitFor(() => expect(capture.files).toHaveLength(1))
      fireEvent.click(printButton())
      await waitFor(() => expect(printing.files).toHaveLength(1))

      // Built a moment apart, so only the footer's time may differ.
      const body = (lines: string[]) =>
        lines.filter((line) => !line.startsWith('RecoverEase treatment plan ·'))
      expect(body(await pdfLines(printing.files[0]!.bytes))).toEqual(
        body(await pdfLines(await capture.files[0]!.bytes())),
      )
    } finally {
      capture.release()
    }
  })

  it('says where the plan went when the browser downloaded it instead', async () => {
    printing.outcome = 'downloaded'
    render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
    fireEvent.click(printButton())

    expect(
      await screen.findByText(
        'This browser could not open the treatment plan for printing, so it was downloaded instead. Open the file to print it.',
      ),
    ).toBeInTheDocument()
  })

  it('says the plan was not printed when it could not be built', async () => {
    vi.spyOn(PDFDocument, 'create').mockRejectedValueOnce(new Error('Out of memory'))
    render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
    fireEvent.click(printButton())

    expect(await screen.findByText('The plan was not printed')).toBeInTheDocument()
    expect(printing.files).toHaveLength(0)
  })

  it('keeps both controls off any printout of the page, plans or none', () => {
    const { unmount } = render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
    expect(leftOffPaper(printButton())).toBe(true)
    expect(leftOffPaper(downloadButton())).toBe(true)
    unmount()

    plans.data = []
    render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
    expect(leftOffPaper(printButton())).toBe(true)
    expect(leftOffPaper(screen.getByText('No treatment plan yet'))).toBe(false)
  })

  it('keeps the plan itself on a printout of the page', () => {
    render(<PatientTreatmentPage />, { wrapper: MemoryRouter })

    for (const text of [
      'Treatment plan',
      'Shoulder rehabilitation',
      'Six week programme.',
      'Raise arm above shoulder',
      'Carry a shopping bag',
      '1 of 2 achieved',
    ]) {
      expect(leftOffPaper(screen.getByText(text)), text).toBe(false)
    }
    const onPaper = screen
      .getAllByRole('button')
      .filter((button) => !leftOffPaper(button))
      .map((button) => button.textContent)
    expect(onPaper).toEqual([])
  })
})

describe('downloading the treatment plan (module 3.5)', () => {
  it('saves the designed plan as a PDF, with its goals and their states in words', async () => {
    const capture = captureDownloads()
    try {
      render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
      fireEvent.click(downloadButton())

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const [file] = capture.files
      expect(file!.type).toBe('application/pdf')
      expect(file!.name).toMatch(/^recoverease-treatment-plan-maria-reyes-\d{4}-\d{2}-\d{2}\.pdf$/)
      const text = await pdfText(await file!.bytes())
      for (const expected of [
        'Harbor Clinic Treatment plan',
        'Maria Reyes',
        '14 May 1990',
        'Shoulder rehabilitation',
        'Plan period 1 Sep 2026 onwards',
        'Goals achieved 1 of 2',
        'About this plan Six week programme.',
        'Raise arm above shoulder 1 Oct 2026 Achieved',
        'Carry a shopping bag No target date In progress',
      ]) {
        expect(text, expected).toContain(expected)
      }
      expect(window.print).not.toHaveBeenCalled()
    } finally {
      capture.release()
    }
  })

  it('names no doctor the patient may not read', async () => {
    doctor.data = null
    const capture = captureDownloads()
    try {
      render(<PatientTreatmentPage />, { wrapper: MemoryRouter })
      fireEvent.click(downloadButton())
      await waitFor(() => expect(capture.files).toHaveLength(1))
      const text = await pdfText(await capture.files[0]!.bytes())
      expect(text).toContain('Doctor Not available')
      expect(text).not.toContain('Dr. ')
    } finally {
      capture.release()
    }
  })
})
