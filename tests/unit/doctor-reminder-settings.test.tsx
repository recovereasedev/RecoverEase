import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 7.3 "Configure Reminder Settings", the doctor's own (migration 42).
 *
 * The doctor turns their appointment reminders off or on from their profile.
 * Who may write it, and what the reminder job then does with it, is covered
 * against the database (`tests/db/doctor-reminder-setting.test.ts`). What is
 * covered here is that the choice on screen is the choice saved, that it is
 * saved on its own - never with the profile form's fields, nor they with it -
 * and that the doctor is told whether it was.
 */

const api = vi.hoisted(() => ({ updateDoctor: vi.fn() }))
const refresh = vi.hoisted(() => vi.fn())

const DOCTOR = {
  doc_id: 'd-alan',
  user_id: 'u-alan',
  clinic_id: 'c-harborview',
  doc_first_name: 'Alan',
  doc_last_name: 'Cruz',
  doc_specialization: 'Orthopaedic rehabilitation',
  doc_license_no: 'LIC-A-001',
  doc_contact_no: '0917 000 1111',
  doc_is_active: true,
  doc_appointment_reminder_is_enabled: true as boolean | undefined,
}

let doctor = { ...DOCTOR }

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  updateDoctor: api.updateDoctor,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: doctor.user_id,
    role: 'doctor',
    email: 'doctor@example.test',
    profile: { kind: 'doctor', doctor },
  }),
  useAuth: () => ({ refresh }),
}))

const { DoctorProfilePage } = await import(
  '@/features/patients/pages/doctor-profile-page'
)

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <DoctorProfilePage />
    </QueryClientProvider>,
  )
}

const section = () =>
  screen.getByRole('region', { name: 'Reminder settings' })
const reminderBox = () =>
  within(section()).getByRole('checkbox', {
    name: /send me a reminder the day before each appointment/i,
  })

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

beforeEach(() => {
  doctor = { ...DOCTOR }
  refresh.mockReset()
  api.updateDoctor.mockReset()
  api.updateDoctor.mockImplementation(async (_id: string, changes: object) => ({
    ...doctor,
    ...changes,
  }))
})

describe('the doctor’s appointment reminder setting', () => {
  it('shows what is stored: on', () => {
    renderPage()
    expect(reminderBox()).toBeChecked()
  })

  it('shows a stored choice to be left out', () => {
    doctor = { ...DOCTOR, doc_appointment_reminder_is_enabled: false }
    renderPage()
    expect(reminderBox()).not.toBeChecked()
  })

  it('reads as on when the setting is not there at all, as the column’s default is', () => {
    doctor = { ...DOCTOR, doc_appointment_reminder_is_enabled: undefined }
    renderPage()
    expect(reminderBox()).toBeChecked()
  })

  it('says the patients are still reminded', () => {
    renderPage()
    expect(section()).toHaveTextContent(
      'Turning this off stops that notification only. Your appointments still appear in RecoverEase, and your patients are still reminded.',
    )
  })

  it('saves it turned off, for this doctor, alone, and says so', async () => {
    renderPage()

    fireEvent.click(reminderBox())
    await click('Save reminder settings')

    expect(api.updateDoctor).toHaveBeenCalledTimes(1)
    expect(api.updateDoctor).toHaveBeenCalledWith('d-alan', {
      doc_appointment_reminder_is_enabled: false,
    })
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'Appointment reminders are off.',
    )
    // The signed-in profile is reloaded, so the page starts from what is stored.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('saves it turned back on', async () => {
    doctor = { ...DOCTOR, doc_appointment_reminder_is_enabled: false }
    renderPage()

    fireEvent.click(reminderBox())
    await click('Save reminder settings')

    expect(api.updateDoctor).toHaveBeenCalledWith('d-alan', {
      doc_appointment_reminder_is_enabled: true,
    })
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'Appointment reminders are on.',
    )
  })

  it('is not sent with the profile’s details, however the box is left', async () => {
    renderPage()

    fireEvent.click(reminderBox())
    await click('Save changes')

    expect(api.updateDoctor).toHaveBeenCalledTimes(1)
    const [, changes] = api.updateDoctor.mock.calls[0]!
    expect(changes).not.toHaveProperty('doc_appointment_reminder_is_enabled')
    expect(within(section()).getByRole('status')).toBeEmptyDOMElement()
  })

  it('says it was not saved when the save fails, and keeps the choice on screen', async () => {
    api.updateDoctor.mockRejectedValue(new Error('the server said no'))
    renderPage()

    fireEvent.click(reminderBox())
    await click('Save reminder settings')

    expect(within(section()).getByText('Your reminder settings were not saved')).toBeInTheDocument()
    expect(within(section()).getByRole('status')).toBeEmptyDOMElement()
    expect(reminderBox()).not.toBeChecked()
    expect(refresh).not.toHaveBeenCalled()
  })
})
