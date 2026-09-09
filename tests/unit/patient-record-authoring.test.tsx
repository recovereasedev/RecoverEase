import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'

/**
 * F-01, at the patient record rather than the components.
 *
 * The forms are covered on their own; what this pins is that they are
 * actually reachable — the gap was never a broken form, it was that no screen
 * rendered one. A clinician could open Treatment, read "No treatment plan has
 * been created for this patient", and have no way to create it.
 */

const state = vi.hoisted(() => ({
  plans: [] as unknown[],
  schedules: [] as unknown[],
  goalStatus: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}))

const noop = { mutate: vi.fn(), isPending: false, isError: false, error: null }

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => mockUser.current,
  useAuth: () => ({ user: mockUser.current, signOut: vi.fn(), refresh: vi.fn() }),
}))

const mockUser = vi.hoisted(() => ({ current: null as AppUser | null }))

vi.mock('@/features/patients/hooks', () => ({
  usePatient: () => ({
    isPending: false,
    error: null,
    data: {
      pat_id: 'pat-1',
      doc_id: 'doc-1',
      pat_first_name: 'Alice',
      pat_last_name: 'Santos',
      pat_status: 'active',
      pat_birth_date: '1990-01-02',
      pat_gender: null,
      pat_contact_no: null,
      pat_address: null,
      pat_created_at: '2026-01-01T00:00:00Z',
      pat_consent_at: null,
    },
    refetch: vi.fn(),
  }),
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({
    isPending: false,
    error: null,
    data: state.plans,
    refetch: vi.fn(),
  }),
  useCreateTreatmentPlan: () => noop,
  useUpdateTreatmentPlan: () => noop,
  useCreateTreatmentGoal: () => noop,
  useUpdateGoalStatus: () => state.goalStatus,
}))

vi.mock('@/features/medications/hooks', () => ({
  useMedicationSchedules: () => ({
    isPending: false,
    error: null,
    data: state.schedules,
    refetch: vi.fn(),
  }),
  useDoses: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
  useCreatePrescription: () => noop,
  useCreateMedicationSchedule: () => noop,
}))

vi.mock('@/features/recovery-logs/hooks', () => ({
  useRecoveryLogs: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
}))

// Clinical notes are read straight through react-query on this page.
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>(
      '@tanstack/react-query',
    )
  return {
    ...actual,
    useQuery: () => ({ isPending: false, error: null, data: [], refetch: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: () => noop,
  }
})

const { DoctorPatientDetailPage } = await import(
  '@/features/patients/pages/doctor-patient-detail-page'
)

const PLAN = {
  treatment_plan_id: 'plan-1',
  pat_id: 'pat-1',
  doc_id: 'doc-1',
  treatment_plan_title: 'Post-operative knee recovery',
  treatment_plan_description: null,
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
      treatment_goal_target_date: null,
      treatment_goal_status: 'in_progress',
      treatment_goal_created_at: '2026-02-01T00:00:00Z',
    },
  ],
}

beforeEach(() => {
  state.plans = []
  state.schedules = []
  state.goalStatus.mutate.mockReset()
  noop.mutate.mockReset()
  mockUser.current = {
    userId: 'u-1',
    email: 'doctor@example.test',
    role: 'doctor',
    displayName: 'Dr Reyes',
    mustChangePassword: false,
    profile: { kind: 'doctor', doctor: { doc_id: 'doc-1' } } as never,
  }
})

function openRecord(tab?: string) {
  render(
    <MemoryRouter
      initialEntries={[`/doctor/patients/pat-1${tab ? `?tab=${tab}` : ''}`]}
    >
      <Routes>
        <Route
          path="/doctor/patients/:patientId"
          element={<DoctorPatientDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('authoring from the patient record', () => {
  it('offers a way to create the plan the empty state describes', () => {
    // The defect exactly: this message was the end of the road.
    openRecord('treatment')

    expect(
      screen.getByText('No treatment plan has been created for this patient.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /create treatment plan/i }),
    ).toBeInTheDocument()
  })

  it('opens the plan form from that empty state', () => {
    openRecord('treatment')
    fireEvent.click(
      screen.getByRole('button', { name: /create treatment plan/i }),
    )

    expect(screen.getByLabelText(/plan title/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument()
  })

  it('offers Edit plan and Add goal once a plan exists', () => {
    state.plans = [PLAN]
    openRecord('treatment')

    expect(screen.getByRole('button', { name: /edit plan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add goal/i })).toBeInTheDocument()
    expect(screen.getByText('Walk 500 metres unaided')).toBeInTheDocument()
  })

  it('records progress against a goal through the existing mutation', () => {
    state.plans = [PLAN]
    openRecord('treatment')

    fireEvent.change(screen.getByLabelText(/progress/i), {
      target: { value: 'achieved' },
    })

    expect(state.goalStatus.mutate).toHaveBeenCalledWith({
      goalId: 'goal-1',
      status: 'achieved',
    })
  })

  it('offers a way to prescribe from the medication tab', () => {
    openRecord('medication')

    expect(
      screen.getByText('No prescriptions on record for this patient.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /add prescription/i }),
    ).toBeInTheDocument()
  })

  it('starts the guided consultation on the treatment tab', () => {
    // QA 09/06/2026 #2: "start consultation then mo pop to treatment plan
    // then med". The button already existed; it now opens the flow that
    // writes the plan rather than a tab that could only read one.
    openRecord()
    fireEvent.click(screen.getByRole('button', { name: /start consultation/i }))

    expect(screen.getByRole('tab', { name: 'Treatment' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText(/Consultation with Alice Santos/)).toBeInTheDocument()
    // Every tab of the record stays one click away while consulting.
    expect(screen.getByRole('tab', { name: 'Medication' })).toBeInTheDocument()
  })

  it('leaves the consultation without writing anything', () => {
    state.plans = [PLAN]
    openRecord()
    fireEvent.click(screen.getByRole('button', { name: /start consultation/i }))
    fireEvent.click(screen.getByRole('button', { name: /leave consultation/i }))

    // Back to the ordinary treatment tab, plan intact, nothing created.
    expect(screen.getByRole('button', { name: /edit plan/i })).toBeInTheDocument()
    expect(noop.mutate).not.toHaveBeenCalled()
  })

  it('never offers a doctor or a patient to choose', () => {
    // The record is already one assigned patient's, and a database trigger
    // rejects any other pairing.
    state.plans = [PLAN]
    openRecord('treatment')

    expect(screen.queryByLabelText(/choose a patient|assign|clinician/i)).toBeNull()
  })
})
