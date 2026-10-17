import { describe, expect, it, vi } from 'vitest'

/**
 * A Super Admin who signs in to the clinic website (migration 33).
 *
 * The site has no screens for the platform: its console is separate (PR 5).
 * So the account is stopped with a reason, as soon as its role is read, and
 * no clinic profile is ever looked up for it.
 */

const client = vi.hoisted(() => {
  const tables: string[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      tables.push(table)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { user_id: 'super-user', user_email: 'super@platform.test', user_role: 'super_admin' },
              error: null,
            }),
          }),
        }),
      }
    }),
  }
  return { supabase, tables }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { loadAppUser } = await import('@/features/auth/api')

describe('a platform administrator signing in to the clinic website', () => {
  it('is stopped with a reason, and no clinic profile is looked up', async () => {
    expect(await loadAppUser('super-user', 'super@platform.test')).toEqual({
      state: 'blocked',
      problem: { kind: 'platform-account' },
    })
    expect(client.tables).toEqual(['user_account'])
  })
})
