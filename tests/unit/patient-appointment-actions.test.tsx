import { render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'

/**
 * Which actions a patient is offered on an appointment.
 *
 * "Request new time" and "Cancel" used to render regardless of status, so a
 * cancelled appointment offered both. Cancelling an already cancelled
 * appointment is merely pointless; requesting a new time was not, because
 * approving that request set the appointment back to 'scheduled' and the
 * cancellation vanished from the record.
 *
 * The database refuses that now. This is the other half: not offering an
 * action that cannot legitimately be taken.
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

/** Comfortably in the future, so every row lands under "Upcoming". */
function future(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function appointment(status: string, days: number) {
  return {
    appointment_id: `a-${status}`,
    pat_id: 'p-1',
    doc_id: 'd-1',
    appointment_date: future(days),
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
  mockUser.current = {
    userId: 'u-1',
    email: 'alice@example.test',
    role: 'patient',
    displayName: 'Alice',
    mustChangePassword: false,
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } } as never,
  }
})

/**
 * The row for one appointment, found by the status badge it carries.
 *
 * `textContent`, not `innerText`: jsdom does no layout, so `innerText` is
 * not populated and the walk never terminates.
 */
function rowFor(label: RegExp) {
  let node: HTMLElement | null = screen.getByText(label) as HTMLElement
  while (node && !/Request new time|Cancel|Confirm/.test(node.textContent ?? '')) {
    node = node.parentElement
  }
  if (!node) throw new Error('No row found carrying that status badge')
  return node
}

describe('patient appointment actions', () => {
  it('offers no reschedule or cancel on a cancelled appointment', () => {
    appointments.data = [appointment('cancelled', 30)]
    render(<PatientAppointmentsPage />)

    // The appointment is still listed — it is a future appointment and the
    // patient should see it — but it cannot be acted on.
    expect(screen.getByText(/Cancelled/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /request new time/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^cancel$/i }),
    ).not.toBeInTheDocument()
  })

  it.each(['completed', 'no_show'])(
    'offers no reschedule or cancel on a %s appointment',
    (status) => {
      appointments.data = [appointment(status, 30)]
      render(<PatientAppointmentsPage />)

      expect(
        screen.queryByRole('button', { name: /request new time/i }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /^cancel$/i }),
      ).not.toBeInTheDocument()
    },
  )

  it('still offers confirm, reschedule and cancel on a scheduled appointment', () => {
    // The guard must not take away what a patient is supposed to be able to
    // do. This is the test that fails if the condition is too broad.
    appointments.data = [appointment('scheduled', 30)]
    render(<PatientAppointmentsPage />)

    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /request new time/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
  })

  it('offers reschedule and cancel — but not confirm — once confirmed', () => {
    // 'confirmed' is still an open appointment: it can be moved or called
    // off. Confirming it again is what makes no sense.
    appointments.data = [appointment('confirmed', 30)]
    render(<PatientAppointmentsPage />)

    expect(
      screen.queryByRole('button', { name: /confirm/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /request new time/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
  })

  it('acts on each appointment independently in a mixed list', () => {
    // A cancelled row next to a scheduled one must not suppress the actions
    // on the scheduled one, nor borrow them.
    appointments.data = [appointment('scheduled', 10), appointment('cancelled', 20)]
    render(<PatientAppointmentsPage />)

    expect(
      screen.getAllByRole('button', { name: /request new time/i }),
    ).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^cancel$/i })).toHaveLength(1)

    const open = rowFor(/^Scheduled$/i)
    expect(
      within(open).getByRole('button', { name: /^cancel$/i }),
    ).toBeInTheDocument()
  })
})
