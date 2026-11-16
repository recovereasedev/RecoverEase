import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A medicine's own instructions (migration 58).
 *
 * The doctor writes them on the medication form and can change them on a
 * medicine already prescribed; the patient reads them under that medicine
 * and has no way to change them. They are optional: left empty, nothing is
 * saved and nothing is shown.
 */

const created = vi.hoisted(() => ({
  prescription: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  schedule: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}))
const updated = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}))
const schedules = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/medications/hooks', () => ({
  useCreatePrescription: () => created.prescription,
  useCreateMedicationSchedule: () => created.schedule,
  useUpdateMedicationInstructions: () => updated,
  useMedicationConflicts: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useEndMedicationSchedule: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMedicationSchedules: () => ({
    data: schedules.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDoses: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-1',
    role: 'patient',
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } },
  }),
}))

vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({ data: null, isPending: false, error: null }),
}))

const { MedicationForm } = await import('@/features/medications/components/medication-form')
const { EditInstructionsAction, INSTRUCTIONS_MAX } = await import(
  '@/features/medications/components/medication-instructions'
)
const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)

function schedule(id: string, name: string, instructions: string | null) {
  return {
    medication_schedule_id: id,
    prescription_id: 'rx-1',
    medication_schedule_name: name,
    medication_schedule_dosage: '500mg',
    medication_schedule_frequency: 1,
    medication_schedule_times: ['08:00:00'],
    medication_schedule_start_date: '2026-09-01',
    medication_schedule_end_date: null,
    medication_schedule_created_at: '2026-09-01T00:00:00Z',
    medication_schedule_instructions: instructions,
    prescription: {
      prescription_id: 'rx-1',
      prescription_issued_date: '2026-09-01',
      prescription_notes: 'General note for the whole prescription.',
    },
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
  created.prescription.mutate.mockReset()
  created.schedule.mutate.mockReset()
  updated.mutate.mockReset()
  updated.isPending = false
  updated.isError = false
  updated.error = null
})

const typeInto = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('the medication form', () => {
  function renderForm() {
    render(<MedicationForm patientId="pat-1" doctorId="doc-1" prescriptionId="presc-1" />)
    typeInto(/medicine/i, 'Amoxicillin')
    typeInto(/dosage/i, '500 mg')
  }
  const save = () => fireEvent.click(screen.getByRole('button', { name: /add medicine/i }))
  const saved = () => created.schedule.mutate.mock.calls[0]![0]

  it('saves the instructions typed for the medicine, trimmed', () => {
    renderForm()
    typeInto(/^instructions/i, '  Take after meals.  ')
    save()

    expect(saved()).toMatchObject({ name: 'Amoxicillin', instructions: 'Take after meals.' })
  })

  it('saves a medicine with no instructions, as none', () => {
    renderForm()
    save()

    expect(created.schedule.mutate).toHaveBeenCalledTimes(1)
    expect(saved()).toMatchObject({ instructions: null })
  })

  it('treats instructions of only spaces as none', () => {
    renderForm()
    typeInto(/^instructions/i, '   ')
    save()

    expect(saved()).toMatchObject({ instructions: null })
  })

  it('counts the characters against the limit', () => {
    renderForm()
    expect(screen.getByText(`0 / ${INSTRUCTIONS_MAX}`)).toBeInTheDocument()

    typeInto(/^instructions/i, 'Take after meals.')
    expect(screen.getByText(`17 / ${INSTRUCTIONS_MAX}`)).toBeInTheDocument()
  })

  it('stops typing at 500 characters, and refuses a longer text that got in', () => {
    renderForm()
    expect(INSTRUCTIONS_MAX).toBe(500)
    expect(screen.getByLabelText(/^instructions/i)).toHaveAttribute('maxlength', '500')

    typeInto(/^instructions/i, 'a'.repeat(501))
    save()

    expect(created.schedule.mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/at most 500 characters/i)).toBeInTheDocument()
  })

  it('has no placeholder that could be read as an instruction to follow', () => {
    renderForm()
    expect(screen.getByLabelText(/^instructions/i)).not.toHaveAttribute('placeholder')
  })
})

describe('changing a prescribed medicine’s instructions', () => {
  const open = (instructions: string | null) => {
    render(
      <EditInstructionsAction
        patientId="p-1"
        schedule={schedule('ms-1', 'Amoxicillin', instructions)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /instructions: Amoxicillin/ }))
    return within(screen.getByRole('dialog'))
  }

  it('offers to add them when there are none, and to edit them when there are', () => {
    const { unmount } = render(
      <EditInstructionsAction patientId="p-1" schedule={schedule('ms-1', 'Amoxicillin', null)} />,
    )
    expect(screen.getByRole('button', { name: 'Add instructions: Amoxicillin' })).toBeInTheDocument()
    unmount()

    render(
      <EditInstructionsAction
        patientId="p-1"
        schedule={schedule('ms-1', 'Amoxicillin', 'Take after meals.')}
      />,
    )
    expect(screen.getByRole('button', { name: 'Edit instructions: Amoxicillin' })).toBeInTheDocument()
  })

  it('starts from what is saved and sends nothing until saved', () => {
    const dialog = open('Take after meals.')

    expect(dialog.getByLabelText(/^instructions/i)).toHaveValue('Take after meals.')
    expect(updated.mutate).not.toHaveBeenCalled()
  })

  it('saves the new text for that medicine, trimmed', () => {
    const dialog = open('Take after meals.')
    fireEvent.change(dialog.getByLabelText(/^instructions/i), {
      target: { value: ' Take before meals. ' },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Save instructions' }))

    expect(updated.mutate).toHaveBeenCalledWith(
      { scheduleId: 'ms-1', instructions: 'Take before meals.' },
      expect.anything(),
    )
  })

  it('clears them when the text is emptied', () => {
    const dialog = open('Take after meals.')
    fireEvent.change(dialog.getByLabelText(/^instructions/i), { target: { value: '' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save instructions' }))

    expect(updated.mutate).toHaveBeenCalledWith(
      { scheduleId: 'ms-1', instructions: null },
      expect.anything(),
    )
  })

  it('refuses more than 500 characters', () => {
    const dialog = open(null)
    fireEvent.change(dialog.getByLabelText(/^instructions/i), {
      target: { value: 'a'.repeat(501) },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Save instructions' }))

    expect(updated.mutate).not.toHaveBeenCalled()
    expect(dialog.getByText(/at most 500 characters/i)).toBeInTheDocument()
  })

  it('says it is saving while the save is on its way', () => {
    updated.isPending = true
    const dialog = open('Take after meals.')

    // The house button stays focusable while busy, and says so.
    expect(dialog.getByRole('button', { name: /saving/i })).toHaveAttribute('aria-busy', 'true')
  })

  it('says so when the save fails, and stays open', () => {
    updated.isError = true
    updated.error = new Error('network')
    const dialog = open('Take after meals.')

    expect(dialog.getByText('The instructions were not saved')).toBeInTheDocument()
  })

  it('closes and confirms once saved', () => {
    updated.mutate.mockImplementation((_input, options) => options.onSuccess())
    const dialog = open('Take after meals.')
    fireEvent.click(dialog.getByRole('button', { name: 'Save instructions' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Instructions saved.')
  })

  it('changes nothing when cancelled', () => {
    const dialog = open('Take after meals.')
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(updated.mutate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the patient’s medications page', () => {
  const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement

  it('shows each medicine’s instructions under that medicine only', () => {
    schedules.data = [
      schedule('ms-1', 'Amoxicillin', 'Take after meals.'),
      schedule('ms-2', 'Paracetamol', 'Take with a full glass of water.'),
    ]
    render(<PatientMedicationsPage />)

    expect(within(row('Amoxicillin')).getByText('Take after meals.')).toBeInTheDocument()
    expect(within(row('Amoxicillin')).queryByText(/full glass of water/)).not.toBeInTheDocument()
    expect(
      within(row('Paracetamol')).getByText('Take with a full glass of water.'),
    ).toBeInTheDocument()
  })

  it('shows no instructions section for a medicine that has none', () => {
    schedules.data = [
      schedule('ms-1', 'Amoxicillin', 'Take after meals.'),
      schedule('ms-2', 'Paracetamol', null),
    ]
    render(<PatientMedicationsPage />)

    expect(within(row('Amoxicillin')).getByText('Instructions')).toBeInTheDocument()
    expect(within(row('Paracetamol')).queryByText('Instructions')).not.toBeInTheDocument()
  })

  it('gives the patient no way to change them', () => {
    schedules.data = [schedule('ms-1', 'Amoxicillin', 'Take after meals.')]
    render(<PatientMedicationsPage />)

    expect(screen.queryByRole('button', { name: /instructions/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^instructions/i)).not.toBeInTheDocument()
  })
})
