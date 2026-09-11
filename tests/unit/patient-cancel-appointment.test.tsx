import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'

/**
 * F-02 — a patient confirms before cancelling.
 *
 * Cancelling used to happen on the first tap. It now also notifies the
 * doctor, and it cannot be undone from this screen, so it is confirmed first
 * — the same step the clinician's side already has.
 */

const appointments = vi.hoisted(() => ({ data: [] as unknown[] }))
const mockUser = vi.hoisted(() => ({ current: null as AppUser | null }))
const setStatus = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as unknown,
}))

vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => appointments,
  useCreateAppointment: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
  useSetAppointmentStatus: () => setStatus,
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

function appointment(status: string) {
  return {
    appointment_id: `a-${status}`,
    pat_id: 'p-1',
    doc_id: 'd-1',
    // Comfortably ahead, so it lands under "Upcoming".
    appointment_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    appointment_status: status,
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
  setStatus.mutate.mockClear()
  mockUser.current = {
    userId: 'u-1',
    email: 'alice@example.test',
    role: 'patient',
    displayName: 'Alice',
    mustChangePassword: false,
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } } as never,
  }
})

const cancelButton = () => screen.getByRole('button', { name: /^Cancel$/ })

describe('patient cancelling an appointment', () => {
  it('asks first, naming when, and sends nothing yet', () => {
    appointments.data = [appointment('scheduled')]
    render(<PatientAppointmentsPage />)
    fireEvent.click(cancelButton())

    const confirmation = within(screen.getByRole('dialog'))
    expect(confirmation.getByText('Cancel this appointment?')).toBeInTheDocument()
    // Which appointment — the time is what tells two of them apart.
    expect(confirmation.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    expect(setStatus.mutate).not.toHaveBeenCalled()
  })

  it('says it will be cancelled, the doctor is notified, and no reminder is sent', () => {
    appointments.data = [appointment('confirmed')]
    render(<PatientAppointmentsPage />)
    fireEvent.click(cancelButton())

    const confirmation = within(screen.getByRole('dialog'))
    expect(confirmation.getByText(/This appointment will be cancelled\./)).toBeInTheDocument()
    expect(
      confirmation.getByText(/Your doctor is notified, and no reminder is sent for it\./),
    ).toBeInTheDocument()
  })

  it('cancels through the existing status mutation once confirmed', async () => {
    appointments.data = [appointment('scheduled')]
    render(<PatientAppointmentsPage />)
    fireEvent.click(cancelButton())
    fireEvent.click(screen.getByRole('button', { name: /Cancel appointment/ }))

    await waitFor(() => expect(setStatus.mutate).toHaveBeenCalledTimes(1))
    expect(setStatus.mutate).toHaveBeenCalledWith(
      { appointmentId: 'a-scheduled', status: 'cancelled' },
      expect.anything(),
    )
  })

  it('changes nothing when the patient keeps the appointment', () => {
    appointments.data = [appointment('scheduled')]
    render(<PatientAppointmentsPage />)
    fireEvent.click(cancelButton())
    fireEvent.click(screen.getByRole('button', { name: /Keep appointment/ }))

    expect(setStatus.mutate).not.toHaveBeenCalled()
    expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument()
  })

  it('leaves confirming attendance as a single tap', () => {
    // Only cancellation gained a step. Confirming is not destructive and
    // notifies nobody.
    appointments.data = [appointment('scheduled')]
    render(<PatientAppointmentsPage />)
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(setStatus.mutate).toHaveBeenCalledWith({
      appointmentId: 'a-scheduled',
      status: 'confirmed',
    })
  })
})
