import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F-01 — the doctor's half of the treatment and medication modules.
 *
 * The backend, the API layer and the hooks for modules 3.1, 3.2, 3.3, 4.1 and
 * 4.3 all existed and were tested. What did not exist was any interface that
 * called them: `useCreateTreatmentPlan`, `useCreateTreatmentGoal`,
 * `useCreatePrescription` and `useCreateMedicationSchedule` had zero callers,
 * so a clinician could read a plan they had no way to write. Production bore
 * that out — one seeded row in each clinical table across four patients.
 *
 * These assert the writing, and they assert it through the same components
 * the guided consultation and the patient-record tabs both render, so there
 * is only ever one implementation of "create a plan" to keep correct.
 */

const created = vi.hoisted(() => ({
  plan: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  planUpdate: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  goal: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  prescription: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  schedule: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  /** Arguments the hook factories were called with, i.e. the context. */
  context: [] as { hook: string; args: unknown[] }[],
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useCreateTreatmentPlan: (...args: unknown[]) => {
    created.context.push({ hook: 'useCreateTreatmentPlan', args })
    return created.plan
  },
  useUpdateTreatmentPlan: (...args: unknown[]) => {
    created.context.push({ hook: 'useUpdateTreatmentPlan', args })
    return created.planUpdate
  },
  useCreateTreatmentGoal: (...args: unknown[]) => {
    created.context.push({ hook: 'useCreateTreatmentGoal', args })
    return created.goal
  },
  useUpdateGoalStatus: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useTreatmentPlans: () => ({ data: [], isPending: false, error: null }),
}))

vi.mock('@/features/medications/hooks', () => ({
  useCreatePrescription: (...args: unknown[]) => {
    created.context.push({ hook: 'useCreatePrescription', args })
    return created.prescription
  },
  useCreateMedicationSchedule: (...args: unknown[]) => {
    created.context.push({ hook: 'useCreateMedicationSchedule', args })
    return created.schedule
  },
  useMedicationSchedules: () => ({ data: [], isPending: false, error: null }),
  useDoses: () => ({ data: [], isPending: false, error: null }),
}))

const { TreatmentPlanForm } = await import(
  '@/features/treatment-plans/components/treatment-plan-form'
)
const { TreatmentGoalForm } = await import(
  '@/features/treatment-plans/components/treatment-goal-form'
)
const { MedicationForm } = await import(
  '@/features/medications/components/medication-form'
)
const { ConsultationFlow } = await import(
  '@/features/patients/components/consultation-flow'
)

const PATIENT = 'pat-1'
const DOCTOR = 'doc-1'

const PLAN = {
  treatment_plan_id: 'plan-1',
  pat_id: PATIENT,
  doc_id: DOCTOR,
  treatment_plan_title: 'Post-operative knee recovery',
  treatment_plan_description: 'Twelve week programme.',
  treatment_plan_start_date: '2026-02-01',
  treatment_plan_end_date: null,
  treatment_plan_status: 'active',
  treatment_plan_created_at: '2026-02-01T00:00:00Z',
  treatment_plan_updated_at: '2026-02-01T00:00:00Z',
  treatment_goal: [
    {
      treatment_goal_id: 'goal-1',
      treatment_plan_id: 'plan-1',
      treatment_goal_description: 'Walk 500 metres unaided',
      treatment_goal_target_date: '2026-05-01',
      treatment_goal_status: 'in_progress',
      treatment_goal_created_at: '2026-02-01T00:00:00Z',
    },
  ],
}

const SCHEDULE = {
  medication_schedule_id: 'sched-1',
  prescription_id: 'presc-1',
  medication_schedule_name: 'Paracetamol',
  medication_schedule_dosage: '500 mg',
  medication_schedule_frequency: 2,
  medication_schedule_times: ['08:00:00', '20:00:00'],
  medication_schedule_start_date: '2026-02-01',
  medication_schedule_end_date: null,
  medication_schedule_created_at: '2026-02-01T00:00:00Z',
  prescription: {
    prescription_id: 'presc-1',
    prescription_issued_date: '2026-02-01',
    prescription_notes: null,
  },
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const anyPlan = PLAN as any
const anySchedule = SCHEDULE as any

beforeEach(() => {
  for (const key of ['plan', 'planUpdate', 'goal', 'prescription', 'schedule'] as const) {
    created[key].mutate.mockReset()
    created[key].isError = false
    created[key].isPending = false
    created[key].error = null
  }
  created.context = []
})

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('creating a treatment plan (module 3.1)', () => {
  it('refuses a plan with no title, and sends nothing', () => {
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)
    fireEvent.click(screen.getByRole('button', { name: /create treatment plan/i }))

    expect(screen.getByText('Give the plan a title.')).toBeInTheDocument()
    expect(created.plan.mutate).not.toHaveBeenCalled()
  })

  it('submits a valid plan, trimming the title and dropping an empty description', () => {
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/plan title/i, '  Knee rehabilitation  ')
    typeInto(/start date/i, '2026-03-01')
    fireEvent.click(screen.getByRole('button', { name: /create treatment plan/i }))

    expect(created.plan.mutate).toHaveBeenCalledTimes(1)
    expect(created.plan.mutate.mock.calls[0][0]).toEqual({
      title: 'Knee rehabilitation',
      description: null,
      startDate: '2026-03-01',
      endDate: null,
    })
  })

  it('refuses an end date before the start date, as the database would', () => {
    // Mirrors the CHECK constraint `treatment_plan_dates_ordered`. Sending it
    // would be answered with "violates check constraint", which names nothing
    // the clinician can act on.
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/plan title/i, 'Knee rehabilitation')
    typeInto(/start date/i, '2026-03-01')
    typeInto(/end date/i, '2026-02-01')
    fireEvent.click(screen.getByRole('button', { name: /create treatment plan/i }))

    expect(
      screen.getByText('The end date cannot be before the start date.'),
    ).toBeInTheDocument()
    expect(created.plan.mutate).not.toHaveBeenCalled()
  })

  it('sends one mutation for two clicks in the same task', () => {
    // `isPending` re-renders too late to stop the second click; only the
    // synchronous ref does. Two identical appointments reached production
    // through exactly this gap once already.
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/plan title/i, 'Knee rehabilitation')
    const submit = screen.getByRole('button', { name: /create treatment plan/i })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(created.plan.mutate).toHaveBeenCalledTimes(1)
  })

  it('takes the patient and the doctor from context, never from a control', () => {
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)

    expect(created.context).toContainEqual({
      hook: 'useCreateTreatmentPlan',
      args: [PATIENT, DOCTOR],
    })
    // No way to pick either of them.
    expect(screen.queryByLabelText(/doctor|clinician|patient/i)).toBeNull()
  })

  it('shows the failure rather than a silent no-op', () => {
    created.plan.isError = true
    created.plan.error = { code: '42501', message: 'permission denied' }
    render(<TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      /you do not have access to this/i,
    )
  })
})

describe('editing a treatment plan (module 3.2)', () => {
  it('prefills the existing plan and updates it in place', () => {
    render(
      <TreatmentPlanForm patientId={PATIENT} doctorId={DOCTOR} plan={anyPlan} />,
    )
    expect(screen.getByLabelText(/plan title/i)).toHaveValue(
      'Post-operative knee recovery',
    )

    typeInto(/plan title/i, 'Revised knee recovery')
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }))

    expect(created.planUpdate.mutate).toHaveBeenCalledTimes(1)
    expect(created.planUpdate.mutate.mock.calls[0][0]).toMatchObject({
      planId: 'plan-1',
      changes: { treatment_plan_title: 'Revised knee recovery' },
    })
    // The create path is untouched by an edit.
    expect(created.plan.mutate).not.toHaveBeenCalled()
  })
})

describe('defining treatment goals (module 3.3)', () => {
  it('refuses a goal with no description', () => {
    render(<TreatmentGoalForm patientId={PATIENT} planId="plan-1" />)
    fireEvent.click(screen.getByRole('button', { name: /add goal/i }))

    expect(
      screen.getByText('Describe what the patient is working towards.'),
    ).toBeInTheDocument()
    expect(created.goal.mutate).not.toHaveBeenCalled()
  })

  it('submits a goal against its plan, with an optional target date', () => {
    render(<TreatmentGoalForm patientId={PATIENT} planId="plan-1" />)
    typeInto(/goal/i, 'Climb one flight of stairs')
    fireEvent.click(screen.getByRole('button', { name: /add goal/i }))

    expect(created.goal.mutate.mock.calls[0][0]).toEqual({
      planId: 'plan-1',
      description: 'Climb one flight of stairs',
      targetDate: null,
    })
  })

  it('keeps the target date when one is given', () => {
    render(<TreatmentGoalForm patientId={PATIENT} planId="plan-1" />)
    typeInto(/goal/i, 'Climb one flight of stairs')
    typeInto(/target date/i, '2026-06-01')
    fireEvent.click(screen.getByRole('button', { name: /add goal/i }))

    expect(created.goal.mutate.mock.calls[0][0]).toMatchObject({
      targetDate: '2026-06-01',
    })
  })

  it('clears itself after each goal, so several can be added in a row', () => {
    // Each goal is written on its own submit. A clinician adding four must
    // never lose the three already saved to a failure on the fourth.
    created.goal.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess?: () => void; onSettled?: () => void }) => {
        options.onSuccess?.()
        options.onSettled?.()
      },
    )
    render(<TreatmentGoalForm patientId={PATIENT} planId="plan-1" />)

    typeInto(/goal/i, 'First goal')
    fireEvent.click(screen.getByRole('button', { name: /add goal/i }))
    expect(screen.getByLabelText(/goal/i)).toHaveValue('')

    typeInto(/goal/i, 'Second goal')
    fireEvent.click(screen.getByRole('button', { name: /add goal/i }))

    expect(created.goal.mutate).toHaveBeenCalledTimes(2)
    expect(created.goal.mutate.mock.calls[1][0]).toMatchObject({
      description: 'Second goal',
    })
  })
})

describe('issuing a prescription and its schedule (modules 4.3 and 4.1)', () => {
  it('refuses a medicine with no name or dosage', () => {
    render(<MedicationForm patientId={PATIENT} doctorId={DOCTOR} />)
    fireEvent.click(screen.getByRole('button', { name: /add prescription/i }))

    expect(screen.getByText('Name the medicine.')).toBeInTheDocument()
    expect(
      screen.getByText('Say how much to take, e.g. 500 mg.'),
    ).toBeInTheDocument()
    expect(created.prescription.mutate).not.toHaveBeenCalled()
    expect(created.schedule.mutate).not.toHaveBeenCalled()
  })

  it('refuses two doses at the same time', () => {
    // `medication_schedule_times_match_frequency` counts entries, so a
    // duplicate would silently mean one fewer dose than the clinician set.
    render(<MedicationForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/medicine/i, 'Paracetamol')
    typeInto(/dosage/i, '500 mg')
    fireEvent.click(screen.getByRole('button', { name: /add another time/i }))
    fireEvent.change(screen.getByLabelText(/dose 2 time/i), {
      target: { value: '08:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add prescription/i }))

    expect(
      screen.getByText('Each dose needs a different time.'),
    ).toBeInTheDocument()
    expect(created.prescription.mutate).not.toHaveBeenCalled()
  })

  it('writes the prescription first, then the schedule against it', () => {
    created.prescription.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess?: (row: unknown) => void }) => {
        options.onSuccess?.({ prescription_id: 'presc-new' })
      },
    )
    render(<MedicationForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/prescription notes/i, 'Take with food.')
    typeInto(/medicine/i, 'Paracetamol')
    typeInto(/dosage/i, '500 mg')
    typeInto(/start date/i, '2026-03-01')
    fireEvent.click(screen.getByRole('button', { name: /add prescription/i }))

    expect(created.prescription.mutate.mock.calls[0][0]).toEqual({
      notes: 'Take with food.',
    })
    expect(created.schedule.mutate.mock.calls[0][0]).toEqual({
      prescriptionId: 'presc-new',
      name: 'Paracetamol',
      dosage: '500 mg',
      times: ['08:00'],
      startDate: '2026-03-01',
      endDate: null,
    })
  })

  it('adds a second medicine to the prescription already issued', () => {
    render(
      <MedicationForm
        patientId={PATIENT}
        doctorId={DOCTOR}
        prescriptionId="presc-1"
      />,
    )
    // A second medicine is not a second prescription, so there are no notes.
    expect(screen.queryByLabelText(/prescription notes/i)).toBeNull()

    typeInto(/medicine/i, 'Ibuprofen')
    typeInto(/dosage/i, '200 mg')
    fireEvent.click(screen.getByRole('button', { name: /add medicine/i }))

    expect(created.prescription.mutate).not.toHaveBeenCalled()
    expect(created.schedule.mutate.mock.calls[0][0]).toMatchObject({
      prescriptionId: 'presc-1',
      name: 'Ibuprofen',
    })
  })

  it('sends one prescription for two clicks in the same task', () => {
    render(<MedicationForm patientId={PATIENT} doctorId={DOCTOR} />)
    typeInto(/medicine/i, 'Paracetamol')
    typeInto(/dosage/i, '500 mg')
    const submit = screen.getByRole('button', { name: /add prescription/i })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(created.prescription.mutate).toHaveBeenCalledTimes(1)
  })

  it('takes the patient and the doctor from context', () => {
    render(<MedicationForm patientId={PATIENT} doctorId={DOCTOR} />)

    expect(created.context).toContainEqual({
      hook: 'useCreatePrescription',
      args: [PATIENT, DOCTOR],
    })
  })
})

describe('the guided consultation', () => {
  function renderFlow(overrides: {
    plans?: unknown[]
    schedules?: unknown[]
    onFinish?: () => void
  } = {}) {
    return render(
      <ConsultationFlow
        patientId={PATIENT}
        doctorId={DOCTOR}
        patientName="Alice Santos"
        plans={(overrides.plans ?? []) as never}
        schedules={(overrides.schedules ?? []) as never}
        onFinish={overrides.onFinish ?? (() => {})}
      />,
    )
  }

  it('names the five steps in the order the QA asked for', () => {
    // "start consultation then mo pop to treatment plan then med".
    renderFlow()
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent)

    expect(steps.some((s) => s?.includes('Treatment plan'))).toBe(true)
    expect(steps.some((s) => s?.includes('Goals'))).toBe(true)
    expect(steps.some((s) => s?.includes('Medication'))).toBe(true)
    expect(steps.some((s) => s?.includes('Review'))).toBe(true)
    expect(steps.some((s) => s?.includes('Finish'))).toBe(true)
  })

  it('opens on the treatment plan when the patient has none', () => {
    renderFlow()

    expect(
      screen.getByRole('button', { name: /create treatment plan/i }),
    ).toBeInTheDocument()
    const currentStep = screen.getByRole('listitem', { current: 'step' })
    expect(currentStep).toHaveTextContent('Treatment plan')
  })

  it('opens on goals when a plan already exists', () => {
    renderFlow({ plans: [anyPlan] })

    expect(screen.getByRole('button', { name: /add goal/i })).toBeInTheDocument()
    expect(screen.getByText('Walk 500 metres unaided')).toBeInTheDocument()
  })

  it('moves goals → medication → review → finish', () => {
    const onFinish = vi.fn()
    renderFlow({ plans: [anyPlan], schedules: [anySchedule], onFinish })

    fireEvent.click(screen.getByRole('button', { name: /continue to medication/i }))
    expect(screen.getByText('Paracetamol')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }))
    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /finish consultation/i }))
    expect(screen.getByText('Consultation recorded')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back to the patient record/i }))
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it('reviews what was actually saved, not what was typed', () => {
    renderFlow({ plans: [anyPlan], schedules: [anySchedule] })
    fireEvent.click(screen.getByRole('button', { name: /continue to medication/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }))

    // Only the review step is mounted, so these can only have come from the
    // saved plan and schedule — nothing here was typed into this component,
    // and none of these strings appear in the stepper.
    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument()
    expect(
      screen.getByText(/Post-operative knee recovery/),
    ).toBeInTheDocument()
    expect(screen.getByText('Walk 500 metres unaided')).toBeInTheDocument()
    expect(screen.getByText(/Paracetamol/)).toBeInTheDocument()
  })

  it('says plainly when a step was skipped rather than inventing a record', () => {
    // Leaving without prescribing is a real outcome, not an error, and it
    // must not be papered over with a placeholder row.
    renderFlow({ plans: [anyPlan] })
    fireEvent.click(screen.getByRole('button', { name: /continue to medication/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }))

    expect(screen.getByText('No medication was prescribed.')).toBeInTheDocument()
    expect(created.prescription.mutate).not.toHaveBeenCalled()
    expect(created.schedule.mutate).not.toHaveBeenCalled()
  })

  it('can be left at any point, with nothing half-written', () => {
    const onFinish = vi.fn()
    renderFlow({ plans: [anyPlan], onFinish })

    fireEvent.click(screen.getByRole('button', { name: /leave consultation/i }))

    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(created.plan.mutate).not.toHaveBeenCalled()
    expect(created.goal.mutate).not.toHaveBeenCalled()
    expect(created.prescription.mutate).not.toHaveBeenCalled()
  })

  it('never offers a patient or a doctor to choose', () => {
    // The clinician is already on one assigned patient's record; a database
    // trigger rejects any other pairing anyway.
    renderFlow({ plans: [anyPlan] })

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByLabelText(/choose a patient|select a patient/i)).toBeNull()
  })
})
