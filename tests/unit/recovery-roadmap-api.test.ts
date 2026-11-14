import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The doctor chooses which of the patient's appointments is the plan's
 * follow-up (migration 56). The database checks it is the patient's own;
 * row-level security returns no row, rather than an error, to anyone else.
 */

const client = vi.hoisted(() => {
  const state = {
    rows: [{ treatment_plan_id: 'plan-1' }] as unknown[] | null,
    error: null as { code?: string; message: string } | null,
    sent: [] as unknown[],
  }
  const supabase = {
    from: vi.fn(() => ({
      update: (changes: unknown) => {
        state.sent.push(changes)
        return {
          eq: () => ({
            select: async () => ({ data: state.error ? null : state.rows, error: state.error }),
          }),
        }
      },
    })),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { setFollowUpAppointment } = await import('@/features/recovery-roadmap/api')

describe('setFollowUpAppointment', () => {
  beforeEach(() => {
    client.state.rows = [{ treatment_plan_id: 'plan-1' }]
    client.state.error = null
    client.state.sent = []
  })

  it('sets the plan’s follow-up appointment, or clears it', async () => {
    await setFollowUpAppointment('plan-1', 'appt-1')
    await setFollowUpAppointment('plan-1', null)
    expect(client.supabase.from).toHaveBeenCalledWith('treatment_plan')
    expect(client.state.sent).toEqual([
      { treatment_plan_follow_up_appointment_id: 'appt-1' },
      { treatment_plan_follow_up_appointment_id: null },
    ])
  })

  it('passes a refusal on as it is', async () => {
    client.state.error = { code: '23503', message: 'violates foreign key constraint' }
    await expect(setFollowUpAppointment('plan-1', 'appt-x')).rejects.toMatchObject({ code: '23503' })
  })

  it('fails when row-level security changed nothing', async () => {
    client.state.rows = []
    await expect(setFollowUpAppointment('plan-1', 'appt-1')).rejects.toThrow('The follow-up appointment was not saved.')
  })
})
