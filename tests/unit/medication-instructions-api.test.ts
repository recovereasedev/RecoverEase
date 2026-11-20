import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What a medicine's instructions send to the database (migration 58).
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
        insert: (payload: unknown) => {
          state.calls.push(['insert', payload])
          return { select: () => ({ single: async () => ({ data: payload, error: null }) }) }
        },
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

const { createMedicationSchedule, updateMedicationInstructions } = await import(
  '@/features/medications/api'
)

const NEW = {
  prescriptionId: 'rx-1',
  name: 'Amoxicillin',
  dosage: '500 mg',
  times: ['08:00'],
  startDate: '2026-09-12',
  endDate: null,
}

const inserted = () =>
  client.state.calls.find(([kind]) => kind === 'insert')![1] as Record<string, unknown>

beforeEach(() => {
  client.state.calls.length = 0
  client.state.rows = [{ medication_schedule_id: 'ms-1' }]
})

describe('createMedicationSchedule', () => {
  it('writes the medicine’s instructions with the schedule', async () => {
    await createMedicationSchedule({ ...NEW, instructions: 'Take after meals.' })

    expect(inserted()).toMatchObject({
      medication_schedule_name: 'Amoxicillin',
      medication_schedule_instructions: 'Take after meals.',
    })
  })

  it('leaves the column out when there are none, so the database default (NULL) stands', async () => {
    await createMedicationSchedule({ ...NEW, instructions: null })

    expect(inserted()).not.toHaveProperty('medication_schedule_instructions')
  })
})

describe('updateMedicationInstructions', () => {
  it('updates that schedule’s instructions and nothing else', async () => {
    await updateMedicationInstructions({ scheduleId: 'ms-1', instructions: 'Take before meals.' })

    expect(client.state.calls).toEqual([
      ['from', 'medication_schedule'],
      ['update', { medication_schedule_instructions: 'Take before meals.' }],
      ['eq', 'medication_schedule_id', 'ms-1'],
      ['select', 'medication_schedule_id'],
    ])
  })

  it('fails loudly when the update changed nothing', async () => {
    // RLS refuses an update by matching no row, not by raising.
    client.state.rows = []

    await expect(
      updateMedicationInstructions({ scheduleId: 'ms-1', instructions: null }),
    ).rejects.toThrow(/could not be saved/)
  })
})
