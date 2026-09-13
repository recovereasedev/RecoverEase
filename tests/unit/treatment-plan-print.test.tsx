import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The patient's treatment plan, printed (module 3.5, served by the browser's
 * print). "Print or save as PDF" is a control: it stays on screen and off the
 * paper, and the plan itself prints as it always has.
 */

const plans = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-1',
    role: 'patient',
    profile: { kind: 'patient', patient: { pat_id: 'p-1' } },
  }),
}))

vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => ({
    data: plans.data,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

const { PatientTreatmentPage } = await import(
  '@/features/treatment-plans/pages/patient-treatment-page'
)

const PLAN = {
  treatment_plan_id: 'plan-1',
  pat_id: 'p-1',
  doc_id: 'd-1',
  treatment_plan_title: 'Shoulder rehabilitation',
  treatment_plan_description: 'Six week programme.',
  treatment_plan_start_date: '2026-09-01',
  treatment_plan_end_date: null,
  treatment_plan_status: 'active',
  treatment_plan_created_at: '2026-09-01T00:00:00Z',
  treatment_plan_updated_at: '2026-09-01T00:00:00Z',
  treatment_goal: [
    {
      treatment_goal_id: 'goal-1',
      treatment_plan_id: 'plan-1',
      treatment_goal_description: 'Raise arm above shoulder',
      treatment_goal_target_date: '2026-10-01',
      treatment_goal_status: 'achieved',
      treatment_goal_created_at: '2026-09-01T00:00:00Z',
    },
    {
      treatment_goal_id: 'goal-2',
      treatment_plan_id: 'plan-1',
      treatment_goal_description: 'Carry a shopping bag',
      treatment_goal_target_date: null,
      treatment_goal_status: 'in_progress',
      treatment_goal_created_at: '2026-09-01T00:00:00Z',
    },
  ],
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

const printButton = () =>
  screen.getByRole('button', { name: /print or save as pdf/i })

beforeEach(() => {
  plans.data = [PLAN]
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('printing the treatment plan', () => {
  it('offers Print or save as PDF on screen, and it prints', () => {
    render(<PatientTreatmentPage />)
    fireEvent.click(printButton())

    expect(window.print).toHaveBeenCalledTimes(1)
  })

  it('keeps its own print control off the paper', () => {
    render(<PatientTreatmentPage />)

    expect(leftOffPaper(printButton())).toBe(true)
  })

  it('keeps the plan itself on the paper', () => {
    render(<PatientTreatmentPage />)

    for (const text of [
      'Treatment plan',
      'Shoulder rehabilitation',
      'Six week programme.',
      'Raise arm above shoulder',
      'Carry a shopping bag',
      '1 of 2 achieved',
    ]) {
      expect(leftOffPaper(screen.getByText(text)), text).toBe(false)
    }
  })

  it('prints no control at all', () => {
    render(<PatientTreatmentPage />)

    const onPaper = screen
      .getAllByRole('button')
      .filter((button) => !leftOffPaper(button))
      .map((button) => button.textContent)
    expect(onPaper).toEqual([])
  })

  it('keeps the control off the paper before a plan exists, too', () => {
    plans.data = []
    render(<PatientTreatmentPage />)

    expect(leftOffPaper(printButton())).toBe(true)
    expect(leftOffPaper(screen.getByText('No treatment plan yet'))).toBe(false)
  })
})
