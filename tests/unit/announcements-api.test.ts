import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isPresentableMessage } from '@/components/feedback/state-view'

/**
 * Publishing, unpublishing and deleting a clinic announcement, as the Clinic
 * Admin's page sends them, and what happens when the database changes
 * nothing.
 *
 * RLS refuses an update or a delete by matching no row, not by raising - a
 * platform announcement, another clinic's, or one already deleted. These
 * functions ask for the changed row back, and fail when there is none.
 */

const client = vi.hoisted(() => {
  const state = {
    rows: [{ announcement_id: 'ann-1' }] as unknown[] | null,
    error: null as { message: string } | null,
    calls: [] as unknown[][],
  }
  const filtered = (column: string, value: unknown) => {
    state.calls.push(['eq', column, value])
    return {
      select: async (columns: string) => {
        state.calls.push(['select', columns])
        return { data: state.rows, error: state.error }
      },
    }
  }
  const supabase = {
    from: vi.fn((table: string) => {
      state.calls.push(['from', table])
      return {
        update: (payload: unknown) => {
          state.calls.push(['update', payload])
          return { eq: filtered }
        },
        delete: () => {
          state.calls.push(['delete'])
          return { eq: filtered }
        },
      }
    }),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { deleteAnnouncement, isPlatformAnnouncement, setAnnouncementPublished } =
  await import('@/features/announcements/api')

beforeEach(() => {
  client.state.calls.length = 0
  client.state.rows = [{ announcement_id: 'ann-1' }]
  client.state.error = null
})

describe('setAnnouncementPublished', () => {
  it('publishes the announcement and asks for the changed row back', async () => {
    await setAnnouncementPublished('ann-1', true)

    expect(client.state.calls).toEqual([
      ['from', 'announcement'],
      ['update', { announcement_published_at: expect.any(String) }],
      ['eq', 'announcement_id', 'ann-1'],
      ['select', 'announcement_id'],
    ])
    const [, payload] = client.state.calls[1] as [string, { announcement_published_at: string }]
    expect(Number.isNaN(Date.parse(payload.announcement_published_at))).toBe(false)
  })

  it('unpublishes by clearing the date', async () => {
    await setAnnouncementPublished('ann-1', false)

    expect(client.state.calls[1]).toEqual(['update', { announcement_published_at: null }])
  })

  it('fails, saying so, when the database changed no row', async () => {
    client.state.rows = []
    await expect(setAnnouncementPublished('ann-platform', false)).rejects.toThrow(
      /announcement was not changed/,
    )

    client.state.rows = null
    await expect(setAnnouncementPublished('ann-platform', true)).rejects.toThrow(
      /announcement was not changed/,
    )
  })

  it('passes a database error through unchanged', async () => {
    client.state.error = { message: 'connection reset' }

    await expect(setAnnouncementPublished('ann-1', true)).rejects.toMatchObject({
      message: 'connection reset',
    })
  })
})

describe('deleteAnnouncement', () => {
  it('deletes the announcement and asks for the removed row back', async () => {
    await expect(deleteAnnouncement('ann-1')).resolves.toBeUndefined()

    expect(client.state.calls).toEqual([
      ['from', 'announcement'],
      ['delete'],
      ['eq', 'announcement_id', 'ann-1'],
      ['select', 'announcement_id'],
    ])
  })

  it('fails, saying so, when the database removed no row', async () => {
    client.state.rows = []

    await expect(deleteAnnouncement('ann-platform')).rejects.toThrow(
      /announcement was not deleted/,
    )
  })

  it('passes a database error through unchanged', async () => {
    client.state.error = { message: 'connection reset' }

    await expect(deleteAnnouncement('ann-1')).rejects.toMatchObject({
      message: 'connection reset',
    })
  })
})

describe('the no-row failures', () => {
  it('are written for the person who pressed the button, so the page shows them as they are', async () => {
    client.state.rows = []
    // An empty message - no failure at all - is not presentable either.
    const messageOf = (error: Error) => error.message
    const messages = await Promise.all([
      setAnnouncementPublished('ann-1', true).then(() => '', messageOf),
      deleteAnnouncement('ann-1').then(() => '', messageOf),
    ])

    for (const message of messages) expect(isPresentableMessage(message)).toBe(true)
  })
})

describe('isPlatformAnnouncement', () => {
  it('is true only for an announcement a Super Admin wrote', () => {
    const base = {
      announcement_id: 'a',
      announcement_title: 't',
      announcement_content: 'c',
      announcement_published_at: null,
      announcement_created_at: '2026-10-01T00:00:00Z',
    }
    expect(
      isPlatformAnnouncement({ ...base, admin_id: null, super_admin_id: 'sa-1', clinic_id: null }),
    ).toBe(true)
    expect(
      isPlatformAnnouncement({ ...base, admin_id: 'admin-1', super_admin_id: null, clinic_id: 'clinic-1' }),
    ).toBe(false)
  })
})
