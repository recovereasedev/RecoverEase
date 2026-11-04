import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Placing a goal in a phase, as the doctor's roadmap editor sends it. The
 * database refuses at once, rather than wait, when the phase is being
 * changed at that moment (migration 45); the doctor is told to try again.
 */

const client = vi.hoisted(() => {
  const state = {
    rows: [{ treatment_goal_id: 'goal-1' }] as unknown[] | null,
    error: null as { code?: string; message: string } | null,
  }
  const supabase = {
    from: vi.fn(() => ({
      update: () => ({
        eq: () => ({
          select: async () => ({ data: state.error ? null : state.rows, error: state.error }),
        }),
      }),
    })),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { linkGoalToPhase } = await import('@/features/recovery-roadmap/api')

describe('linkGoalToPhase', () => {
  beforeEach(() => {
    client.state.rows = [{ treatment_goal_id: 'goal-1' }]
    client.state.error = null
  })

  it('places the goal', async () => {
    await expect(linkGoalToPhase('goal-1', 'phase-1')).resolves.toBeUndefined()
  })

  it('says to try again when the phase is being changed at that moment', async () => {
    client.state.error = { code: '55P03', message: 'could not obtain lock on row in relation "recovery_phase"' }
    await expect(linkGoalToPhase('goal-1', 'phase-1')).rejects.toThrow(
      'That phase is being changed right now. Try again in a moment.',
    )
  })

  it('passes any other refusal on as it is', async () => {
    client.state.error = { code: '23514', message: 'This phase is archived; link the goal to a current phase' }
    await expect(linkGoalToPhase('goal-1', 'phase-1')).rejects.toMatchObject({ code: '23514' })
  })

  it('fails when row-level security changed nothing', async () => {
    client.state.rows = []
    await expect(linkGoalToPhase('goal-1', 'phase-1')).rejects.toThrow('The goal was not moved.')
  })
})
