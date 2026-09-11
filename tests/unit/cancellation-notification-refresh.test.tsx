import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/lib/query-keys'

/**
 * F-02 — the notice a cancellation writes shows up straight away.
 *
 * The database writes a notification to both people when an appointment is
 * cancelled, the one who cancelled included. Queries stay fresh for a minute
 * and the bell polls once a minute, so without an explicit refresh the
 * canceller's own notice would appear up to a minute late.
 */

vi.mock('@/features/appointments/api', () => ({
  setAppointmentStatus: vi.fn().mockResolvedValue(undefined),
  createAppointment: vi.fn(),
  createRescheduleRequest: vi.fn(),
  decideRescheduleRequest: vi.fn(),
  fetchAppointments: vi.fn(),
  fetchRescheduleRequests: vi.fn(),
}))

const { useSetAppointmentStatus } = await import('@/features/appointments/hooks')

function renderMutation() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useSetAppointmentStatus(), { wrapper })
  return { result, invalidate }
}

describe('refreshing notifications after a status change', () => {
  it('refreshes notifications and appointments after a cancellation', async () => {
    const { result, invalidate } = renderMutation()

    result.current.mutate({ appointmentId: 'a-1', status: 'cancelled' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.notifications.all,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.appointments.all,
    })
  })

  it.each(['confirmed', 'completed', 'no_show', 'scheduled'] as const)(
    'refreshes only appointments after %s, which notifies nobody',
    async (status) => {
      const { result, invalidate } = renderMutation()

      result.current.mutate({ appointmentId: 'a-1', status })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.appointments.all,
      })
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: queryKeys.notifications.all,
      })
    },
  )
})
