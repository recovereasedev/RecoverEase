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
        select: (columns: string) => {
          state.calls.push(['select', columns])
          return {
            order: async (column: string, options: unknown) => {
              state.calls.push(['order', column, options])
              return { data: state.rows, error: state.error }
            },
          }
        },
        insert: (payload: Record<string, unknown>) => {
          state.calls.push(['insert', payload])
          return {
            select: () => ({
              single: async () => ({
                data: state.error ? null : { announcement_id: 'ann-new', ...payload },
                error: state.error,
              }),
            }),
          }
        },
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

const {
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncements,
  isDoctorAnnouncement,
  isPlatformAnnouncement,
  setAnnouncementPublished,
} = await import('@/features/announcements/api')

beforeEach(() => {
  client.state.calls.length = 0
  client.state.rows = [{ announcement_id: 'ann-1' }]
  client.state.error = null
})

describe('fetchAnnouncements', () => {
  it('reads every announcement the database allows, newest first, with its doctor author’s name', async () => {
    await fetchAnnouncements()

    // Who sees which is the RLS policy's decision: the request asks for no
    // clinic, author or audience.
    expect(client.state.calls).toEqual([
      ['from', 'announcement'],
      ['select', '*, doctor ( doc_first_name, doc_last_name )'],
      ['order', 'announcement_created_at', { ascending: false }],
    ])
  })
})

describe('createAnnouncement', () => {
  it('writes a Clinic Admin’s as theirs, sending no clinic and no other author', async () => {
    await createAnnouncement({ author: { adminId: 'admin-1' }, title: 'T', content: 'C', publishNow: false })

    expect(client.state.calls).toEqual([
      ['from', 'announcement'],
      [
        'insert',
        { admin_id: 'admin-1', announcement_title: 'T', announcement_content: 'C', announcement_published_at: null },
      ],
    ])
  })

  it('writes a doctor’s as theirs, sending no clinic and no other author', async () => {
    await createAnnouncement({ author: { doctorId: 'doc-1' }, title: 'T', content: 'C', publishNow: true })

    const [, payload] = client.state.calls[1] as [string, Record<string, unknown>]
    expect(payload).toEqual({
      doc_id: 'doc-1',
      announcement_title: 'T',
      announcement_content: 'C',
      announcement_published_at: expect.any(String),
    })
    for (const column of ['admin_id', 'super_admin_id', 'clinic_id']) expect(payload).not.toHaveProperty(column)
  })

  it('passes the database’s refusal through', async () => {
    client.state.error = { message: 'new row violates row-level security policy for table "announcement"' }

    await expect(
      createAnnouncement({ author: { doctorId: 'doc-1' }, title: 'T', content: 'C', publishNow: true }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/row-level security/) })
  })
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
      doc_id: null,
    }
    expect(
      isPlatformAnnouncement({ ...base, admin_id: null, super_admin_id: 'sa-1', clinic_id: null }),
    ).toBe(true)
    expect(
      isPlatformAnnouncement({ ...base, admin_id: 'admin-1', super_admin_id: null, clinic_id: 'clinic-1' }),
    ).toBe(false)
    expect(
      isPlatformAnnouncement({ ...base, doc_id: 'doc-1', admin_id: null, super_admin_id: null, clinic_id: 'clinic-1' }),
    ).toBe(false)

    // isDoctorAnnouncement: only one a doctor wrote, for their patients.
    expect(
      isDoctorAnnouncement({ ...base, doc_id: 'doc-1', admin_id: null, super_admin_id: null, clinic_id: 'clinic-1' }),
    ).toBe(true)
    expect(
      isDoctorAnnouncement({ ...base, admin_id: 'admin-1', super_admin_id: null, clinic_id: 'clinic-1' }),
    ).toBe(false)
    expect(
      isDoctorAnnouncement({ ...base, admin_id: null, super_admin_id: 'sa-1', clinic_id: null }),
    ).toBe(false)
  })
})
