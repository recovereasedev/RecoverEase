import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA-01 — what "End medication" sends.
 *
 * The existing schedule update, with the end date set to the clinic's today
 * as the database reckons it — not the browser's date.
 */

const client = vi.hoisted(() => {
  const state = {
    today: '2026-09-12' as string | null,
    rows: [{ medication_schedule_id: 'ms-1' }] as unknown[],
    calls: [] as unknown[][],
  }
  const supabase = {
    rpc: vi.fn(async (name: string) => {
      state.calls.push(['rpc', name])
      return { data: state.today, error: null }
    }),
    from: vi.fn((table: string) => {
      state.calls.push(['from', table])
      return {
        update: (payload: unknown) => {
          state.calls.push(['update', payload])
          return {
            eq: (column: string, value: unknown) => {
              state.calls.push(['eq', column, value])
              return {
                select: async (columns: string) => {
                  state.calls.push(['select', columns])
                  return { data: state.rows, error: null }
                },
              }
            },
          }
        },
      }
    }),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { endMedicationSchedule } = await import('@/features/medications/api')

beforeEach(() => {
  client.state.calls.length = 0
  client.state.rows = [{ medication_schedule_id: 'ms-1' }]
})

describe('endMedicationSchedule', () => {
  it('sets the end date to the clinic’s today through the existing schedule update', async () => {
    await endMedicationSchedule('ms-1')

    expect(client.state.calls).toEqual([
      ['rpc', 'app_today'],
      ['from', 'medication_schedule'],
      ['update', { medication_schedule_end_date: '2026-09-12' }],
      ['eq', 'medication_schedule_id', 'ms-1'],
      ['select', 'medication_schedule_id'],
    ])
  })

  it('fails loudly when the update changed nothing', async () => {
    // RLS refuses an update by matching no row, not by raising.
    client.state.rows = []

    await expect(endMedicationSchedule('ms-1')).rejects.toThrow(/could not be ended/)
  })
})
