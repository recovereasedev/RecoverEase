import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A Super Admin signing in (migration 33): their account resolves to the
 * platform console's user, with their own profile - their name - and
 * nothing of any clinic. No clinic table is ever read for them.
 *
 * Signing in is not access. The console still asks for an authenticator
 * code (tests/unit/super-admin-assurance.test.tsx), and the database checks
 * for one on every call (tests/db/super-admin.test.ts).
 */

const client = vi.hoisted(() => {
  const tables: string[] = []
  const rows: Record<string, unknown> = {
    user_account: {
      user_id: 'super-user',
      user_email: 'super@platform.test',
      user_role: 'super_admin',
    },
    super_admin: {
      super_admin_id: 'sa-1',
      user_id: 'super-user',
      super_admin_first_name: 'Pat',
      super_admin_last_name: 'Reyes',
      super_admin_created_at: '2026-10-01T00:00:00Z',
    },
  }
  const supabase = {
    from: vi.fn((table: string) => {
      tables.push(table)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
          }),
        }),
      }
    }),
  }
  return { supabase, tables, rows }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { loadAppUser } = await import('@/features/auth/api')

describe('a Super Admin signing in', () => {
  beforeEach(() => {
    client.tables.length = 0
  })

  it('becomes the console user, named from their own profile, and no clinic profile is looked up', async () => {
    const status = await loadAppUser('super-user', 'super@platform.test')

    expect(status).toEqual({
      state: 'signed-in',
      user: {
        userId: 'super-user',
        email: 'super@platform.test',
        role: 'super_admin',
        displayName: 'Pat Reyes',
        mustChangePassword: false,
        profile: { kind: 'super_admin', superAdmin: client.rows['super_admin'] },
      },
    })
    expect(client.tables).toEqual(['user_account', 'super_admin'])
  })

  it('is stopped with a reason when the profile is missing', async () => {
    const profile = client.rows['super_admin']
    delete client.rows['super_admin']
    try {
      expect(await loadAppUser('super-user', 'super@platform.test')).toEqual({
        state: 'blocked',
        problem: { kind: 'profile-missing', role: 'super_admin' },
      })
    } finally {
      client.rows['super_admin'] = profile
    }
  })
})
