import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/lib/query-keys'

/**
 * QA-01 — after "End medication" the screens show the ended course at once:
 * the schedule list, the dose lists and the adherence summary all read from
 * the medication branch, and the prescription list from its own.
 */

vi.mock('@/features/medications/api', () => ({
  endMedicationSchedule: vi.fn().mockResolvedValue(undefined),
  createMedicationSchedule: vi.fn(),
  createPrescription: vi.fn(),
  fetchDoses: vi.fn(),
  fetchSchedules: vi.fn(),
  setDoseStatus: vi.fn(),
}))

const { useEndMedicationSchedule } = await import('@/features/medications/hooks')

describe('refreshing after ending a medication', () => {
  it('refreshes the medication and prescription queries', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useEndMedicationSchedule('p-1'), { wrapper })

    result.current.mutate('ms-1')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.medications.all })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.prescriptions.forPatient('p-1'),
    })
  })
})
