import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * NA-01 to NA-03, from the clinician's side: closing out a visit that has
 * happened, being told when an action fails, and a reschedule request whose
 * appointment is already closed.
 *
 * The real hooks run against a mocked API module, so the mutation states the
 * screens react to are React Query's own rather than hand-set flags.
 */

const api = vi.hoisted(() => ({
  fetchAppointments: vi.fn(),
  fetchRescheduleRequests: vi.fn(),
  setAppointmentStatus: vi.fn(),
  decideRescheduleRequest: vi.fn(),
  createAppointment: vi.fn(),
  createRescheduleRequest: vi.fn(),
}))

vi.mock('@/features/appointments/api', () => api)

// The appointments page mounts the scheduling dialog, which loads the caseload.
vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-doctor',
    role: 'doctor',
    profile: { kind: 'doctor', doctor: { doc_id: 'd-1', doc_first_name: 'Alan' } },
  }),
}))

const { DoctorAppointmentsPage } = await import(
  '@/features/appointments/pages/doctor-appointments-page'
)
const { DoctorDashboard } = await import('@/features/dashboard/pages/doctor-dashboard')

const DAY = 86_400_000
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString()

function appointment(id: string, status: string, days: number) {
  return {
    appointment_id: id,
    pat_id: 'p-1',
    doc_id: 'd-1',
    appointment_date: at(days),
    appointment_status: status,
    appointment_created_at: at(-30),
    appointment_reminder_sent_at: null,
    patient: { pat_id: 'p-1', pat_first_name: 'Alice', pat_last_name: 'Santos' },
  }
}

function request(id: string, appointmentStatus: string) {
  return {
    reschedule_request_id: id,
    appointment_id: `a-${id}`,
    user_id: 'u-alice',
    reschedule_request_date: at(7),
    reschedule_request_reason: null,
    reschedule_request_status: 'pending',
    reschedule_request_responded_at: null,
    reschedule_request_created_at: at(-1),
    appointment: {
      appointment_id: `a-${id}`,
      appointment_date: at(5),
      appointment_status: appointmentStatus,
      pat_id: 'p-1',
      patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
    },
  }
}

/** The shape PostgREST rejects with: a plain object, not an Error. */
const refusal = (message: string, code = 'P0001') => ({ message, code, details: null, hint: null })

function renderWith(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const button = (name: RegExp) => screen.queryByRole('button', { name })

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  // Reset, not clear: a queued `…Once` value a test did not use must not
  // leak into the next one.
  vi.resetAllMocks()
  api.fetchAppointments.mockResolvedValue([])
  api.fetchRescheduleRequests.mockResolvedValue([])
  api.setAppointmentStatus.mockResolvedValue(undefined)
  api.decideRescheduleRequest.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
describe('NA-01 closing out a visit', () => {
  it.each(['scheduled', 'confirmed'])(
    'offers Mark completed and Mark no-show once a %s visit has passed',
    async (status) => {
      api.fetchAppointments.mockResolvedValue([appointment('a-past', status, -2)])
      renderWith(<DoctorAppointmentsPage />)

      expect(await screen.findByRole('button', { name: /mark completed/i })).toBeInTheDocument()
      expect(button(/mark no-show/i)).toBeInTheDocument()
      // A visit that has happened is closed out, not called off.
      expect(button(/^cancel$/i)).not.toBeInTheDocument()
    },
  )

  it.each(['scheduled', 'confirmed'])(
    'offers no outcome before a %s appointment has happened',
    async (status) => {
      api.fetchAppointments.mockResolvedValue([appointment('a-future', status, 3)])
      renderWith(<DoctorAppointmentsPage />)

      expect(await screen.findByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
      expect(button(/mark completed/i)).not.toBeInTheDocument()
      expect(button(/mark no-show/i)).not.toBeInTheDocument()
    },
  )

  it.each([
    ['cancelled', -2],
    ['completed', -2],
    ['no_show', -2],
    ['cancelled', 3],
    ['completed', 3],
    ['no_show', 3],
  ])('offers nothing on a %s appointment (%i days away)', async (status, days) => {
    api.fetchAppointments.mockResolvedValue([appointment('a-closed', status, days)])
    renderWith(<DoctorAppointmentsPage />)

    await screen.findByText('Alice Santos')
    expect(button(/mark completed/i)).not.toBeInTheDocument()
    expect(button(/mark no-show/i)).not.toBeInTheDocument()
    expect(button(/^cancel$/i)).not.toBeInTheDocument()
  })

  it.each([
    ['completed', /mark completed/i],
    ['no_show', /mark no-show/i],
  ])('records a past visit as %s', async (status, name) => {
    api.fetchAppointments.mockResolvedValue([appointment('a-past', 'scheduled', -2)])
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name }))
    await waitFor(() =>
      expect(api.setAppointmentStatus).toHaveBeenCalledWith('a-past', status),
    )
    expect(api.setAppointmentStatus).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
describe('NA-02 a failed action says so', () => {
  it.each([
    [/mark completed/i, 'The visit was not marked completed'],
    [/mark no-show/i, 'The visit was not marked as a no-show'],
  ])('%s: shows why, and leaves the visit open', async (name, title) => {
    api.fetchAppointments.mockResolvedValue([appointment('a-past', 'scheduled', -2)])
    api.setAppointmentStatus.mockRejectedValue(refusal('upstream unavailable'))
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(title)
    expect(alert).toHaveTextContent('upstream unavailable')
    expect(button(/mark completed/i)).toBeInTheDocument()
    expect(button(/mark no-show/i)).toBeInTheDocument()
  })

  it('keeps the cancel confirmation open with the reason, and closes it on a retry that succeeds', async () => {
    api.fetchAppointments.mockResolvedValue([appointment('a-future', 'scheduled', 3)])
    api.setAppointmentStatus
      .mockRejectedValueOnce(refusal('upstream unavailable'))
      .mockResolvedValueOnce(undefined)
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel appointment/i }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The appointment was not cancelled',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /cancel appointment/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.setAppointmentStatus).toHaveBeenCalledTimes(2)
  })

  it('approving: shows why, and the request stays to be decided', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'scheduled')])
    api.decideRescheduleRequest.mockRejectedValue(
      refusal('duplicate key value violates unique constraint "appointment_one_active_per_slot"', '23505'),
    )
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /approve and move/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The request was not approved')
    // Database internals are not shown.
    expect(alert).not.toHaveTextContent(/duplicate key|constraint/)
    expect(button(/approve and move/i)).toBeInTheDocument()
  })

  it('declining: shows why', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'scheduled')])
    api.decideRescheduleRequest.mockRejectedValue(refusal('upstream unavailable'))
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /^decline$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The request was not declined')
  })

  it('approving from the dashboard: shows why', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'scheduled')])
    api.decideRescheduleRequest.mockRejectedValue(
      refusal('This appointment is no longer active, so it cannot be moved to a new time', '42501'),
    )
    renderWith(<DoctorDashboard />)

    fireEvent.click(await screen.findByRole('button', { name: /approve and move/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The request was not approved')
    // A refusal written for a person is shown as it was written.
    expect(alert).toHaveTextContent('This appointment is no longer active')
  })
})

// ---------------------------------------------------------------------------
describe('NA-03 a request whose appointment is closed', () => {
  it.each([
    ['cancelled', 'was cancelled'],
    ['completed', 'has been completed'],
    ['no_show', 'was marked as a no-show'],
  ])('is shown as closed, with no approval, when the appointment %s', async (status, phrase) => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', status)])
    renderWith(<DoctorAppointmentsPage />)

    expect(
      await screen.findByText(new RegExp(`This appointment ${phrase}, so it can no longer be moved`)),
    ).toBeInTheDocument()
    expect(button(/approve and move/i)).not.toBeInTheDocument()
    // Declining is how a stale request is cleared (migration 17).
    expect(button(/^decline$/i)).toBeInTheDocument()
  })

  it('is shown as closed on the dashboard too', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'cancelled')])
    renderWith(<DoctorDashboard />)

    expect(await screen.findByText(/This appointment was cancelled, so it can no longer be moved/)).toBeInTheDocument()
    expect(button(/approve and move/i)).not.toBeInTheDocument()
    expect(button(/^decline$/i)).toBeInTheDocument()
  })

  it('stays an ordinary decision while the appointment is open', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'scheduled')])
    renderWith(<DoctorAppointmentsPage />)

    expect(await screen.findByRole('button', { name: /approve and move/i })).toBeInTheDocument()
    expect(button(/^decline$/i)).toBeInTheDocument()
    expect(screen.queryByText(/can no longer be moved/)).not.toBeInTheDocument()
  })

  it('can still be cleared by declining it', async () => {
    api.fetchRescheduleRequests.mockResolvedValue([request('r1', 'cancelled')])
    renderWith(<DoctorAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /^decline$/i }))
    await waitFor(() =>
      expect(api.decideRescheduleRequest).toHaveBeenCalledWith('r1', 'declined'),
    )
  })
})
