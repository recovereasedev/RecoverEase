import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA 09/06/2026 #1 — finding a patient when the caseload is long.
 *
 * The dialog used a native `<select>`, which is a scroll on a phone once a
 * clinician has more than a handful of patients. It is a combobox now.
 *
 * What must not change is the part that is load-bearing: an appointment
 * belongs to the patient's assigned clinician, a database trigger rejects
 * any other pairing, and so the doctor is derived from the chosen patient
 * and never offered as a choice. These assert the search works AND that it
 * still yields the assignment.
 */

const mockPatients = vi.hoisted(() => ({ data: [] as unknown[] }))
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

/** Two clinicians' worth of patients — only one clinician's should appear. */
const MINE = [
  { pat_id: 'p-1', doc_id: 'd-1', pat_first_name: 'Alice', pat_last_name: 'Santos' },
  { pat_id: 'p-2', doc_id: 'd-1', pat_first_name: 'Bob', pat_last_name: 'Reyes' },
  { pat_id: 'p-3', doc_id: 'd-1', pat_first_name: 'Carla', pat_last_name: 'Dizon' },
]

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  mockCreate.mutate.mockClear()
  mockPatients.data = MINE
})

function open() {
  render(<ScheduleAppointmentDialog isOpen onClose={() => {}} />)
  return screen.getByRole('combobox')
}

describe('the searchable patient picker', () => {
  it('is a combobox, not a plain select', () => {
    const input = open()
    expect(input).toHaveAttribute('role', 'combobox')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    // The old control is gone.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('is labelled by its Field, so it can be named and reached by label', () => {
    // Regression: the first version minted its own id and ignored the id the
    // surrounding <Field> had already pointed its <label> at, leaving a
    // control a screen reader could not name and `getByLabel` could not find.
    open()
    expect(screen.getByLabelText(/patient/i)).toHaveAttribute(
      'role',
      'combobox',
    )
  })

  it('lists every one of the clinician’s patients when opened', () => {
    const input = open()
    fireEvent.focus(input)

    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option')).toHaveLength(3)
    expect(within(list).getByText('Alice Santos')).toBeInTheDocument()
    expect(within(list).getByText('Carla Dizon')).toBeInTheDocument()
  })

  it('narrows the list by name as you type', () => {
    const input = open()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'car' } })

    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Carla Dizon')
  })

  it('matches on surname too, not just the first name', () => {
    const input = open()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'reyes' } })

    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Bob Reyes')
  })

  it('says so when nothing matches, rather than showing an empty box', () => {
    const input = open()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'zzzz' } })

    expect(
      screen.getByText('No patient of yours matches that name'),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('still derives the assigned doctor from the chosen patient', async () => {
    // The load-bearing assertion. The doctor is never picked; it comes from
    // the patient's assignment, and a database trigger rejects anything else.
    const input = open()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'bob' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bob Reyes/ }))

    fireEvent.change(screen.getByLabelText(/Date and time/), {
      target: { value: '2099-01-01T09:00' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^Schedule appointment$/ }),
    )

    await waitFor(() => expect(mockCreate.mutate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mutate.mock.calls[0][0]).toMatchObject({
      patientId: 'p-2',
      doctorId: 'd-1',
    })
  })

  it('is operable by keyboard alone', () => {
    const input = open()
    fireEvent.focus(input)
    // Arrow to the second option, Enter to take it.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('Bob Reyes')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on Escape without changing the selection', () => {
    const input = open()
    fireEvent.focus(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Alice Santos/ }))
    expect(input).toHaveValue('Alice Santos')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'carla' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue('Alice Santos')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('offers only the patients the hook returned, never anyone else', () => {
    // The combobox has no data source of its own: it renders exactly what
    // `useMyPatients()` gave it, which RLS has already scoped to this
    // clinician. A patient outside that list cannot be reached by typing.
    const input = open()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'kirby' } })

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(
      screen.getByText('No patient of yours matches that name'),
    ).toBeInTheDocument()
  })

  it('refuses to submit until a patient is actually chosen', () => {
    open()
    fireEvent.click(
      screen.getByRole('button', { name: /^Schedule appointment$/ }),
    )
    expect(
      screen.getByText('Choose which patient this appointment is for.'),
    ).toBeInTheDocument()
    expect(mockCreate.mutate).not.toHaveBeenCalled()
  })
})
