import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 6.7, "View Appointment History", as the patient sees it.
 *
 * The History section lists the visits already behind them, each with its
 * outcome - attended, cancelled or missed - in words and an icon, never
 * colour alone. Upcoming visits are not history, and history is not offered
 * to be confirmed, cancelled or rescheduled.
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

// The appointments page reads the patient's own reschedule requests directly.
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: async () => ({ data: [], error: null }) }),
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

const { PatientAppointmentsPage } = await import(
  '@/features/appointments/pages/patient-appointments-page'
)

const NOW = new Date(2026, 9, 14, 10, 30)
const DAY = 86_400_000
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()

function appointment(id: string, status: string, days: number) {
  return {
    appointment_id: id,
    pat_id: 'p-1',
    doc_id: 'd-1',
    appointment_date: at(days),
    appointment_status: status,
    appointment_created_at: at(-60),
    appointment_reminder_sent_at: null,
    patient: null,
  }
}

async function renderPage(appointments: ReturnType<typeof appointment>[]) {
  // Most recent first, as `fetchAppointments` orders them.
  api.fetchAppointments.mockResolvedValue(
    [...appointments].sort((a, b) => b.appointment_date.localeCompare(a.appointment_date)),
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PatientAppointmentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole('heading', { name: 'History' })
  // History is drawn before the appointments arrive, as an empty list; wait
  // for them, so an empty history means there is none rather than not yet.
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(api.fetchAppointments).toHaveBeenCalled()
}

/** The History section, located by its heading. */
function history() {
  const heading = screen.getByRole('heading', { name: 'History' })
  const section = heading.closest('section')
  if (!section) throw new Error('History is not a section')
  return within(section)
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  api.fetchAppointments.mockReset()
  api.fetchRescheduleRequests.mockReset()
  api.fetchRescheduleRequests.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the patient’s appointment history', () => {
  it('says so plainly when there is none', async () => {
    await renderPage([appointment('a-next', 'scheduled', 7)])

    expect(history().getByText('You have no past appointments.')).toBeInTheDocument()
  })

  it('lists each past visit with its outcome in words, most recent first', async () => {
    await renderPage([
      appointment('a-done', 'completed', -3),
      appointment('a-cancelled', 'cancelled', -10),
      appointment('a-missed', 'no_show', -20),
    ])

    const rows = history().getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => within(row).getByText(/^(Completed|Cancelled|Missed)$/).textContent))
      .toEqual(['Completed', 'Cancelled', 'Missed'])
  })

  it('keeps upcoming visits out of history, and past ones out of upcoming', async () => {
    await renderPage([
      appointment('a-next', 'confirmed', 5),
      appointment('a-done', 'completed', -3),
    ])

    const rows = history().getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Completed')).toBeInTheDocument()
    expect(history().queryByText('Confirmed')).not.toBeInTheDocument()
  })

  it('offers nothing to do about a past visit', async () => {
    await renderPage([
      appointment('a-done', 'completed', -3),
      appointment('a-missed', 'no_show', -20),
    ])

    expect(history().queryAllByRole('button')).toEqual([])
    expect(history().queryAllByRole('link')).toEqual([])
  })
})
