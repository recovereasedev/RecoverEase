import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the doctor's reminder switch sends to the database (migration 59).
 */

const client = vi.hoisted(() => {
  const state = {
    rows: [{ medication_schedule_id: 'ms-1' }] as unknown[],
    calls: [] as unknown[][],
  }
  const supabase = {
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

const { setMedicationReminders } = await import('@/features/medications/api')

beforeEach(() => {
  client.state.calls.length = 0
  client.state.rows = [{ medication_schedule_id: 'ms-1' }]
})

describe('setMedicationReminders', () => {
  it.each([false, true])('sets that schedule’s switch to %s and nothing else', async (enabled) => {
    await setMedicationReminders({ scheduleId: 'ms-1', enabled })

    expect(client.state.calls).toEqual([
      ['from', 'medication_schedule'],
      ['update', { medication_schedule_reminders_is_enabled: enabled }],
      ['eq', 'medication_schedule_id', 'ms-1'],
      ['select', 'medication_schedule_id'],
    ])
  })

  it('fails loudly when the update changed nothing', async () => {
    // RLS refuses an update by matching no row, not by raising.
    client.state.rows = []

    await expect(setMedicationReminders({ scheduleId: 'ms-1', enabled: false })).rejects.toThrow(
      /could not be saved/,
    )
  })
})
