import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TreatmentGoal } from '@/features/treatment-plans/api'

/**
 * Module 5.8: the patient records progress on their own goal (migration 55).
 * The screen offers only the moves the database allows; it never offers
 * missed, which only the system sets.
 */

const client = vi.hoisted(() => {
  const state = {
    data: null as unknown,
    error: null as { code?: string; message: string } | null,
  }
  const supabase = {
    rpc: vi.fn(async () => ({ data: state.error ? null : state.data, error: state.error })),
    from: vi.fn(() => {
      throw new Error('Progress must not be written to the table directly')
    }),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const mutation = vi.hoisted(() => ({
  current: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null as unknown,
    variables: undefined as { goalId: string; status: string } | undefined,
  },
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useUpdateGoalStatus: () => mutation.current,
}))

const { updateTreatmentGoalStatus } = await import('@/features/treatment-plans/api')
const { GoalProgressActions } = await import('@/features/treatment-plans/components/goal-progress-actions')

const goal = (status: TreatmentGoal['treatment_goal_status']): TreatmentGoal => ({
  treatment_goal_id: 'goal-1',
  treatment_plan_id: 'plan-1',
  treatment_goal_description: 'Walk 500 metres unaided',
  treatment_goal_target_date: '2026-12-01',
  treatment_goal_status: status,
  treatment_goal_created_at: '2026-11-01T00:00:00Z',
  recovery_phase_id: null,
})

beforeEach(() => {
  client.state.data = goal('in_progress')
  client.state.error = null
  client.supabase.rpc.mockClear()
  mutation.current = {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    variables: undefined,
  }
})

describe('updateTreatmentGoalStatus', () => {
  it('calls the patient function with the goal and the status alone', async () => {
    await expect(updateTreatmentGoalStatus('goal-1', 'in_progress')).resolves.toMatchObject({
      treatment_goal_status: 'in_progress',
    })
    expect(client.supabase.rpc).toHaveBeenCalledWith('patient_update_treatment_goal_status', {
      target_goal_id: 'goal-1',
      new_status: 'in_progress',
    })
    expect(client.supabase.from).not.toHaveBeenCalled()
  })

  it('passes the database’s refusal on', async () => {
    client.state.error = { code: '42501', message: 'Only the patient can record progress on their own goal' }
    await expect(updateTreatmentGoalStatus('goal-1', 'achieved')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('GoalProgressActions', () => {
  it('offers start and achieved on a goal not yet started', () => {
    render(<GoalProgressActions patientId="pat-1" goal={goal('pending')} />)
    fireEvent.click(screen.getByRole('button', { name: /start goal/i }))
    expect(mutation.current.mutate.mock.calls[0]![0]).toEqual({ goalId: 'goal-1', status: 'in_progress' })
    expect(screen.getByRole('button', { name: /mark achieved/i })).toBeInTheDocument()
  })

  it('offers only achieved once started', () => {
    render(<GoalProgressActions patientId="pat-1" goal={goal('in_progress')} />)
    expect(screen.queryByRole('button', { name: /start goal/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /mark achieved/i }))
    expect(mutation.current.mutate.mock.calls[0]![0]).toEqual({ goalId: 'goal-1', status: 'achieved' })
  })

  it('says a missed goal’s date has passed, and still lets it be achieved late', () => {
    render(<GoalProgressActions patientId="pat-1" goal={goal('missed')} />)
    expect(screen.getByText(/target date has passed/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /mark achieved/i })).toBeInTheDocument()
  })

  it('offers nothing on an achieved goal, and never offers missed', () => {
    render(<GoalProgressActions patientId="pat-1" goal={goal('achieved')} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/mark missed/i)).not.toBeInTheDocument()
  })

  it('takes no second press while one saves', () => {
    mutation.current.isPending = true
    mutation.current.variables = { goalId: 'goal-1', status: 'in_progress' }
    render(<GoalProgressActions patientId="pat-1" goal={goal('pending')} />)
    const start = screen.getByRole('button', { name: /start goal/i })
    expect(start).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(start)
    fireEvent.click(screen.getByRole('button', { name: /mark achieved/i }))
    expect(mutation.current.mutate).not.toHaveBeenCalled()
  })

  it('keeps keyboard focus on the goal once saved, though the pressed button goes', () => {
    mutation.current.mutate.mockImplementation((_input: unknown, options: { onSuccess?: () => void }) => options.onSuccess?.())
    const { container } = render(<GoalProgressActions patientId="pat-1" goal={goal('in_progress')} />)
    screen.getByRole('button', { name: /mark achieved/i }).focus()
    fireEvent.click(screen.getByRole('button', { name: /mark achieved/i }))
    expect(document.activeElement).toBe(container.firstElementChild)
  })

  it('shows why progress was not saved', () => {
    mutation.current.isError = true
    mutation.current.error = new Error('Progress can be recorded only while the treatment plan is active')
    render(<GoalProgressActions patientId="pat-1" goal={goal('pending')} />)
    expect(screen.getByText('Your progress was not saved')).toBeInTheDocument()
  })
})
