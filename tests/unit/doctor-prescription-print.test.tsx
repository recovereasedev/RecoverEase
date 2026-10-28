import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'

import { captureDownloads } from './support/capture-download'
import { pdfLines } from './support/pdf-text'

/**
 * QA 9/12 — "Remove ni for all tabs (overview, recovery, treatment, notes kay
 * redundant na sa reports) But keep sa medication tab (print prescription)".
 *
 * On the clinician's patient record the only print control is the Medication
 * tab's "Print prescription". It prints the letterhead the patient's own
 * prescription print uses — the patient from the record, the clinician from
 * the session when they are the patient's assigned doctor — above the
 * prescriptions, and leaves the record's header, tabs and controls off the
 * paper. Printing writes nothing.
 */

const state = vi.hoisted(() => ({ schedules: [] as unknown[] }))
const mockUser = vi.hoisted(() => ({ current: null as AppUser | null }))

const noop = { mutate: vi.fn(), isPending: false, isError: false, error: null }

// Print hands the built PDF to the print path (`@/lib/documents/print`),
// which only a real browser can follow; here it records what it was given.
const printing = vi.hoisted(() => ({
  files: [] as { bytes: Uint8Array; fileName: string; mimeType: string }[],
}))

vi.mock('@/lib/documents/print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/print')>()),
  printRoute: () => 'frame',
  openPrintTab: () => null,
  printFile: async (file: { bytes: Uint8Array; fileName: string; mimeType: string }) => {
    printing.files.push(file)
    return 'printed'
  },
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => mockUser.current,
  useAuth: () => ({ user: mockUser.current, signOut: vi.fn(), refresh: vi.fn() }),
}))

// The letterhead's clinic name, read when the file is made; never a network
// call from a test.
vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchOwnClinicName: async () => 'Harbor Clinic',
}))

vi.mock('@/features/patients/hooks', () => ({
  // The record's Patient details panel (module 2.5); nothing here saves it.
  useUpdatePatient: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
  usePatient: () => ({
    isPending: false,
    error: null,
    data: {
      pat_id: 'pat-1',
      doc_id: 'doc-1',
      pat_first_name: 'Maria',
      pat_last_name: 'Reyes',
      pat_status: 'active',
      pat_birth_date: '1990-01-02',
      pat_gender: null,
      pat_contact_no: null,
      pat_address: null,
      pat_created_at: '2026-01-01T00:00:00Z',
      pat_consent_at: null,
    },
    refetch: vi.fn(),
  }),
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
  useCreateTreatmentPlan: () => noop,
  useUpdateTreatmentPlan: () => noop,
  useCreateTreatmentGoal: () => noop,
  useUpdateGoalStatus: () => noop,
}))

vi.mock('@/features/medications/hooks', () => ({
  useMedicationSchedules: () => ({
    isPending: false,
    error: null,
    data: state.schedules,
    refetch: vi.fn(),
  }),
  useDoses: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
  useCreatePrescription: () => noop,
  useCreateMedicationSchedule: () => noop,
  useEndMedicationSchedule: () => noop,
}))

vi.mock('@/features/recovery-logs/hooks', () => ({
  useRecoveryLogs: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
}))

// Clinical notes are read straight through react-query on this page.
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>(
      '@tanstack/react-query',
    )
  return {
    ...actual,
    useQuery: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: () => noop,
  }
})

const { DoctorPatientDetailPage } = await import(
  '@/features/patients/pages/doctor-patient-detail-page'
)

const amoxicillin = {
  medication_schedule_id: 'ms-1',
  prescription_id: 'rx-1',
  medication_schedule_name: 'Amoxicillin',
  medication_schedule_dosage: '500mg',
  medication_schedule_frequency: 3,
  medication_schedule_times: ['08:00:00', '14:00:00', '20:00:00'],
  medication_schedule_start_date: '2026-09-01',
  medication_schedule_end_date: null,
  medication_schedule_created_at: '2026-09-01T00:00:00Z',
  prescription: {
    prescription_id: 'rx-1',
    prescription_issued_date: '2026-09-01',
    prescription_notes: 'Finish the full course.',
    // Issued by doc-1, the patient's assigned doctor.
    doc_id: 'doc-1',
  },
}

function doctorSession(docId: string): AppUser {
  return {
    userId: 'u-1',
    email: 'doctor@example.test',
    role: 'doctor',
    displayName: 'Dr Lorna Villanueva',
    mustChangePassword: false,
    profile: {
      kind: 'doctor',
      doctor: {
        doc_id: docId,
        doc_first_name: 'Lorna',
        doc_last_name: 'Villanueva',
        doc_specialization: 'Orthopaedics',
        doc_license_no: 'LIC-7',
        doc_contact_no: '032 111 2222',
      },
    } as never,
  }
}

function openRecord(tab?: string) {
  render(
    <MemoryRouter
      initialEntries={[`/doctor/patients/pat-1${tab ? `?tab=${tab}` : ''}`]}
    >
      <Routes>
        <Route path="/doctor/patients/:patientId" element={<DoctorPatientDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

const letterhead = () =>
  document.querySelector<HTMLElement>('[data-prescription-print-header]')

beforeEach(() => {
  state.schedules = [amoxicillin]
  noop.mutate.mockReset()
  mockUser.current = doctorSession('doc-1')
  printing.files = []
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('print controls on the patient record', () => {
  it.each(['overview', 'recovery', 'treatment', 'notes'])(
    'offers nothing to print on the %s tab',
    (tab) => {
      openRecord(tab)

      expect(screen.queryByRole('button', { name: /print/i })).not.toBeInTheDocument()
      expect(letterhead()).toBeNull()
    },
  )

  it('offers Print prescription on the medication tab', () => {
    openRecord('medication')

    expect(screen.getByRole('button', { name: 'Print prescription' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /print record/i })).not.toBeInTheDocument()
  })

  it('prints the prescription sheet itself, not the record, and writes nothing (module 4.4)', async () => {
    openRecord('medication')
    fireEvent.click(screen.getByRole('button', { name: 'Print prescription' }))

    await waitFor(() => expect(printing.files).toHaveLength(1))
    expect(window.print).not.toHaveBeenCalled()
    const text = (await pdfLines(printing.files[0]!.bytes)).join(' ')
    for (const expected of ['Harbor Clinic Prescription', 'Maria Reyes', 'Dr. Lorna Villanueva', 'Amoxicillin']) {
      expect(text, expected).toContain(expected)
    }
    expect(noop.mutate).not.toHaveBeenCalled()
  })
})

describe('the printed prescription', () => {
  it('names the patient from the record and the clinician from the session', () => {
    openRecord('medication')
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByRole('heading', { name: 'Prescription' })).toBeInTheDocument()
    expect(sheet.getByText('Maria Reyes')).toBeInTheDocument()
    expect(sheet.getByText('Dr. Lorna Villanueva')).toBeInTheDocument()
  })

  it('names no clinician who is not the patient’s assigned doctor', () => {
    mockUser.current = doctorSession('doc-9')
    openRecord('medication')
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByText('Maria Reyes')).toBeInTheDocument()
    expect(sheet.getByText('Not available')).toBeInTheDocument()
    expect(sheet.queryByText(/^Dr\./)).not.toBeInTheDocument()
  })

  it('keeps the prescription details, and the prescription notes, on the paper', () => {
    openRecord('medication')

    for (const text of [
      'Amoxicillin',
      '08:00, 14:00, 20:00',
      /ongoing/,
      'Finish the full course.',
    ]) {
      expect(leftOffPaper(screen.getByText(text)), String(text)).toBe(false)
    }
  })

  it('leaves the record’s header, tabs and controls off the paper', () => {
    openRecord('medication')

    expect(
      leftOffPaper(screen.getByRole('heading', { level: 1, name: 'Maria Reyes' })),
    ).toBe(true)
    expect(leftOffPaper(screen.getByRole('tablist'))).toBe(true)
    for (const name of [
      'Print prescription',
      /end medication/i,
      /add another medicine/i,
      /start consultation/i,
      /reset password/i,
    ]) {
      expect(leftOffPaper(screen.getByRole('button', { name })), String(name)).toBe(true)
    }
  })

  it('shows neither the letterhead nor the printed notes on screen', () => {
    openRecord('medication')

    for (const element of [
      letterhead() as HTMLElement,
      screen.getByText('Finish the full course.'),
    ]) {
      expect(element.className.split(' ')).toEqual(
        expect.arrayContaining(['hidden', 'print:block']),
      )
    }
  })
})

describe('downloading the prescription from the record (module 4.10)', () => {
  it('offers it on the medication tab, beside Print', () => {
    openRecord('medication')
    expect(screen.getByRole('button', { name: 'Download prescription (PDF)' })).toBeInTheDocument()
  })

  it('saves the prescription as a PDF, naming the doctor who issued it, and writes nothing', async () => {
    const capture = captureDownloads()
    try {
      openRecord('medication')
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const [file] = capture.files
      expect(file!.type).toBe('application/pdf')
      expect(file!.name).toMatch(/^recoverease-prescription-maria-reyes-/)
      const text = (await pdfLines(await file!.bytes())).join(' ')
      for (const expected of [
        'Harbor Clinic Prescription',
        'Maria Reyes',
        'Dr. Lorna Villanueva',
        'Licence no.: LIC-7',
        'Contact no. 032 111 2222',
        'Amoxicillin',
        'From 1 Sep 2026, ongoing',
        'Finish the full course.',
      ]) {
        expect(text, expected).toContain(expected)
      }
      expect(noop.mutate).not.toHaveBeenCalled()
      expect(window.print).not.toHaveBeenCalled()
    } finally {
      capture.release()
    }
  })

  it('names no prescriber when the clinician did not issue the prescription', async () => {
    mockUser.current = doctorSession('doc-2')
    const capture = captureDownloads()
    try {
      openRecord('medication')
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))
      await waitFor(() => expect(capture.files).toHaveLength(1))
      const lines = await pdfLines(await capture.files[0]!.bytes())
      expect(lines).toContain('Not available')
      expect(lines).not.toContain('Dr. Lorna Villanueva')
    } finally {
      capture.release()
    }
  })

  it('keeps the control off the paper', () => {
    openRecord('medication')
    expect(
      leftOffPaper(screen.getByRole('button', { name: 'Download prescription (PDF)' })),
    ).toBe(true)
  })
})
