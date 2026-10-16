import { render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'
import { formatDateTime } from '@/lib/format'

/**
 * Which appointment the patient's Appointments page puts forward as "Next
 * appointment", under "Confirm that you will attend, or ask for a different
 * time."
 *
 * It used to be simply the soonest future appointment, whatever its status,
 * so a cancelled one was presented as the visit to attend (found in a
 * production smoke test) while the dashboard - which leaves cancelled ones
 * out - said there was nothing upcoming. The page now applies the
 * dashboard's rule. A cancelled future appointment is still listed with its
 * status; it is just never the one asked about.
 */

const appointments = vi.hoisted(() => ({ data: [] as unknown[] }))
const mockUser = vi.hoisted(() => ({ current: null as AppUser | null }))

vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => appointments,
  useCreateAppointment: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
  useSetAppointmentStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useCreateRescheduleRequest: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => mockUser.current,
  useAuth: () => ({ user: mockUser.current, signOut: vi.fn(), refresh: vi.fn() }),
}))

// The page reads pending reschedule requests directly through react-query.
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>(
      '@tanstack/react-query',
    )
  return { ...actual, useQuery: () => ({ data: [], isLoading: false, isError: false }) }
})

const { PatientAppointmentsPage } = await import(
  '@/features/appointments/pages/patient-appointments-page'
)

const INSTRUCTION = 'Confirm that you will attend, or ask for a different time.'

/** A whole number of days ahead, so each appointment has its own date. */
function future(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function appointment(id: string, status: string, days: number) {
  return {
    appointment_id: id,
    pat_id: 'p-1',
    doc_id: 'd-1',
    appointment_date: future(days),
    appointment_status: status,
  }
}

const when = (row: { appointment_date: string }) => formatDateTime(row.appointment_date)
const nextCard = () => screen.queryByRole('region', { name: 'Next appointment' })
const laterList = () => screen.queryByRole('region', { name: 'Later' })

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  mockUser.current = {
    userId: 'u-1',
    email: 'alice@example.test',
    role: 'patient',
    displayName: 'Alice',
    mustChangePassword: false,
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } } as never,
  }
})

describe('the next appointment on the patient’s Appointments page', () => {
  it('does not put a cancelled future appointment forward as the next one', () => {
    const cancelled = appointment('a-cancelled', 'cancelled', 2)
    appointments.data = [cancelled]
    render(<PatientAppointmentsPage />)

    expect(nextCard()).not.toBeInTheDocument()
    // Still listed, with its status, so the patient can see it was called off.
    expect(screen.getByText(when(cancelled))).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('puts the later valid appointment forward when an earlier one was cancelled', () => {
    const cancelled = appointment('a-cancelled', 'cancelled', 2)
    const scheduled = appointment('a-scheduled', 'scheduled', 9)
    appointments.data = [cancelled, scheduled]
    render(<PatientAppointmentsPage />)

    const next = nextCard()!
    expect(next).toBeInTheDocument()
    expect(within(next).getByText(when(scheduled))).toBeInTheDocument()
    expect(within(next).getByText(INSTRUCTION)).toBeInTheDocument()
    expect(within(next).getByRole('button', { name: /confirm/i })).toBeInTheDocument()
    expect(within(next).queryByText(when(cancelled))).not.toBeInTheDocument()
    expect(within(next).queryByText('Cancelled')).not.toBeInTheDocument()

    // The cancelled one is still listed after it, with its status and no actions.
    const later = laterList()!
    expect(within(later).getByText(when(cancelled))).toBeInTheDocument()
    expect(within(later).getByText('Cancelled')).toBeInTheDocument()
    expect(within(later).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows no next appointment or attendance instruction when only cancelled ones remain', () => {
    const first = appointment('a-cancelled-1', 'cancelled', 2)
    const second = appointment('a-cancelled-2', 'cancelled', 6)
    appointments.data = [first, second]
    render(<PatientAppointmentsPage />)

    expect(nextCard()).not.toBeInTheDocument()
    expect(screen.queryByText(INSTRUCTION)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument()
    // The existing empty state says there is nothing upcoming...
    expect(screen.getByText('No upcoming appointments')).toBeInTheDocument()
    // ...and both cancelled appointments are still listed with their status.
    expect(screen.getByText(when(first))).toBeInTheDocument()
    expect(screen.getByText(when(second))).toBeInTheDocument()
    expect(screen.getAllByText('Cancelled')).toHaveLength(2)
  })

  it('still puts the soonest valid appointment forward, with the rest after it', () => {
    const scheduled = appointment('a-scheduled', 'scheduled', 3)
    const confirmed = appointment('a-confirmed', 'confirmed', 6)
    appointments.data = [confirmed, scheduled]
    render(<PatientAppointmentsPage />)

    const next = nextCard()!
    expect(within(next).getByText(when(scheduled))).toBeInTheDocument()
    expect(within(next).getByText(INSTRUCTION)).toBeInTheDocument()
    expect(within(next).getByRole('button', { name: /confirm/i })).toBeInTheDocument()
    expect(within(laterList()!).getByText(when(confirmed))).toBeInTheDocument()
  })

  it('puts a confirmed appointment forward too - only cancelled ones are passed over', () => {
    const confirmed = appointment('a-confirmed', 'confirmed', 4)
    appointments.data = [confirmed]
    render(<PatientAppointmentsPage />)

    expect(within(nextCard()!).getByText(when(confirmed))).toBeInTheDocument()
  })

  it('keeps the existing empty state, without the attendance instruction, when nothing is booked', () => {
    appointments.data = []
    render(<PatientAppointmentsPage />)

    expect(screen.getByRole('region', { name: 'Upcoming' })).toBeInTheDocument()
    expect(screen.getByText('No upcoming appointments')).toBeInTheDocument()
    expect(screen.queryByText(INSTRUCTION)).not.toBeInTheDocument()
  })
})
