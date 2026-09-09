import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA-03 — a doctor can call off an appointment.
 *
 * The database and API always allowed it: `appointment_update` admits anyone
 * passing `can_access_patient`, the transition trigger constrains only the
 * patient, and `setAppointmentStatus` is documented as covering cancellation.
 * Only the button was missing, so a doctor told by phone that a patient
 * cannot attend had to either ask the patient to do it, or mark the
 * appointment completed — recording a consultation that never happened —
 * or leave it standing, which now sends both parties a reminder for a visit
 * that will not occur.
 */

const appointments = vi.hoisted(() => ({ data: [] as unknown[] }))
const setStatus = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as unknown,
}))

vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => appointments,
  useRescheduleRequests: () => ({ data: [], isLoading: false, isError: false }),
  useDecideRescheduleRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useSetAppointmentStatus: () => setStatus,
  // Used by the scheduling dialog the page mounts.
  useCreateAppointment: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}))

// The page mounts the scheduling dialog, which loads the caseload.
vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => ({ data: [], isLoading: false, isError: false }),
}))

const { DoctorAppointmentsPage } = await import(
  '@/features/appointments/pages/doctor-appointments-page'
)

function appointment(status: string) {
  return {
    appointment_id: `a-${status}`,
    pat_id: 'p-1',
    doc_id: 'd-1',
    // Comfortably ahead, so it lands under "Upcoming".
    appointment_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    appointment_status: status,
    patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
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
})

/** The page links to each patient's record, so it needs a router. */
function renderPage() {
  return render(
    <MemoryRouter>
      <DoctorAppointmentsPage />
    </MemoryRouter>,
  )
}

const cancelButton = () => screen.queryByRole('button', { name: /^Cancel$/ })

describe('doctor cancelling an appointment', () => {
  it.each(['scheduled', 'confirmed'])(
    'offers Cancel for a %s appointment',
    (status) => {
      appointments.data = [appointment(status)]
      renderPage()
      expect(cancelButton()).toBeInTheDocument()
    },
  )

  it.each(['cancelled', 'completed', 'no_show'])(
    'does not offer Cancel for a %s appointment',
    (status) => {
      appointments.data = [appointment(status)]
      renderPage()
      expect(cancelButton()).not.toBeInTheDocument()
    },
  )

  it('preserves Mark completed where it was already offered', () => {
    // The Cancel guard is separate from `isOpen` precisely so this does not
    // change: a no_show recorded in error can still be marked completed.
    for (const status of ['scheduled', 'confirmed', 'no_show']) {
      appointments.data = [appointment(status)]
      const { unmount } = renderPage()
      expect(
        screen.getByRole('button', { name: /mark completed/i }),
      ).toBeInTheDocument()
      unmount()
    }
  })

  it('confirms before cancelling, naming who and when', () => {
    // "Are you sure" about nothing in particular is how the wrong
    // appointment gets cancelled.
    appointments.data = [appointment('scheduled')]
    renderPage()
    fireEvent.click(cancelButton() as HTMLElement)

    // Scoped to the dialog: the row behind it names the patient too, so an
    // unscoped match would pass even if the confirmation said nothing.
    const confirmation = within(screen.getByRole('dialog'))
    expect(confirmation.getByText('Cancel this appointment?')).toBeInTheDocument()
    expect(confirmation.getByText(/Alice Santos/)).toBeInTheDocument()
    // And when, so two appointments for the same patient are told apart.
    expect(confirmation.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    // Nothing has been sent yet.
    expect(setStatus.mutate).not.toHaveBeenCalled()
  })

  it('cancels only once the confirmation is accepted', async () => {
    appointments.data = [appointment('scheduled')]
    renderPage()
    fireEvent.click(cancelButton() as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /Cancel appointment/ }))

    await waitFor(() => expect(setStatus.mutate).toHaveBeenCalledTimes(1))
    expect(setStatus.mutate.mock.calls[0][0]).toMatchObject({
      appointmentId: 'a-scheduled',
      status: 'cancelled',
    })
  })

  it('changes nothing when the confirmation is dismissed', () => {
    appointments.data = [appointment('scheduled')]
    renderPage()
    fireEvent.click(cancelButton() as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /Keep appointment/ }))

    expect(setStatus.mutate).not.toHaveBeenCalled()
    expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument()
  })

  it('reuses the existing status mutation rather than a new endpoint', () => {
    // Same mutation the patient side and Mark completed already use.
    appointments.data = [appointment('confirmed')]
    renderPage()
    fireEvent.click(cancelButton() as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /Cancel appointment/ }))

    expect(setStatus.mutate).toHaveBeenCalledWith(
      { appointmentId: 'a-confirmed', status: 'cancelled' },
      expect.anything(),
    )
  })
})
