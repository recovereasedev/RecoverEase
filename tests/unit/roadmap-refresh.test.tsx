import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { queryKeysFor } from '@/lib/query-keys'

/**
 * Migration 56 generates the roadmap's phases from the plan and its goals.
 * A goal added, or a plan's or goal's dates changed, changes the phases in
 * the database at once, so the roadmap is read again, not left until its
 * next timed refresh.
 */

vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  createTreatmentGoal: vi.fn().mockResolvedValue({}),
  updateTreatmentPlan: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({ userId: 'u-doctor' }),
}))

const { useCreateTreatmentGoal, useUpdateTreatmentPlan } = await import('@/features/treatment-plans/hooks')
const queryKeys = queryKeysFor('u-doctor')

function setUp() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { invalidate, wrapper }
}

describe('refreshing the generated roadmap', () => {
  it('reads the roadmap again after a goal is added', async () => {
    const { invalidate, wrapper } = setUp()
    const { result } = renderHook(() => useCreateTreatmentGoal('p-1'), { wrapper })
    result.current.mutate({ planId: 'plan-1', description: 'Walk', targetDate: null })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.roadmap.forPatient('p-1') })
  })

  it('reads the roadmap again after the plan is changed', async () => {
    const { invalidate, wrapper } = setUp()
    const { result } = renderHook(() => useUpdateTreatmentPlan('p-1'), { wrapper })
    result.current.mutate({ planId: 'plan-1', changes: { treatment_plan_end_date: '2026-12-31' } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.roadmap.forPatient('p-1') })
  })
})
