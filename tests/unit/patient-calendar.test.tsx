import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 6.2 "View Appointment Calendar" on screen: the patient's month and
 * the chosen day, the keyboard moving through it, every day saying what it
 * holds in words, and the states around it. The data is the patient's own
 * records, mocked at the API; what each record means is pinned in
 * `calendar-model.test.ts`.
 */

const api = vi.hoisted(() => ({
  doses: vi.fn(),
  appointments: vi.fn(),
  logs: vi.fn(),
  zone: vi.fn(),
  schedules: [] as unknown[],
  user: {} as Record<string, unknown>,
  doctorAppointments: [] as unknown[],
}))

vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: api.doses,
}))
vi.mock('@/features/appointments/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/appointments/api')>()),
  fetchAppointments: api.appointments,
}))
vi.mock('@/features/recovery-logs/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-logs/api')>()),
  fetchRecoveryLogsBetween: api.logs,
}))
vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchOwnClinicTimeZone: api.zone,
}))
vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({
    data: {
      doc_id: 'd-alan',
      doc_first_name: 'Alan',
      doc_last_name: 'Cruz',
      doc_specialization: null,
      doc_license_no: 'LIC-A-001',
      doc_contact_no: null,
    },
    isLoading: false,
  }),
}))
vi.mock('@/features/medications/hooks', () => ({
  useMedicationSchedules: () => ({ data: api.schedules }),
}))
vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => api.user,
}))

const { PatientCalendarPage } = await import('@/features/calendar/pages/patient-calendar-page')
const { DoctorCalendarPage } = await import('@/features/calendar/pages/doctor-calendar-page')

const PATIENT_USER = {
  userId: 'u-alice',
  role: 'patient',
  profile: {
    kind: 'patient',
    patient: { pat_id: 'p-alice', doc_id: 'd-alan', pat_first_name: 'Alice', pat_last_name: 'Santos' },
  },
}

const DOCTOR_USER = {
  userId: 'u-alan',
  role: 'doctor',
  profile: { kind: 'doctor', doctor: { doc_id: 'd-alan' } },
}

// 10:00 on Wednesday 4 November 2026 in Manila.
const NOW = new Date('2026-11-04T02:00:00Z')

const AMOXICILLIN = {
  medication_schedule_id: 'ms-1',
  medication_schedule_name: 'Amoxicillin',
  medication_schedule_dosage: '500 mg',
}

const DOSES = [
  {
    medication_log_id: 'taken-today',
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: '2026-11-04T00:00:00Z',
    medication_log_taken_at: '2026-11-04T00:12:00Z',
    medication_log_status: 'taken',
    medication_schedule: AMOXICILLIN,
  },
  {
    medication_log_id: 'later-today',
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: '2026-11-04T12:00:00Z',
    medication_log_taken_at: null,
    medication_log_status: 'pending',
    medication_schedule: AMOXICILLIN,
  },
]

const APPOINTMENTS = [
  {
    appointment_id: 'appt-5th',
    pat_id: 'p-alice',
    doc_id: 'd-alan',
    appointment_date: '2026-11-05T06:00:00Z',
    appointment_status: 'confirmed',
    patient: { pat_id: 'p-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' },
  },
]

const LOGS = [
  {
    recovery_log_id: 'rl-today',
    pat_id: 'p-alice',
    recovery_log_date: '2026-11-04',
    recovery_log_notes: null,
    recovery_log_mood_rating: 4,
  },
]

function renderWith(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const day = (name: RegExp) => screen.getByRole('button', { name })
const agenda = () => screen.getByRole('region', { name: /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) / })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  api.user = PATIENT_USER
  api.doses.mockReset().mockResolvedValue(DOSES)
  api.appointments.mockReset().mockResolvedValue(APPOINTMENTS)
  api.logs.mockReset().mockResolvedValue(LOGS)
  api.zone.mockReset().mockResolvedValue('Asia/Manila')
  api.schedules = [{ medication_schedule_end_date: null }]
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the patient’s calendar', () => {
  it('opens on this month, with today chosen and today’s records in full', async () => {
    renderWith(<PatientCalendarPage />)

    expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeInTheDocument()
    const today = day(/^Wednesday 4 November 2026, today:/)
    expect(today).toHaveAttribute('aria-current', 'date')
    expect(today).toHaveAccessibleName(
      'Wednesday 4 November 2026, today: 2 medicine doses, 1 mood check-in',
    )

    const panel = agenda()
    expect(within(panel).getByRole('heading', { name: /Wednesday 4 November 2026/ })).toBeInTheDocument()
    // The check-in first; then the dose taken - with when it was actually
    // taken - and the one still to come, which is only scheduled.
    const items = within(panel).getAllByRole('listitem').map((item) => item.textContent)
    expect(items[0]).toContain('Mood check-in')
    expect(items[0]).toContain('Good (4 of 5)')
    expect(items[0]).toContain('Recorded for the day')
    expect(items[1]).toContain('08:00')
    expect(items[1]).toContain('Amoxicillin, 500 mg')
    expect(items[1]).toContain('Taken at 08:12')
    expect(items[2]).toContain('20:00')
    expect(items[2]).toContain('Amoxicillin, 500 mg')
    expect(items[2]).toContain('Scheduled')
  })

  it('reads the month on screen, from the patient’s own records only', async () => {
    renderWith(<PatientCalendarPage />)
    await screen.findByRole('grid', { name: 'November 2026' })

    expect(api.doses).toHaveBeenCalledWith({
      patientId: 'p-alice',
      from: '2026-10-31T00:00:00.000Z',
      to: '2026-12-07T00:00:00.000Z',
    })
    expect(api.appointments).toHaveBeenCalledWith('p-alice')
    expect(api.logs).toHaveBeenCalledWith('p-alice', '2026-11-01', '2026-12-05')
  })

  it('moves a day with the arrow keys, the chosen day and the focus together', async () => {
    renderWith(<PatientCalendarPage />)
    const today = await screen.findByRole('button', { name: /^Wednesday 4 November 2026, today/ })
    today.focus()

    fireEvent.keyDown(today, { key: 'ArrowRight' })

    const thursday = day(/^Thursday 5 November 2026:/)
    await waitFor(() => expect(thursday).toHaveFocus())
    expect(thursday).toHaveAttribute('tabindex', '0')
    expect(today).toHaveAttribute('tabindex', '-1')
    expect(thursday.closest('[role="gridcell"]')).toHaveAttribute('aria-selected', 'true')
    const panel = agenda()
    expect(panel).toHaveTextContent('14:00Appointment')
    expect(panel).toHaveTextContent('With Dr. Alan Cruz')
    expect(panel).toHaveTextContent('Confirmed')
  })

  it('goes a week with the up and down arrows, and a month with Page Down', async () => {
    renderWith(<PatientCalendarPage />)
    const today = await screen.findByRole('button', { name: /^Wednesday 4 November 2026, today/ })
    today.focus()

    fireEvent.keyDown(today, { key: 'ArrowDown' })
    await waitFor(() => expect(day(/^Wednesday 11 November 2026:/)).toHaveFocus())

    fireEvent.keyDown(day(/^Wednesday 11 November 2026:/), { key: 'PageDown' })
    expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeInTheDocument()
    await waitFor(() => expect(day(/^Friday 11 December 2026:/)).toHaveFocus())
  })

  it('changes month with its buttons, starting the month on its first day', async () => {
    renderWith(<PatientCalendarPage />)
    await screen.findByRole('grid', { name: 'November 2026' })

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(await screen.findByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
    expect(agenda()).toHaveAccessibleName(/^Thursday 1 October 2026/)

    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeInTheDocument()
    expect(agenda()).toHaveAccessibleName(/^Wednesday 4 November 2026/)
  })

  it('says a day with no record has nothing, rather than inventing a check-in', async () => {
    renderWith(<PatientCalendarPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Monday 2 November 2026:/ }))

    expect(day(/^Monday 2 November 2026:/)).toHaveAccessibleName(
      'Monday 2 November 2026: Nothing recorded',
    )
    expect(agenda()).toHaveTextContent('Nothing on this day.')
    expect(agenda()).not.toHaveTextContent('Mood check-in')
  })

  it('says why a day past the furthest dose slot shows no doses', async () => {
    renderWith(<PatientCalendarPage />)
    await screen.findByRole('grid', { name: 'November 2026' })
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    await screen.findByRole('grid', { name: 'December 2026' })
    fireEvent.click(day(/^Saturday 12 December 2026:/))

    expect(agenda()).toHaveTextContent(
      'Doses are added to your calendar 30 days ahead, so none show for this day yet.',
    )
  })

  it('says so when a record could not be read, and tries again', async () => {
    api.appointments.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderWith(<PatientCalendarPage />)

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }))

    expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeInTheDocument()
    expect(api.appointments).toHaveBeenCalledTimes(2)
  })

  it('says whose clock the times are on when this device keeps another', async () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone
    renderWith(<PatientCalendarPage />)
    await screen.findByRole('grid', { name: 'November 2026' })

    if (device === 'Asia/Manila') {
      expect(screen.queryByText(/time zone/)).not.toBeInTheDocument()
    } else {
      expect(
        screen.getByText(/Times are shown in your clinic’s time zone \(Asia\/Manila\)/),
      ).toBeInTheDocument()
    }
  })

  it('falls back to this device’s clock, and says so, when the clinic’s cannot be read', async () => {
    api.zone.mockResolvedValue(null)
    renderWith(<PatientCalendarPage />)
    await screen.findByRole('grid', { name: 'November 2026' })

    expect(screen.getByText(/Times are shown in this device’s time zone/)).toBeInTheDocument()
  })

  it('shows what each kind is in words, beside its icon', async () => {
    renderWith(<PatientCalendarPage />)
    const legend = await screen.findByRole('list', { name: 'What the calendar shows' })
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Medicine',
      'Appointment',
      'Mood check-in',
    ])
  })
})

describe('the doctor’s calendar', () => {
  beforeEach(() => {
    api.user = DOCTOR_USER
    api.appointments.mockResolvedValue([
      ...APPOINTMENTS,
      {
        appointment_id: 'appt-other-doctor',
        pat_id: 'p-bea',
        doc_id: 'd-other',
        appointment_date: '2026-11-05T02:00:00Z',
        appointment_status: 'scheduled',
        patient: { pat_id: 'p-bea', pat_first_name: 'Bea', pat_last_name: 'Reyes' },
      },
    ])
  })

  it('shows the doctor’s own appointments, with whom, linked to the patient’s record', async () => {
    renderWith(<DoctorCalendarPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Thursday 5 November 2026:/ }))

    expect(day(/^Thursday 5 November 2026:/)).toHaveAccessibleName(
      'Thursday 5 November 2026: 1 appointment',
    )
    const panel = agenda()
    expect(panel).toHaveTextContent('With Alice Santos')
    expect(panel).not.toHaveTextContent('Bea Reyes')
    expect(within(panel).getByRole('link', { name: 'Open patient record' })).toHaveAttribute(
      'href',
      '/doctor/patients/p-alice',
    )
    expect(screen.getByRole('link', { name: 'Manage appointments' })).toHaveAttribute(
      'href',
      '/doctor/appointments',
    )
    // A doctor's calendar reads appointments only: no patient's doses or check-ins.
    expect(api.doses).not.toHaveBeenCalled()
    expect(api.logs).not.toHaveBeenCalled()
  })
})
