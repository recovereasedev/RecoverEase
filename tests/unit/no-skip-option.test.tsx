import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA 9/13, item 3: "Don't give them the option to skip". A patient records a
 * dose as taken, or leaves it to become Missed. A dose already recorded as
 * Skipped before this change still reads Skipped, and Undo still returns it
 * to Due like any other recorded dose.
 */

const state = vi.hoisted(() => ({ today: [] as unknown[], mutate: vi.fn() }))

vi.mock('@/features/medications/hooks', () => ({
  // Only the "today" window is filled, so each dose appears once.
  useDoses: (_patientId: string, from: string) => {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    return {
      data: from === startOfToday.toISOString() ? state.today : [],
      isPending: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useMedicationSchedules: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => ({ mutate: state.mutate, isPending: false, variables: undefined }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-1',
    role: 'patient',
    profile: {
      kind: 'patient',
      patient: { pat_id: 'p-1', doc_id: 'd-1', pat_first_name: 'Alice', pat_last_name: 'Santos' },
    },
  }),
}))

vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({ data: null, isPending: false, error: null }),
}))

// The dashboard's other cards.
vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetAppointmentStatus: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined,
  }),
}))
vi.mock('@/features/recovery-logs/hooks', () => ({
  useRecoveryLogs: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}))
vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}))

const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)
const { PatientDashboard } = await import('@/features/dashboard/pages/patient-dashboard')

/** Today, at a wall-clock time in the browser's zone. */
const at = (hours: number) => new Date(2026, 8, 13, hours, 0, 0, 0)

function dose(id: string, name: string, status: string, scheduled: Date) {
  return {
    medication_log_id: id,
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: scheduled.toISOString(),
    medication_log_taken_at: status === 'taken' ? scheduled.toISOString() : null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
    medication_schedule: {
      medication_schedule_id: 'ms-1',
      medication_schedule_name: name,
      medication_schedule_dosage: '500mg',
    },
  }
}

const row = (name: string) =>
  within(screen.getByText(name).closest('li') as HTMLElement)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(at(12))
  state.mutate.mockReset()
  state.today = [
    dose('d1', 'Early tablet', 'missed', at(2)),
    dose('d2', 'Breakfast tablet', 'taken', at(7)),
    dose('d3', 'Morning tablet', 'pending', at(8)),
    dose('d4', 'Lunch tablet', 'skipped', at(11)),
    dose('d5', 'Evening tablet', 'pending', at(20)),
  ]
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the medication page', () => {
  it('offers Mark taken on a Due or Overdue dose, and no Skip anywhere', () => {
    render(<PatientMedicationsPage />)

    expect(row('Morning tablet').getByText('Overdue')).toBeInTheDocument()
    expect(row('Morning tablet').getByRole('button', { name: /^Mark taken/ })).toBeInTheDocument()
    expect(row('Evening tablet').getByText('Due')).toBeInTheDocument()
    expect(row('Evening tablet').getByRole('button', { name: /^Mark taken/ })).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument()
  })

  it('records a dose as taken', () => {
    render(<PatientMedicationsPage />)

    fireEvent.click(row('Morning tablet').getByRole('button', { name: /^Mark taken/ }))

    expect(state.mutate).toHaveBeenCalledTimes(1)
    expect(state.mutate).toHaveBeenCalledWith({ doseId: 'd3', status: 'taken' })
  })

  it('has no control on today’s doses that records one as skipped', () => {
    render(<PatientMedicationsPage />)

    const doses = screen.getByText('Morning tablet').closest('ul') as HTMLElement
    const controls = within(doses).getAllByRole('button')
    for (const control of controls) fireEvent.click(control)

    // Mark taken on the two pending doses, Undo on the three recorded ones.
    expect(state.mutate).toHaveBeenCalledTimes(controls.length)
    expect(controls).toHaveLength(5)
    for (const [input] of state.mutate.mock.calls) {
      expect(input.status).not.toBe('skipped')
    }
  })

  it('still reads a dose already recorded as Skipped, and Undo returns it to Due', () => {
    render(<PatientMedicationsPage />)

    const skipped = row('Lunch tablet')
    expect(skipped.getByText('Skipped')).toBeInTheDocument()
    expect(skipped.queryByRole('button', { name: /^Mark taken/ })).not.toBeInTheDocument()

    fireEvent.click(skipped.getByRole('button', { name: 'Undo' }))

    expect(state.mutate).toHaveBeenCalledWith({ doseId: 'd4', status: 'pending' })
  })

  it('keeps Missed and Taken exactly as they were', () => {
    render(<PatientMedicationsPage />)

    expect(row('Early tablet').getByText('Missed')).toBeInTheDocument()
    expect(row('Breakfast tablet').getByText('Taken')).toBeInTheDocument()
  })
})

describe('the dashboard', () => {
  it('offers Mark taken and no Skip', () => {
    render(
      <MemoryRouter>
        <PatientDashboard />
      </MemoryRouter>,
    )

    expect(
      row('Morning tablet').getByRole('button', { name: /^Mark taken/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument()
  })
})
