import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 4.9, "Configure Medication Reminder Preferences".
 *
 * The patient's two reminder choices - whether to be reminded at all, and the
 * earliest time of day a reminder may come - are saved from their profile.
 * What the reminder jobs then do with them is covered against the database
 * (`tests/db/medication-reminders.test.ts`,
 * `tests/db/medication-pre-dose-reminders.test.ts`), and who may write them in
 * `tests/db/reminder-preferences.test.ts`. What is covered here is that the
 * choice on screen is the choice saved, and that the patient is told whether
 * it was.
 */

const api = vi.hoisted(() => ({
  updatePatient: vi.fn(),
  fetchMyDoctor: vi.fn(),
}))
const refresh = vi.hoisted(() => vi.fn())

const PATIENT = {
  pat_id: 'p-alice',
  user_id: 'u-alice',
  doc_id: 'd-alan',
  pat_first_name: 'Alice',
  pat_last_name: 'Santos',
  pat_birth_date: null,
  pat_contact_no: '0917 000 9999',
  pat_address: null,
  pat_status: 'active',
  pat_reminder_is_enabled: true,
  pat_reminder_preferred_time: null as string | null,
}

let patient = { ...PATIENT }

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  updatePatient: api.updatePatient,
  fetchMyDoctor: api.fetchMyDoctor,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: patient.user_id,
    role: 'patient',
    email: 'patient@example.test',
    profile: { kind: 'patient', patient },
  }),
  useAuth: () => ({ refresh }),
}))

const { PatientProfilePage } = await import(
  '@/features/patients/pages/patient-profile-page'
)

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <PatientProfilePage />
    </QueryClientProvider>,
  )
}

const remindersBox = () =>
  screen.getByRole('checkbox', { name: /send me medication reminders/i })
const timeInput = () => screen.getByLabelText('Preferred reminder time')

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  })
}

/** The reminder half of what was sent, the rest being contact details. */
const sentReminders = () => {
  const [patientId, changes] = api.updatePatient.mock.calls.at(-1) ?? []
  return {
    patientId,
    enabled: changes?.pat_reminder_is_enabled,
    time: changes?.pat_reminder_preferred_time,
  }
}

beforeEach(() => {
  patient = { ...PATIENT }
  refresh.mockReset()
  api.updatePatient.mockReset()
  api.updatePatient.mockImplementation(async (_id: string, changes: object) => ({
    ...patient,
    ...changes,
  }))
  api.fetchMyDoctor.mockReset()
  api.fetchMyDoctor.mockResolvedValue({
    doc_first_name: 'Alan',
    doc_last_name: 'Cruz',
    doc_specialization: null,
    doc_contact_no: null,
  })
})

describe('the patient’s reminder preferences', () => {
  it('shows what is stored: reminders on, and no earliest time', () => {
    renderPage()

    expect(remindersBox()).toBeChecked()
    expect(timeInput()).toHaveValue('')
    expect(timeInput()).toBeEnabled()
  })

  it('shows a stored earliest time, and a stored choice not to be reminded', () => {
    patient = {
      ...PATIENT,
      pat_reminder_is_enabled: false,
      pat_reminder_preferred_time: '07:30:00',
    }
    renderPage()

    expect(remindersBox()).not.toBeChecked()
    expect(timeInput()).toHaveValue('07:30')
    // A time means nothing while reminders are off.
    expect(timeInput()).toBeDisabled()
  })

  it('says what the time does: nothing is sent before it, and empty means every dose', () => {
    renderPage()

    expect(timeInput()).toHaveAccessibleDescription(
      'No medication reminder is sent before this time of day. Leave it empty to be reminded about every dose.',
    )
  })

  it('saves reminders turned off, for this patient, and says it was saved', async () => {
    renderPage()

    fireEvent.click(remindersBox())
    await save()

    expect(api.updatePatient).toHaveBeenCalledTimes(1)
    expect(sentReminders()).toEqual({ patientId: 'p-alice', enabled: false, time: null })
    expect(screen.getByRole('status')).toHaveTextContent('Your details have been saved.')
    // The signed-in profile is reloaded, so the form starts from what is stored.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('saves an earliest time as a time of day, and an emptied one as none', async () => {
    renderPage()

    fireEvent.change(timeInput(), { target: { value: '07:30' } })
    await save()
    expect(sentReminders()).toEqual({ patientId: 'p-alice', enabled: true, time: '07:30:00' })

    fireEvent.change(timeInput(), { target: { value: '' } })
    await save()
    expect(sentReminders()).toEqual({ patientId: 'p-alice', enabled: true, time: null })
  })

  it('says the details were not saved when the save fails, and claims nothing was', async () => {
    // A failure that is neither a lost connection nor a refusal, each of
    // which FormError words differently (`tests/unit/error-presentation.test.ts`).
    api.updatePatient.mockRejectedValue(new Error('The update could not be completed.'))
    renderPage()

    fireEvent.click(remindersBox())
    await save()

    expect(await screen.findByText('Your details were not saved')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(refresh).not.toHaveBeenCalled()
    // What they chose stays on screen, so they can try again.
    expect(remindersBox()).not.toBeChecked()
  })

  it('offers to discard an unsaved change, and restores what is stored', async () => {
    renderPage()

    fireEvent.click(remindersBox())
    fireEvent.change(timeInput(), { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(remindersBox()).toBeChecked()
    expect(timeInput()).toHaveValue('')
    expect(api.updatePatient).not.toHaveBeenCalled()
  })
})
