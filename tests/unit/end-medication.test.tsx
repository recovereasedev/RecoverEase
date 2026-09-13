import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA-01 — the clinician's "End medication".
 *
 * Confirmed first, because it cannot be undone from the app and the patient's
 * reminders stop with it, and offered only on a course that is still running.
 * The patient's own medication page has no such action.
 */

const endSchedule = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
}))
const schedules = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/medications/hooks', () => ({
  useEndMedicationSchedule: () => endSchedule,
  useMedicationSchedules: () => ({
    data: schedules.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDoses: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-1',
    role: 'patient',
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } },
  }),
}))

// The printed prescription's letterhead names the patient's doctor.
vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({ data: null, isPending: false, error: null }),
}))

const { EndMedicationAction, canEndSchedule } = await import(
  '@/features/medications/components/end-medication'
)
const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)

const TODAY = '2026-09-12'

function schedule(start: string, end: string | null) {
  return {
    medication_schedule_id: 'ms-1',
    prescription_id: 'rx-1',
    medication_schedule_name: 'Amoxicillin',
    medication_schedule_dosage: '500mg',
    medication_schedule_frequency: 2,
    medication_schedule_times: ['08:00:00', '20:00:00'],
    medication_schedule_start_date: start,
    medication_schedule_end_date: end,
    medication_schedule_created_at: '2026-09-01T00:00:00Z',
    prescription: {
      prescription_id: 'rx-1',
      prescription_issued_date: '2026-09-01',
      prescription_notes: null,
    },
  }
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  endSchedule.mutate.mockClear()
})

const endButton = () => screen.queryByRole('button', { name: /End medication: Amoxicillin/ })

describe('which medications can be ended', () => {
  it.each([
    ['ongoing, started earlier', '2026-09-01', null, true],
    ['ongoing, started today', TODAY, null, true],
    ['running to a later end date', '2026-09-01', '2026-09-20', true],
    ['already ending today', '2026-09-01', TODAY, false],
    ['already ended', '2026-09-01', '2026-09-10', false],
    ['not started yet', '2026-09-15', null, false],
  ] as const)('%s', (_label, start, end, expected) => {
    expect(
      canEndSchedule(
        { medication_schedule_start_date: start, medication_schedule_end_date: end },
        TODAY,
      ),
    ).toBe(expected)
  })
})

describe('ending a medication', () => {
  it('offers End medication on a medication that is still running', () => {
    render(<EndMedicationAction patientId="p-1" schedule={schedule('2026-09-01', null)} today={TODAY} />)
    expect(endButton()).toBeInTheDocument()
  })

  it.each([
    ['already ending today', '2026-09-01', TODAY],
    ['already ended', '2026-09-01', '2026-09-10'],
    ['not started yet', '2026-09-15', null],
  ] as const)('offers nothing on a medication %s', (_label, start, end) => {
    const { container } = render(
      <EndMedicationAction patientId="p-1" schedule={schedule(start, end)} today={TODAY} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('asks first, naming the medicine and what ending it does, and sends nothing yet', () => {
    render(<EndMedicationAction patientId="p-1" schedule={schedule('2026-09-01', null)} today={TODAY} />)
    fireEvent.click(endButton() as HTMLElement)

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('End this medication?')).toBeInTheDocument()
    expect(dialog.getByText('Amoxicillin, 500mg.')).toBeInTheDocument()
    expect(dialog.getByText(/Later doses are no\s+longer scheduled/)).toBeInTheDocument()
    expect(dialog.getByText(/the patient is not reminded about them/)).toBeInTheDocument()
    expect(dialog.getByText(/stay in the patient’s record/)).toBeInTheDocument()
    expect(endSchedule.mutate).not.toHaveBeenCalled()
  })

  it('changes nothing when the doctor keeps the medication', () => {
    render(<EndMedicationAction patientId="p-1" schedule={schedule('2026-09-01', null)} today={TODAY} />)
    fireEvent.click(endButton() as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Keep medication' }))

    expect(endSchedule.mutate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ends it through the end-medication flow once confirmed', () => {
    render(<EndMedicationAction patientId="p-1" schedule={schedule('2026-09-01', null)} today={TODAY} />)
    fireEvent.click(endButton() as HTMLElement)
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'End medication' }),
    )

    expect(endSchedule.mutate).toHaveBeenCalledTimes(1)
    expect(endSchedule.mutate).toHaveBeenCalledWith('ms-1', expect.anything())
  })
})

describe('the patient', () => {
  it('sees the medication on their own page with no way to end it', () => {
    schedules.data = [schedule('2026-09-01', null)]
    render(<PatientMedicationsPage />)

    expect(screen.getAllByText('Amoxicillin').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /end medication/i })).not.toBeInTheDocument()
  })
})
