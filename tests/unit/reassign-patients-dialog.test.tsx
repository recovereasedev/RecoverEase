import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Doctor } from '@/features/patients/api'

/**
 * Decision D8's dialog: handing a deactivated doctor's patients to an active
 * doctor in the same clinic.
 *
 * The administrator learns how many patients, never who. Everything else here
 * is the ordinary contract of a form in this app: checked on submit, the
 * problem said beside its field with focus taken there, a failure explained,
 * and focus kept inside the dialog when the button pressed goes away.
 */

const api = vi.hoisted(() => ({
  fetchDoctorPatientCount: vi.fn(),
  reassignDoctorPatients: vi.fn(),
}))

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  ...api,
}))

const { ReassignPatientsDialog } = await import(
  '@/features/patients/components/reassign-patients-dialog'
)

function doctor(id: string, first: string, last: string, active: boolean): Doctor {
  return {
    doc_id: id,
    user_id: `u-${id}`,
    clinic_id: 'c-1',
    doc_first_name: first,
    doc_last_name: last,
    doc_specialization: null,
    doc_license_no: `LIC-${id}`,
    doc_contact_no: null,
    doc_is_active: active,
    doc_created_at: '2026-01-01T00:00:00Z',
  }
}

const DEACTIVATED = doctor('d-c', 'Cay', 'Tan', false)
const DOCTORS = [
  doctor('d-a', 'Alan', 'Cruz', true),
  doctor('d-b', 'Bea', 'Lim', true),
  DEACTIVATED,
  doctor('d-x', 'Xen', 'Ong', false),
]

function renderDialog(doctors: Doctor[] = DOCTORS) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ReassignPatientsDialog
        isOpen
        onClose={onClose}
        from={{ doctorId: 'd-c', name: 'Dr Cay Tan' }}
        doctors={doctors}
      />
    </QueryClientProvider>,
  )
  return { onClose }
}

const dialog = () => screen.getByRole('dialog', { name: /reassign patients/i })
const moveButton = () => within(dialog()).getByRole('button', { name: /^Move \d+ patients?$/ })
const newDoctor = () => within(dialog()).getByRole('combobox', { name: /new doctor/i })

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  api.fetchDoctorPatientCount.mockReset()
  api.reassignDoctorPatients.mockReset()
})

describe('reassigning a deactivated doctor’s patients', () => {
  it('says how many patients, never who, and offers only active doctors', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(3)
    renderDialog()

    expect(within(dialog()).getByRole('status')).toHaveTextContent('Counting patients…')
    expect(await within(dialog()).findByText(/Dr Cay Tan has/)).toHaveTextContent(
      'Dr Cay Tan has 3 patients. Choose an active doctor in your clinic to take them over.',
    )
    expect(api.fetchDoctorPatientCount).toHaveBeenCalledWith('d-c')

    // The doctor leaving and the other deactivated doctor are not choices.
    expect(within(newDoctor()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a doctor',
      'Dr Alan Cruz',
      'Dr Bea Lim',
    ])
    expect(moveButton()).toHaveTextContent('Move 3 patients')
  })

  it('says a doctor is needed beside the field, and takes focus there, before sending anything', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(2)
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Move 2 patients' }))

    expect(
      within(dialog()).getByText('Choose the doctor who will take over these patients.'),
    ).toBeVisible()
    expect(newDoctor()).toHaveAttribute('aria-invalid', 'true')
    expect(newDoctor()).toHaveFocus()
    expect(api.reassignDoctorPatients).not.toHaveBeenCalled()
  })

  it('moves them with the count that was shown, then confirms and hands focus to Done', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(2)
    api.reassignDoctorPatients.mockResolvedValue(2)
    renderDialog()

    await screen.findByRole('button', { name: 'Move 2 patients' })
    fireEvent.change(newDoctor(), { target: { value: 'd-b' } })
    fireEvent.click(moveButton())

    await waitFor(() =>
      expect(api.reassignDoctorPatients).toHaveBeenCalledWith(
        { fromDoctorId: 'd-c', toDoctorId: 'd-b', expectedCount: 2 },
        expect.anything(),
      ),
    )
    const done = await screen.findByRole('button', { name: 'Done' })
    expect(screen.getByRole('dialog', { name: 'Patients reassigned' })).toBeVisible()
    expect(screen.getByText('2 patients moved to Dr Bea Lim')).toBeVisible()
    expect(done).toHaveFocus()
    expect(api.reassignDoctorPatients).toHaveBeenCalledTimes(1)
  })

  it('reports a refused move and keeps the choice, so it can be tried again', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(1)
    api.reassignDoctorPatients.mockRejectedValue(
      new Error('The number of patients has changed since it was shown. Check it and try again.'),
    )
    renderDialog()

    await screen.findByRole('button', { name: 'Move 1 patient' })
    fireEvent.change(newDoctor(), { target: { value: 'd-a' } })
    fireEvent.click(moveButton())

    expect(await within(dialog()).findByText('The patients were not moved')).toBeVisible()
    expect(
      within(dialog()).getByText(
        'The number of patients has changed since it was shown. Check it and try again.',
      ),
    ).toBeVisible()
    expect(newDoctor()).toHaveValue('d-a')
    expect(moveButton()).toBeVisible()
  })

  it('says there is nothing to move when the doctor has no patients', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(0)
    renderDialog()

    expect(
      await within(dialog()).findByText('Dr Cay Tan has no patients assigned, so there is nothing to move.'),
    ).toBeVisible()
    expect(within(dialog()).queryByRole('combobox')).toBeNull()
    expect(within(dialog()).getByRole('button', { name: 'Close' })).toBeVisible()
  })

  it('says when no active doctor can take them over', async () => {
    api.fetchDoctorPatientCount.mockResolvedValue(4)
    renderDialog([DEACTIVATED, doctor('d-x', 'Xen', 'Ong', false)])

    expect(await within(dialog()).findByText('No active doctor to take them over')).toBeVisible()
    expect(within(dialog()).queryByRole('combobox')).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: /^Move/ })).toBeNull()
  })

  it('says when the count cannot be loaded, and changes nothing', async () => {
    api.fetchDoctorPatientCount.mockRejectedValue(new Error('Could not find the function'))
    const { onClose } = renderDialog()

    expect(await within(dialog()).findByText('The patient count could not be loaded')).toBeVisible()
    expect(within(dialog()).queryByRole('button', { name: /^Move/ })).toBeNull()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(api.reassignDoctorPatients).not.toHaveBeenCalled()
  })
})
