import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * NA-02 to NA-05, from the patient's side: being told when an action fails,
 * a request whose appointment is closed, a double click, and a time already
 * in the past.
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
const requests = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/appointments/api', () => api)

// The appointments page reads the patient's own requests directly.
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: async () => ({ data: requests.data, error: null }) }),
    }),
  },
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-alice',
    role: 'patient',
    displayName: 'Alice',
    profile: {
      kind: 'patient',
      patient: { pat_id: 'p-1', doc_id: 'd-1', pat_first_name: 'Alice', pat_last_name: 'Santos' },
    },
  }),
}))

// The dashboard's other cards.
vi.mock('@/features/medications/hooks', () => ({
  useDoses: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))
vi.mock('@/features/recovery-logs/hooks', () => ({
  useRecoveryLogs: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}))
vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}))

const { PatientAppointmentsPage } = await import(
  '@/features/appointments/pages/patient-appointments-page'
)
const { PatientDashboard } = await import('@/features/dashboard/pages/patient-dashboard')

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
    patient: null,
  }
}

function pendingRequest(appointmentId: string) {
  return {
    reschedule_request_id: 'r1',
    appointment_id: appointmentId,
    user_id: 'u-alice',
    reschedule_request_date: at(7),
    reschedule_request_reason: null,
    reschedule_request_status: 'pending',
    reschedule_request_responded_at: null,
    reschedule_request_created_at: at(-1),
  }
}

const refusal = (message: string, code = 'P0001') => ({ message, code, details: null, hint: null })

/** A `datetime-local` value, in the browser's zone, as the picker produces it. */
function localValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const earlierToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return localValue(d)
}
const thisMinute = () => localValue(new Date())
const inTwoDays = () => localValue(new Date(Date.now() + 2 * DAY))

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

/** Resolves on the next macrotask, the way a network call would. */
const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 10))

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
  requests.data = []
  api.fetchAppointments.mockResolvedValue([appointment('a-1', 'scheduled', 5)])
  api.setAppointmentStatus.mockResolvedValue(undefined)
  api.createAppointment.mockImplementation(() => later({}))
  api.createRescheduleRequest.mockImplementation(() => later({}))
})

async function openBooking() {
  renderWith(<PatientAppointmentsPage />)
  await screen.findByRole('button', { name: /request new time/i })
  fireEvent.click(screen.getByRole('button', { name: /book a follow-up/i }))
  const dialog = screen.getByRole('dialog')
  return {
    dialog,
    type: (value: string) =>
      fireEvent.change(within(dialog).getByLabelText(/date and time/i), { target: { value } }),
    submit: () => within(dialog).getByRole('button', { name: /^book appointment$/i }),
  }
}

async function openReschedule() {
  renderWith(<PatientAppointmentsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /request new time/i }))
  const dialog = screen.getByRole('dialog')
  return {
    dialog,
    type: (value: string) =>
      fireEvent.change(within(dialog).getByLabelText(/preferred new date and time/i), {
        target: { value },
      }),
    submit: () => within(dialog).getByRole('button', { name: /^send request$/i }),
  }
}

// ---------------------------------------------------------------------------
describe('NA-02 a failed action says so', () => {
  it('confirming: shows why, and the appointment can still be confirmed', async () => {
    api.setAppointmentStatus.mockRejectedValue(refusal('upstream unavailable'))
    renderWith(<PatientAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your attendance was not confirmed')
    expect(alert).toHaveTextContent('upstream unavailable')
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })

  it('cancelling: keeps the confirmation open with the reason, and a retry closes it', async () => {
    api.setAppointmentStatus
      .mockRejectedValueOnce(refusal('upstream unavailable'))
      .mockResolvedValueOnce(undefined)
    renderWith(<PatientAppointmentsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel appointment/i }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The appointment was not cancelled',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /cancel appointment/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('requesting a new time: shows why, and keeps the request open', async () => {
    api.createRescheduleRequest.mockRejectedValue(refusal('upstream unavailable'))
    const form = await openReschedule()

    form.type(inTwoDays())
    fireEvent.click(form.submit())

    expect(await within(form.dialog).findByRole('alert')).toHaveTextContent('The request was not sent')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('confirming from the dashboard: shows why', async () => {
    api.setAppointmentStatus.mockRejectedValue(refusal('upstream unavailable'))
    renderWith(<PatientDashboard />)

    fireEvent.click(await screen.findByRole('button', { name: /confirm attendance/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your attendance was not confirmed')
  })
})

// ---------------------------------------------------------------------------
describe('NA-03 a request whose appointment is closed', () => {
  it.each([
    ['cancelled', 'was cancelled'],
    ['completed', 'has been completed'],
    ['no_show', 'was marked as a no-show'],
  ])('is not shown as awaiting the doctor when the appointment %s', async (status, phrase) => {
    api.fetchAppointments.mockResolvedValue([appointment('a-1', status, 5)])
    requests.data = [pendingRequest('a-1')]
    renderWith(<PatientAppointmentsPage />)

    expect(
      await screen.findByText(new RegExp(`This appointment ${phrase}, so your request to move it`)),
    ).toBeInTheDocument()
    expect(screen.queryByText('Awaiting review')).not.toBeInTheDocument()
    expect(screen.queryByText(/has not responded/)).not.toBeInTheDocument()
  })

  it('is still shown as awaiting the doctor while the appointment is open', async () => {
    requests.data = [pendingRequest('a-1')]
    renderWith(<PatientAppointmentsPage />)

    expect(await screen.findByText('Awaiting review')).toBeInTheDocument()
    expect(screen.getByText(/Your doctor has not responded yet/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
describe('NA-04 one click, one request', () => {
  it('books once for two clicks in the same task, and reports the booking', async () => {
    const form = await openBooking()
    form.type(inTwoDays())

    const submit = form.submit()
    act(() => {
      submit.click()
      submit.click()
    })

    // React Query starts the request a few ticks after `mutate()`, so the
    // count is read once the booking has finished — by which time a second,
    // unguarded submission would have been sent too.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.createAppointment).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/was not booked/)).not.toBeInTheDocument()
  })

  it('sends one reschedule request for two clicks in the same task', async () => {
    const form = await openReschedule()
    form.type(inTwoDays())

    const submit = form.submit()
    act(() => {
      submit.click()
      submit.click()
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.createRescheduleRequest).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/was not sent/)).not.toBeInTheDocument()
  })

  it('lets the next booking through once the first has finished', async () => {
    const form = await openBooking()
    form.type(inTwoDays())
    fireEvent.click(form.submit())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /book a follow-up/i }))
    const again = screen.getByRole('dialog')
    fireEvent.change(within(again).getByLabelText(/date and time/i), {
      target: { value: localValue(new Date(Date.now() + 3 * DAY)) },
    })
    fireEvent.click(within(again).getByRole('button', { name: /^book appointment$/i }))

    await waitFor(() => expect(api.createAppointment).toHaveBeenCalledTimes(2))
  })
})

// ---------------------------------------------------------------------------
describe('NA-05 a time already in the past is refused before anything is sent', () => {
  const PAST: [string, () => string][] = [
    ['a typed past date', () => '2024-01-15T09:00'],
    ['earlier today', earlierToday],
    ['the current minute', thisMinute],
  ]

  it.each(PAST)('booking refuses %s', async (_label, value) => {
    const form = await openBooking()
    form.type(value())
    fireEvent.click(form.submit())

    expect(await within(form.dialog).findByText('Choose a time in the future.')).toBeInTheDocument()
    expect(api.createAppointment).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('booking sends a future time, as the instant it names', async () => {
    const form = await openBooking()
    const value = inTwoDays()
    form.type(value)
    fireEvent.click(form.submit())

    await waitFor(() => expect(api.createAppointment).toHaveBeenCalledTimes(1))
    expect(api.createAppointment.mock.calls[0]![0]).toEqual({
      patientId: 'p-1',
      doctorId: 'd-1',
      scheduledFor: new Date(value).toISOString(),
    })
  })

  it.each(PAST)('a reschedule request refuses %s', async (_label, value) => {
    const form = await openReschedule()
    form.type(value())
    fireEvent.click(form.submit())

    expect(await within(form.dialog).findByText('Choose a time in the future.')).toBeInTheDocument()
    expect(api.createRescheduleRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a reschedule request sends a future time', async () => {
    const form = await openReschedule()
    const value = inTwoDays()
    form.type(value)
    fireEvent.click(form.submit())

    await waitFor(() => expect(api.createRescheduleRequest).toHaveBeenCalledTimes(1))
    expect(api.createRescheduleRequest.mock.calls[0]![0]).toMatchObject({
      appointmentId: 'a-1',
      proposedFor: new Date(value).toISOString(),
    })
  })
})
