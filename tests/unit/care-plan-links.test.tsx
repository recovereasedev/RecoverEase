import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Migration 60: a prescription and an appointment belong to one care plan.
 * The rules the screens share, and the two forms a doctor uses that create
 * one - issuing a prescription and scheduling an appointment. The database's
 * own refusals are tests/db/discharge-lifecycle-simplified.test.ts.
 */

const state = vi.hoisted(() => ({
  plans: [] as unknown[],
  prescription: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  schedule: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  appointment: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null as unknown },
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({ data: state.plans, isPending: false, error: null }),
}))
vi.mock('@/features/medications/hooks', () => ({
  useCreatePrescription: () => state.prescription,
  useCreateMedicationSchedule: () => state.schedule,
}))
vi.mock('@/features/appointments/hooks', () => ({
  useCreateAppointment: () => state.appointment,
}))
vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => ({ data: [{ pat_id: 'p-1', doc_id: 'd-1', pat_first_name: 'Alice', pat_last_name: 'Santos' }] }),
}))

const { chooseCarePlan, remindersAllowedFor } = await import('@/features/treatment-plans/api')
const { MedicationForm } = await import('@/features/medications/components/medication-form')
const { ScheduleAppointmentDialog } = await import('@/features/appointments/components/schedule-appointment-dialog')

const plan = (id: string, status: 'active' | 'discharged', title = `Plan ${id}`) => ({
  treatment_plan_id: id,
  treatment_plan_status: status,
  treatment_plan_title: title,
  treatment_plan_start_date: '2026-10-01',
})

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  state.plans = []
  state.prescription.mutate.mockReset()
  state.schedule.mutate.mockReset()
  state.appointment.mutate.mockReset()
})

describe('the rules the screens share', () => {
  const A = plan('a', 'discharged')
  const B = plan('b', 'active')

  it('lets a plan’s own status decide whether its reminders show', () => {
    expect(remindersAllowedFor('a', [A, B])).toBe(false)
    expect(remindersAllowedFor('b', [A, B])).toBe(true)
  })

  it('keeps something on no plan silent once the patient has any plan (fails closed)', () => {
    // Plan B being active says nothing about which plan it belongs to.
    expect(remindersAllowedFor(null, [A, B])).toBe(false)
    expect(remindersAllowedFor(null, [B])).toBe(false)
    expect(remindersAllowedFor(null, [A])).toBe(false)
    // A patient with no plan at all keeps reminders, as before migration 60.
    expect(remindersAllowedFor(undefined, [])).toBe(true)
  })

  it('refuses a plan that is not one of this patient’s', () => {
    expect(remindersAllowedFor('someone-elses', [A, B])).toBe(false)
    expect(remindersAllowedFor('someone-elses', [])).toBe(false)
  })

  it('picks the only active plan, asks when there are several, and uses none when there is none', () => {
    expect(chooseCarePlan([A, B], '')).toEqual({ planId: 'b', needsChoice: false })
    expect(chooseCarePlan([B, plan('c', 'active')], '')).toEqual({ planId: null, needsChoice: true })
    expect(chooseCarePlan([B, plan('c', 'active')], 'c')).toEqual({ planId: 'c', needsChoice: false })
    // A discharged plan is never a choice.
    expect(chooseCarePlan([A, B], 'a')).toEqual({ planId: 'b', needsChoice: false })
    expect(chooseCarePlan([A], '')).toEqual({ planId: null, needsChoice: false })
  })
})

describe('issuing a prescription', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText(/medicine/i), { target: { value: 'Amoxicillin' } })
    fireEvent.change(screen.getByLabelText(/dosage/i), { target: { value: '500 mg' } })
  }
  const save = () => fireEvent.click(screen.getByRole('button', { name: /add prescription/i }))

  it('asks which care plan when the patient has two active ones, and sends the choice', async () => {
    state.plans = [plan('a', 'active', 'Knee recovery'), plan('b', 'active', 'Back pain')]
    render(<MedicationForm patientId="p-1" doctorId="d-1" />)
    fill()
    save()
    expect(await screen.findByText('Choose which care plan this prescription is for.')).toBeInTheDocument()
    expect(state.prescription.mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/care plan/i), { target: { value: 'b' } })
    save()
    await waitFor(() => expect(state.prescription.mutate).toHaveBeenCalledTimes(1))
    expect(state.prescription.mutate.mock.calls[0]![0]).toEqual({ notes: null, planId: 'b' })
  })

  it('puts it on the patient’s only active plan without asking', async () => {
    state.plans = [plan('a', 'discharged'), plan('b', 'active')]
    render(<MedicationForm patientId="p-1" doctorId="d-1" />)
    expect(screen.queryByLabelText(/care plan/i)).not.toBeInTheDocument()
    fill()
    save()
    await waitFor(() => expect(state.prescription.mutate).toHaveBeenCalledTimes(1))
    expect(state.prescription.mutate.mock.calls[0]![0]).toEqual({ notes: null, planId: 'b' })
  })

  it('says no reminders will be sent while the patient’s care has ended', async () => {
    state.plans = [plan('a', 'discharged')]
    render(<MedicationForm patientId="p-1" doctorId="d-1" />)
    expect(screen.getByText(/care has ended.*no reminders/i)).toBeInTheDocument()
    fill()
    save()
    await waitFor(() => expect(state.prescription.mutate).toHaveBeenCalledTimes(1))
    expect(state.prescription.mutate.mock.calls[0]![0]).toEqual({ notes: null, planId: null })
  })

  it('asks nothing when adding to a prescription already issued', () => {
    state.plans = [plan('a', 'active'), plan('b', 'active')]
    render(<MedicationForm patientId="p-1" doctorId="d-1" prescriptionId="presc-1" />)
    expect(screen.queryByLabelText(/care plan/i)).not.toBeInTheDocument()
  })
})

describe('the doctor scheduling an appointment', () => {
  const when = () => {
    const date = new Date(Date.now() + 2 * 86_400_000)
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
    return date.toISOString().slice(0, 16)
  }

  it('asks which care plan when the patient has two active ones, and sends the choice', async () => {
    state.plans = [plan('a', 'active', 'Knee recovery'), plan('b', 'active', 'Back pain')]
    render(<ScheduleAppointmentDialog isOpen onClose={() => {}} patientId="p-1" />)
    fireEvent.change(screen.getByLabelText(/date and time/i), { target: { value: when() } })
    fireEvent.click(screen.getByRole('button', { name: 'Schedule appointment' }))
    expect(await screen.findByText('Choose which care plan this appointment is for.')).toBeInTheDocument()
    expect(state.appointment.mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/care plan/i), { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Schedule appointment' }))
    await waitFor(() => expect(state.appointment.mutate).toHaveBeenCalledTimes(1))
    expect(state.appointment.mutate.mock.calls[0]![0]).toMatchObject({ patientId: 'p-1', planId: 'a' })
  })

  it('books a patient whose care has ended with no plan: the database marks it a follow-up request', async () => {
    state.plans = [plan('a', 'discharged')]
    render(<ScheduleAppointmentDialog isOpen onClose={() => {}} patientId="p-1" />)
    expect(screen.queryByLabelText(/care plan/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/date and time/i), { target: { value: when() } })
    fireEvent.click(screen.getByRole('button', { name: 'Schedule appointment' }))
    await waitFor(() => expect(state.appointment.mutate).toHaveBeenCalledTimes(1))
    expect(state.appointment.mutate.mock.calls[0]![0]).not.toHaveProperty('planId')
  })
})
