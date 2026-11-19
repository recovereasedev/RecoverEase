import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `fetchAllDoses`: every dose in a window, however many rows the Data API
 * returns per response.
 *
 * The stand-in client below answers like PostgREST does: a page never holds
 * more than the server's own cap, whatever `range` asked for; the exact count
 * comes back only when it was requested, and only if the server sends it.
 */

type Row = { medication_log_id: string; medication_log_scheduled_at: string }

const client = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    /** The most rows the server puts in one response. */
    cap: 1000,
    /** Whether the server answers `count: 'exact'`. */
    sendsCount: true,
    /** The request, counted from 1, that fails. */
    failOn: null as number | null,
    requests: [] as { from: number; to: number; count: string | undefined }[],
    calls: [] as unknown[][],
  }

  const supabase = {
    from: vi.fn((table: string) => {
      state.calls.push(['from', table])
      let count: string | undefined
      const builder = {
        select: (_columns: string, options?: { count?: string }) => {
          count = options?.count
          return builder
        },
        eq: (column: string, value: unknown) => {
          state.calls.push(['eq', column, value])
          return builder
        },
        gte: (column: string, value: unknown) => {
          state.calls.push(['gte', column, value])
          return builder
        },
        lte: (column: string, value: unknown) => {
          state.calls.push(['lte', column, value])
          return builder
        },
        order: (column: string, options: unknown) => {
          state.calls.push(['order', column, options])
          return builder
        },
        range: async (from: number, to: number) => {
          state.requests.push({ from, to, count })
          if (state.failOn === state.requests.length) {
            return { data: null, error: { message: 'canceling statement due to statement timeout' }, count: null }
          }
          const end = Math.min(to + 1, from + state.cap)
          return {
            data: state.rows.slice(from, end),
            error: null,
            count: count === 'exact' && state.sendsCount ? state.rows.length : null,
          }
        },
      }
      return builder
    }),
  }

  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { DOSE_PAGE_SIZE, fetchAllDoses } = await import('@/features/medications/api')

const WINDOW = {
  patientId: 'p-alice',
  from: '2026-09-23T16:00:00.000Z',
  to: '2026-10-23T15:59:59.999Z',
}

function rows(total: number): Row[] {
  return Array.from({ length: total }, (_, index) => ({
    medication_log_id: `dose-${String(index).padStart(5, '0')}`,
    medication_log_scheduled_at: new Date(Date.UTC(2026, 8, 24) + index * 60_000).toISOString(),
  }))
}

beforeEach(() => {
  client.state.rows = []
  client.state.cap = 1000
  client.state.sendsCount = true
  client.state.failOn = null
  client.state.requests.length = 0
  client.state.calls.length = 0
})

describe('fetchAllDoses', () => {
  it('pages past the response cap until it has every dose, in order', async () => {
    client.state.rows = rows(2500)

    const doses = await fetchAllDoses(WINDOW)

    expect(doses).toHaveLength(2500)
    expect(doses.map((dose) => dose.medication_log_id)).toEqual(
      client.state.rows.map((row) => row.medication_log_id),
    )
    expect(client.state.requests).toEqual([
      { from: 0, to: DOSE_PAGE_SIZE - 1, count: 'exact' },
      { from: 1000, to: 1999, count: undefined },
      { from: 2000, to: 2999, count: undefined },
    ])
  })

  it('reads the same window fetchDoses does, ordered so pages cannot overlap', async () => {
    client.state.rows = rows(3)

    await fetchAllDoses(WINDOW)

    expect(client.state.calls).toEqual([
      ['from', 'medication_log'],
      ['eq', 'medication_schedule.prescription.pat_id', 'p-alice'],
      ['gte', 'medication_log_scheduled_at', WINDOW.from],
      ['lte', 'medication_log_scheduled_at', WINDOW.to],
      ['order', 'medication_log_scheduled_at', { ascending: true }],
      ['order', 'medication_log_id', { ascending: true }],
    ])
  })

  it('keeps going when the server returns fewer rows than were asked for', async () => {
    client.state.rows = rows(1000)
    client.state.cap = 400

    const doses = await fetchAllDoses(WINDOW)

    expect(doses).toHaveLength(1000)
    expect(client.state.requests.map((request) => request.from)).toEqual([0, 400, 800])
  })

  it('without a count, stops at the first page shorter than it asked for', async () => {
    client.state.rows = rows(1500)
    client.state.sendsCount = false

    const doses = await fetchAllDoses(WINDOW)

    expect(doses).toHaveLength(1500)
    expect(client.state.requests).toHaveLength(2)
  })

  it('drops a dose that arrives twice', async () => {
    const all = rows(1200)
    // The last row of the first page shows up again at the start of the next.
    client.state.rows = [...all.slice(0, 1000), all[999]!, ...all.slice(1000)]

    const doses = await fetchAllDoses(WINDOW)

    expect(doses).toHaveLength(1200)
    expect(new Set(doses.map((dose) => dose.medication_log_id)).size).toBe(1200)
  })

  it('fails the whole read when a page fails, rather than returning part of it', async () => {
    client.state.rows = rows(2500)
    client.state.failOn = 2

    await expect(fetchAllDoses(WINDOW)).rejects.toMatchObject({
      message: expect.stringMatching(/timeout/),
    })
  })

  it('makes one request for an empty window', async () => {
    const doses = await fetchAllDoses(WINDOW)

    expect(doses).toEqual([])
    expect(client.state.requests).toHaveLength(1)
  })
})
