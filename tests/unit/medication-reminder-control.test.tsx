import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The doctor's reminder switch on each medicine (migration 59).
 *
 * The doctor turns reminders off or on for one medicine; the patient sees
 * when they are off and cannot change it. The dose checklist is untouched.
 */

type Mutation = {
  mutate: ReturnType<typeof vi.fn>
  isPending: boolean
  isError: boolean
  error: unknown
}

const setReminders = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
})) as Mutation
const setDose = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, variables: undefined }))
const page = vi.hoisted(() => ({ schedules: [] as unknown[], doses: [] as unknown[] }))

vi.mock('@/features/medications/hooks', () => ({
  useSetMedicationReminders: () => setReminders,
  useUpdateMedicationInstructions: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMedicationConflicts: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useEndMedicationSchedule: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMedicationSchedules: () => ({
    data: page.schedules,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDoses: () => ({ data: page.doses, isPending: false, error: null, refetch: vi.fn() }),
  useSetDoseStatus: () => setDose,
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

const { MedicationReminderSwitch } = await import(
  '@/features/medications/components/medication-reminder-control'
)
const { PatientMedicationsPage } = await import(
  '@/features/medications/pages/patient-medications-page'
)

function schedule(id: string, name: string, remindersOn: boolean | undefined) {
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
    medication_schedule_instructions: null,
    ...(remindersOn === undefined ? {} : { medication_schedule_reminders_is_enabled: remindersOn }),
    medication_schedule_reminders_enabled_at: null,
    prescription: {
      prescription_id: 'rx-1',
      prescription_issued_date: '2026-09-01',
      prescription_notes: null,
    },
  }
}

beforeEach(() => {
  setReminders.mutate.mockReset()
  setReminders.isPending = false
  setReminders.isError = false
  setReminders.error = null
  setDose.mutate.mockReset()
  page.schedules = []
  page.doses = []
})

describe('the doctor’s reminder switch', () => {
  const switchFor = (name: string) =>
    screen.getByRole('switch', { name: `Medication reminders: ${name}` })

  function renderTwo(aOn = true, bOn = true) {
    render(
      <ul>
        <li>
          <MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', aOn)} />
        </li>
        <li>
          <MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-b', 'Medicine B', bOn)} />
        </li>
      </ul>,
    )
  }

  it('shows a switch for each medicine, on unless the doctor turned it off', () => {
    renderTwo(true, false)

    expect(switchFor('Medicine A')).toHaveAttribute('aria-checked', 'true')
    expect(switchFor('Medicine B')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Medication reminders ON')).toBeInTheDocument()
    expect(screen.getByText('Medication reminders OFF')).toBeInTheDocument()
  })

  it('says it is for that medicine only and leaves the doses as they are', () => {
    render(<MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', true)} />)

    expect(screen.getByText(/this medicine only/i)).toBeInTheDocument()
    expect(screen.getByText(/doses stay/i)).toBeInTheDocument()
  })

  it('turns one medicine off, and only that one', () => {
    renderTwo()
    fireEvent.click(switchFor('Medicine A'))

    expect(setReminders.mutate).toHaveBeenCalledTimes(1)
    expect(setReminders.mutate).toHaveBeenCalledWith(
      { scheduleId: 'ms-a', enabled: false },
      expect.anything(),
    )
    expect(switchFor('Medicine B')).toHaveAttribute('aria-checked', 'true')
  })

  it('turns a medicine back on', () => {
    renderTwo(false, true)
    fireEvent.click(switchFor('Medicine A'))

    expect(setReminders.mutate).toHaveBeenCalledWith(
      { scheduleId: 'ms-a', enabled: true },
      expect.anything(),
    )
  })

  it('says it is saving, and takes no second press meanwhile', () => {
    setReminders.isPending = true
    render(<MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', true)} />)

    expect(screen.getByText('Saving…')).toBeInTheDocument()
    expect(switchFor('Medicine A')).toBeDisabled()
    fireEvent.click(switchFor('Medicine A'))
    expect(setReminders.mutate).not.toHaveBeenCalled()
  })

  it('confirms once saved', () => {
    setReminders.mutate.mockImplementation((_input, options) => options.onSuccess())
    render(<MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', true)} />)
    fireEvent.click(switchFor('Medicine A'))

    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
  })

  it('says so when the save fails, and shows the setting as it still is', () => {
    setReminders.isError = true
    setReminders.error = new Error('network')
    render(<MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', true)} />)

    expect(screen.getByText('The reminder setting was not saved')).toBeInTheDocument()
    expect(switchFor('Medicine A')).toHaveAttribute('aria-checked', 'true')
  })

  it('reads a schedule from before migration 59 as on', () => {
    render(<MedicationReminderSwitch patientId="p-1" schedule={schedule('ms-a', 'Medicine A', undefined)} />)

    expect(switchFor('Medicine A')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('the patient’s medications page', () => {
  const OFF = 'Medication reminders are turned off by your doctor.'
  const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement

  it('says under a medicine that its reminders are off, and nothing under one that has them on', () => {
    page.schedules = [schedule('ms-a', 'Medicine A', false), schedule('ms-b', 'Medicine B', true)]
    render(<PatientMedicationsPage />)

    expect(within(row('Medicine A')).getByText(OFF)).toBeInTheDocument()
    expect(within(row('Medicine B')).queryByText(OFF)).not.toBeInTheDocument()
  })

  it('still lists the medicine and its times', () => {
    page.schedules = [schedule('ms-a', 'Medicine A', false)]
    render(<PatientMedicationsPage />)

    expect(within(row('Medicine A')).getByText(/1 time a day at/)).toBeInTheDocument()
  })

  it('gives the patient no switch', () => {
    page.schedules = [schedule('ms-a', 'Medicine A', false)]
    render(<PatientMedicationsPage />)

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('keeps today’s dose on the checklist, and recordable, with reminders off', () => {
    page.schedules = [schedule('ms-a', 'Medicine A', false)]
    page.doses = [
      {
        medication_log_id: 'dose-1',
        medication_schedule_id: 'ms-a',
        // Due earlier today, so "Mark as taken" is offered.
        medication_log_scheduled_at: new Date(new Date().setHours(0, 1, 0, 0)).toISOString(),
        medication_log_status: 'pending',
        medication_log_taken_at: null,
        medication_schedule: {
          medication_schedule_id: 'ms-a',
          medication_schedule_name: 'Medicine A',
          medication_schedule_dosage: '500mg',
          // What the calendar file is filtered on; the checklist ignores it.
          medication_schedule_reminders_is_enabled: false,
        },
      },
    ]
    render(<PatientMedicationsPage />)

    const take = screen.getAllByRole('button', { name: /taken/i })[0]!
    fireEvent.click(take)
    expect(setDose.mutate).toHaveBeenCalledWith({ doseId: 'dose-1', status: 'taken' })
  })
})
