import { act, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA 9/13 on the patient's own screens: each of today's doses reads Due,
 * Overdue or Missed by its time, an Overdue dose can still be recorded, and a
 * page left open moves a dose from Due to Overdue as its time passes.
 */

const doses = vi.hoisted(() => ({ today: [] as unknown[] }))

vi.mock('@/features/medications/hooks', () => ({
  // Only the "today" window is filled, so each badge appears once.
  useDoses: (_patientId: string, from: string) => {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    return {
      data: from === startOfToday.toISOString() ? doses.today : [],
      isPending: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useMedicationSchedules: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
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
const at = (hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 8, 13, hours, minutes, seconds, 0)

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
  doses.today = [
    dose('d1', 'Early tablet', 'missed', at(2)),
    dose('d2', 'Breakfast tablet', 'taken', at(7)),
    dose('d3', 'Morning tablet', 'pending', at(8)),
    dose('d4', 'Noon tablet', 'pending', at(12)),
    dose('d5', 'Evening tablet', 'pending', at(20)),
  ]
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each([
  ['medication page', () => <PatientMedicationsPage />, 'Taken'],
  [
    'dashboard',
    () => (
      <MemoryRouter>
        <PatientDashboard />
      </MemoryRouter>
    ),
    /^Mark taken/,
  ],
] as [string, () => ReactElement, string | RegExp][])(
  'today’s doses on the %s',
  (_label, page, recordName) => {
    it('reads each dose by its time: Missed, Overdue, then Due', () => {
      render(page())

      expect(row('Early tablet').getByText('Missed')).toBeInTheDocument()
      expect(row('Morning tablet').getByText('Overdue')).toBeInTheDocument()
      // Exactly at its time a dose is still Due.
      expect(row('Noon tablet').getByText('Due')).toBeInTheDocument()
      expect(row('Evening tablet').getByText('Due')).toBeInTheDocument()
      expect(row('Breakfast tablet').getByText('Taken')).toBeInTheDocument()
    })

    it('still lets an Overdue dose be recorded', () => {
      render(page())

      expect(
        row('Morning tablet').getByRole('button', { name: recordName }),
      ).toBeInTheDocument()
    })

    it('moves a dose from Due to Overdue while the page is open', () => {
      vi.setSystemTime(at(19, 59, 30))
      render(page())
      expect(row('Evening tablet').getByText('Due')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      expect(row('Evening tablet').getByText('Overdue')).toBeInTheDocument()
      expect(row('Evening tablet').queryByText('Due')).not.toBeInTheDocument()
    })
  },
)
