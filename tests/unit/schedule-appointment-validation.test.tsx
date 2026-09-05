import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The refusals the dialog writes itself, before anything is sent.
 *
 * These sit alongside `describeSchedulingError`, which translates what the
 * server says. Both are part of one contract — every way this form can fail
 * says something a clinician can act on — so the fix to the server-side
 * classifier is covered here for the client-side half too, and neither can be
 * dropped without a test going red.
 */

const mockPatients = vi.hoisted(() => ({
  data: [
    {
      pat_id: 'p-1',
      doc_id: 'd-1',
      pat_first_name: 'ZZ Smoke',
      pat_last_name: 'Patient',
    },
  ] as unknown,
}))

const mockCreate = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}))

vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => mockPatients,
}))

vi.mock('@/features/appointments/hooks', () => ({
  useCreateAppointment: () => mockCreate,
}))

const { ScheduleAppointmentDialog } = await import(
  '@/features/appointments/components/schedule-appointment-dialog'
)

beforeAll(() => {
  // jsdom implements neither, and `Dialog` uses the native top layer.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  mockCreate.mutate.mockClear()
})

function open() {
  render(<ScheduleAppointmentDialog isOpen onClose={() => {}} />)
  return screen.getByRole('button', { name: /^Schedule appointment$/ })
}

describe('schedule appointment validation', () => {
  it('asks which patient when none is chosen', () => {
    fireEvent.click(open())
    expect(
      screen.getByText('Choose which patient this appointment is for.'),
    ).toBeInTheDocument()
    // Nothing is sent while the form is incomplete.
    expect(mockCreate.mutate).not.toHaveBeenCalled()
  })

  it('asks for a date and time when the slot is empty', () => {
    const submit = open()
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'p-1' },
    })
    fireEvent.click(submit)
    expect(screen.getByText('Choose a date and time.')).toBeInTheDocument()
    expect(mockCreate.mutate).not.toHaveBeenCalled()
  })

  it('refuses a time in the past', () => {
    const submit = open()
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'p-1' },
    })
    fireEvent.change(screen.getByLabelText(/Date and time/), {
      target: { value: '2020-01-01T09:00' },
    })
    fireEvent.click(submit)
    expect(screen.getByText('Choose a time in the future.')).toBeInTheDocument()
    expect(mockCreate.mutate).not.toHaveBeenCalled()
  })

  it('submits once for a complete, future appointment', () => {
    const submit = open()
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'p-1' },
    })
    fireEvent.change(screen.getByLabelText(/Date and time/), {
      target: { value: '2099-01-01T09:00' },
    })
    fireEvent.click(submit)
    expect(mockCreate.mutate).toHaveBeenCalledTimes(1)
  })

  it('sends one mutation for two clicks in the same task', () => {
    // The guard that this release added, at the level it actually operates:
    // `isPending` has not re-rendered yet, so only the synchronous ref stops
    // the second call. Two identical appointments reached production this way.
    const submit = open()
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'p-1' },
    })
    fireEvent.change(screen.getByLabelText(/Date and time/), {
      target: { value: '2099-01-01T09:00' },
    })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mockCreate.mutate).toHaveBeenCalledTimes(1)
  })
})
