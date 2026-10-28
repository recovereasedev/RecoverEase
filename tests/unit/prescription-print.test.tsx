import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA 9/13 — "Fix format sa print prescription… with doctor and patient name".
 *
 * The patient's "Print prescriptions" prints a letterhead naming the patient
 * and their doctor above the prescriptions, and leaves the rest of the page —
 * today's doses, what is coming up, the week's adherence — off the paper.
 * Both names come from the records; nothing on screen changes.
 */

const doctor = vi.hoisted(() => ({ data: null as unknown, askedFor: [] as unknown[] }))
const schedules = vi.hoisted(() => ({ data: [] as unknown[] }))
const clinic = vi.hoisted(() => ({ name: vi.fn() }))

// The letterhead's clinic name, read when the file is made; never a network
// call from a test.
vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchOwnClinicName: clinic.name,
}))

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

vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: (doctorId: string | undefined) => {
    doctor.askedFor.push(doctorId)
    return { data: doctor.data, isPending: false, error: null }
  },
}))

vi.mock('@/features/medications/hooks', () => ({
  useDoses: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useMedicationSchedules: () => ({
    data: schedules.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetDoseStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-7',
    role: 'patient',
    profile: {
      kind: 'patient',
      patient: {
        pat_id: 'p-7',
        doc_id: 'd-7',
        pat_first_name: 'Maria',
        pat_last_name: 'Reyes',
      },
    },
  }),
}))

import { captureDownloads } from './support/capture-download'
import { pdfLines } from './support/pdf-text'

const { PrescriptionPrintHeader } = await import(
  '@/features/medications/components/prescription-print-header'
)
const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)

const LORNA = {
  doc_id: 'd-7',
  doc_first_name: 'Lorna',
  doc_last_name: 'Villanueva',
  doc_specialization: 'Orthopaedics',
  doc_license_no: 'LIC-7',
  doc_contact_no: null,
}

const amoxicillin = {
  medication_schedule_id: 'ms-1',
  prescription_id: 'rx-1',
  medication_schedule_name: 'Amoxicillin',
  medication_schedule_dosage: '500mg',
  medication_schedule_frequency: 3,
  medication_schedule_times: ['08:00:00', '14:00:00', '20:00:00'],
  medication_schedule_start_date: '2026-09-01',
  medication_schedule_end_date: '2026-09-10',
  medication_schedule_created_at: '2026-09-01T00:00:00Z',
  prescription: {
    prescription_id: 'rx-1',
    prescription_issued_date: '2026-09-01',
    prescription_notes: 'Finish the full course.',
    doc_id: 'd-7',
  },
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

const letterhead = () =>
  document.querySelector<HTMLElement>('[data-prescription-print-header]')

beforeEach(() => {
  doctor.data = LORNA
  doctor.askedFor = []
  schedules.data = [amoxicillin]
  clinic.name.mockReset().mockResolvedValue('Harbor Clinic')
  printing.files = []
  printing.outcome = 'printed'
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the printed letterhead', () => {
  it('names the patient and their doctor under a Prescription heading', () => {
    render(
      <PrescriptionPrintHeader
        patient={{ pat_first_name: 'Maria', pat_last_name: 'Reyes' }}
        doctor={LORNA}
        printedAt="2026-09-13T12:00:00Z"
      />,
    )
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByRole('heading', { name: 'Prescription' })).toBeInTheDocument()
    expect(sheet.getByText('Patient')).toBeInTheDocument()
    expect(sheet.getByText('Maria Reyes')).toBeInTheDocument()
    expect(sheet.getByText('Doctor')).toBeInTheDocument()
    expect(sheet.getByText('Dr. Lorna Villanueva')).toBeInTheDocument()
    expect(sheet.getByText('Printed')).toBeInTheDocument()
  })

  it('names whoever the records say, not anyone fixed', () => {
    render(
      <PrescriptionPrintHeader
        patient={{ pat_first_name: 'Ben', pat_last_name: 'Tan' }}
        doctor={{ doc_first_name: 'Ana', doc_last_name: 'Lopez' }}
        printedAt="2026-09-13T12:00:00Z"
      />,
    )
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByText('Ben Tan')).toBeInTheDocument()
    expect(sheet.getByText('Dr. Ana Lopez')).toBeInTheDocument()
    expect(sheet.queryByText(/Maria|Lorna|Alice|Alan/)).not.toBeInTheDocument()
  })

  it('says the doctor is not available rather than naming anyone', () => {
    render(
      <PrescriptionPrintHeader
        patient={{ pat_first_name: 'Maria', pat_last_name: 'Reyes' }}
        doctor={null}
        printedAt="2026-09-13T12:00:00Z"
      />,
    )
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByText('Not available')).toBeInTheDocument()
    expect(sheet.queryByText(/^Dr\./)).not.toBeInTheDocument()
  })

  it('is on paper only, with nothing to press', () => {
    render(
      <PrescriptionPrintHeader
        patient={{ pat_first_name: 'Maria', pat_last_name: 'Reyes' }}
        doctor={LORNA}
        printedAt="2026-09-13T12:00:00Z"
      />,
    )
    const sheet = letterhead() as HTMLElement

    expect(sheet.className.split(' ')).toEqual(
      expect.arrayContaining(['hidden', 'print:block']),
    )
    expect(within(sheet).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('printing prescriptions from the medication page', () => {
  it('asks for the patient’s own assigned doctor', () => {
    render(<PatientMedicationsPage />)

    expect(doctor.askedFor).toContain('d-7')
  })

  it('puts the patient and doctor names on the printed page', () => {
    render(<PatientMedicationsPage />)
    const sheet = within(letterhead() as HTMLElement)

    expect(sheet.getByText('Maria Reyes')).toBeInTheDocument()
    expect(sheet.getByText('Dr. Lorna Villanueva')).toBeInTheDocument()
  })

  it('keeps the prescriptions, with everything they said before, on the paper', () => {
    render(<PatientMedicationsPage />)

    const heading = screen.getByRole('heading', { name: 'Your prescriptions' })
    expect(leftOffPaper(heading)).toBe(false)

    for (const text of [
      'Amoxicillin',
      /500mg · 3\s+times a day at/,
      '08:00, 14:00, 20:00',
      /until/,
      'Finish the full course.',
    ]) {
      const element = screen.getByText(text)
      expect(leftOffPaper(element), String(text)).toBe(false)
    }
  })

  it('leaves the rest of the page, and its controls, off the paper', () => {
    render(<PatientMedicationsPage />)

    for (const name of ['Due today', 'Coming up', 'This week']) {
      expect(leftOffPaper(screen.getByRole('heading', { name })), name).toBe(true)
    }
    expect(
      leftOffPaper(screen.getByRole('heading', { level: 1, name: 'Medications' })),
    ).toBe(true)
    expect(
      leftOffPaper(screen.getByRole('button', { name: /print prescriptions/i })),
    ).toBe(true)
  })

  it('prints the prescription sheet itself, not this page', async () => {
    render(<PatientMedicationsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Print prescriptions' }))

    await waitFor(() => expect(printing.files).toHaveLength(1))
    expect(window.print).not.toHaveBeenCalled()
    expect(printing.files[0]!.mimeType).toBe('application/pdf')
    const text = (await pdfLines(printing.files[0]!.bytes)).join(' ')
    for (const expected of [
      'Harbor Clinic Prescription',
      'Dr. Lorna Villanueva',
      'Maria Reyes',
      'Amoxicillin',
      'Finish the full course.',
    ]) {
      expect(text, expected).toContain(expected)
    }
  })

  it('prints exactly what Download saves', async () => {
    const capture = captureDownloads()
    try {
      render(<PatientMedicationsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))
      await waitFor(() => expect(capture.files).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Print prescriptions' }))
      await waitFor(() => expect(printing.files).toHaveLength(1))

      // Built a moment apart, so only the footer's time may differ.
      const body = (lines: string[]) =>
        lines.filter((line) => !line.startsWith('RecoverEase prescription ·'))
      expect(body(await pdfLines(printing.files[0]!.bytes))).toEqual(
        body(await pdfLines(await capture.files[0]!.bytes())),
      )
    } finally {
      capture.release()
    }
  })

  it('says where the prescription went when the browser opened it in a tab', async () => {
    printing.outcome = 'opened'
    render(<PatientMedicationsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Print prescriptions' }))

    expect(
      await screen.findByText(
        'The prescription opened in a new tab. Print it from there, or share it to a printer.',
      ),
    ).toBeInTheDocument()
  })

  it('says when each prescription was issued, and by whom, on screen and on paper', () => {
    render(<PatientMedicationsPage />)

    const line = screen.getByText(/^Issued 1 September( 2026)? · /)
    expect(line).toHaveTextContent('Prescribed by Dr. Lorna Villanueva')
    expect(leftOffPaper(line)).toBe(false)
  })

  it('names no prescriber for a prescription an earlier doctor issued', () => {
    schedules.data = [
      { ...amoxicillin, prescription: { ...amoxicillin.prescription, doc_id: 'd-earlier' } },
    ]
    render(<PatientMedicationsPage />)

    expect(screen.getByText(/· Prescriber not available$/)).toBeInTheDocument()
    expect(screen.queryByText(/Prescribed by/)).not.toBeInTheDocument()
  })
})

/** A downloaded PDF's text as one string, so a wrapped cell reads whole. */
async function pdfText(file: { bytes: () => Promise<Uint8Array> }): Promise<string> {
  return (await pdfLines(await file.bytes())).join(' ')
}

describe('downloading the prescription (module 4.10)', () => {
  it('saves a PDF of the same prescription, naming the patient and its prescriber', async () => {
    const capture = captureDownloads()
    try {
      render(<PatientMedicationsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const [file] = capture.files
      expect(file!.type).toBe('application/pdf')
      expect(file!.name).toMatch(/^recoverease-prescription-maria-reyes-\d{4}-\d{2}-\d{2}\.pdf$/)
      const text = await pdfText(file!)
      for (const expected of [
        'Harbor Clinic Prescription',
        'Dr. Lorna Villanueva',
        'Orthopaedics',
        'Date issued 1 Sep 2026',
        'Prescription ID rx-1',
        'Maria Reyes',
        'Amoxicillin',
        '3 times a day at 08:00, 14:00, 20:00',
        '1 Sep 2026 to 10 Sep 2026',
        'Finish the full course.',
      ]) {
        expect(text, expected).toContain(expected)
      }
      // A download, not a print; and the object URL is let go afterwards.
      expect(window.print).not.toHaveBeenCalled()
      await waitFor(() => expect(capture.revoked).toHaveLength(1))
    } finally {
      capture.release()
    }
  })

  it('names no doctor when the assigned doctor could not be read', async () => {
    doctor.data = null
    const capture = captureDownloads()
    try {
      render(<PatientMedicationsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))
      await waitFor(() => expect(capture.files).toHaveLength(1))
      const lines = await pdfLines(await capture.files[0]!.bytes())
      expect(lines).toContain('Not available')
      expect(lines.some((line) => line.startsWith('Dr.'))).toBe(false)
    } finally {
      capture.release()
    }
  })

  it('still downloads when the clinic cannot be read, leaving its name off', async () => {
    clinic.name.mockRejectedValue(new Error('Failed to fetch'))
    const capture = captureDownloads()
    try {
      render(<PatientMedicationsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Download prescription (PDF)' }))
      await waitFor(() => expect(capture.files).toHaveLength(1))
      const text = await pdfText(capture.files[0]!)
      expect(text).not.toContain('Harbor')
      expect(text).toContain('Amoxicillin')
    } finally {
      capture.release()
    }
  })

  it('is unavailable, and says why, while nothing is prescribed - and so is Print', () => {
    schedules.data = []
    render(<PatientMedicationsPage />)

    for (const name of ['Download prescription (PDF)', 'Print prescriptions']) {
      const button = screen.getByRole('button', { name })
      expect(button, name).toBeDisabled()
      expect(button, name).toHaveAccessibleDescription(
        'There is no prescription to download or print yet: your doctor has not prescribed anything.',
      )
    }
  })

  it('is a control: on screen, off the paper', () => {
    render(<PatientMedicationsPage />)
    expect(
      leftOffPaper(screen.getByRole('button', { name: 'Download prescription (PDF)' })),
    ).toBe(true)
  })
})
