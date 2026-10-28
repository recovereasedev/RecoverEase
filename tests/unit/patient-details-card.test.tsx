import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 2.5 "Update Patient Information" on the doctor's patient record:
 * the details panel, its Edit, what is sent - only the six details, never
 * the doctor, status or sign-in - and what the doctor is told.
 */

const api = vi.hoisted(() => ({ updatePatient: vi.fn() }))
vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  updatePatient: api.updatePatient,
}))
vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({ userId: 'u-alan', role: 'doctor' }),
}))

const { PatientDetailsCard } = await import('@/features/patients/components/patient-details-card')

const ALICE = {
  pat_id: 'p-alice',
  user_id: 'u-alice',
  doc_id: 'd-alan',
  pat_first_name: 'Alice',
  pat_last_name: 'Santos',
  pat_birth_date: '1991-04-02',
  pat_gender: 'Female',
  pat_contact_no: null,
  pat_address: null,
  pat_consent_at: '2026-09-02T00:00:00Z',
  pat_created_at: '2026-09-01T00:00:00Z',
  pat_status: 'active',
  pat_reminder_preferred_time: null,
  pat_reminder_is_enabled: true,
} as const

function renderCard() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PatientDetailsCard patient={{ ...ALICE }} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.updatePatient.mockReset().mockImplementation(async (_id: string, changes: object) => ({ ...ALICE, ...changes }))
})

describe('the patient’s details on the doctor’s record', () => {
  it('shows what is recorded, and "Not recorded" for what is not', () => {
    renderCard()
    expect(screen.getByRole('heading', { name: 'Patient details' })).toBeInTheDocument()
    expect(screen.getByText('Female')).toBeInTheDocument()
    expect(screen.getAllByText('Not recorded')).toHaveLength(2)
  })

  it('saves the six details - and nothing else - for this patient, and says so', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    const form = screen.getByRole('form', { name: 'Edit patient details' })
    expect(within(form).getByLabelText(/First name/)).toHaveValue('Alice')

    fireEvent.change(within(form).getByLabelText('Contact number'), { target: { value: '0917 555 0101' } })
    fireEvent.change(within(form).getByLabelText('Address'), { target: { value: ' 12 Mabini St ' } })
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save details' }))
    })

    expect(api.updatePatient).toHaveBeenCalledWith('p-alice', {
      pat_first_name: 'Alice',
      pat_last_name: 'Santos',
      pat_birth_date: '1991-04-02',
      pat_gender: 'Female',
      pat_contact_no: '0917 555 0101',
      pat_address: '12 Mabini St',
    })
    expect(await screen.findByText('The patient’s details are saved.')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Edit patient details' })).not.toBeInTheDocument()
  })

  it('asks for a name, and refuses a date of birth in the future, sending nothing', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    const form = screen.getByRole('form', { name: 'Edit patient details' })
    fireEvent.change(within(form).getByLabelText(/First name/), { target: { value: '  ' } })
    fireEvent.change(within(form).getByLabelText('Date of birth'), { target: { value: '2999-01-01' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save details' }))

    expect(screen.getByText('Enter their first name.')).toBeInTheDocument()
    expect(screen.getByText('A date of birth cannot be in the future.')).toBeInTheDocument()
    expect(api.updatePatient).not.toHaveBeenCalled()
  })

  it('says the details were not saved when the save fails, keeping what was typed', async () => {
    api.updatePatient.mockRejectedValue(new Error('the server said no'))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    const form = screen.getByRole('form', { name: 'Edit patient details' })
    fireEvent.change(within(form).getByLabelText('Address'), { target: { value: '12 Mabini St' } })
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save details' }))
    })

    expect(await screen.findByText('The patient’s details were not saved')).toBeInTheDocument()
    expect(within(form).getByLabelText('Address')).toHaveValue('12 Mabini St')
  })

  it('cancels without sending anything', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument()
    expect(api.updatePatient).not.toHaveBeenCalled()
  })
})
