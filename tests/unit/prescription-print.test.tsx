import { fireEvent, render, screen, within } from '@testing-library/react'
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

const { PrescriptionPrintHeader } = await import(
  '@/features/medications/components/prescription-print-header'
)
const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)

const LORNA = { doc_first_name: 'Lorna', doc_last_name: 'Villanueva' }

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

  it('still prints from the same button', () => {
    render(<PatientMedicationsPage />)
    fireEvent.click(screen.getByRole('button', { name: /print prescriptions/i }))

    expect(window.print).toHaveBeenCalledTimes(1)
  })
})
