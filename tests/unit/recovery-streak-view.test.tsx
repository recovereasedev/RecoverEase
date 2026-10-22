import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 5.12, "View Recovery Streak", as the patient sees it on My recovery.
 *
 * `calculateStreak` itself is covered in `tests/unit/recovery-streak.test.ts`.
 * What is covered here is the number the page shows for the entries a
 * patient actually has: nothing logged, a run up to today, a run up to
 * yesterday (today not logged yet, which must not read as broken), a run
 * broken by a missed day, and the singular for one day.
 */

const api = vi.hoisted(() => ({
  fetchRecoveryLogs: vi.fn(),
  saveRecoveryLog: vi.fn(),
}))

vi.mock('@/features/recovery-logs/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-logs/api')>()),
  fetchRecoveryLogs: api.fetchRecoveryLogs,
  saveRecoveryLog: api.saveRecoveryLog,
}))

// The page's recovery progress panel also reads doses and treatment plans.
// Neither bears on the streak; answered empty so no test reaches a network.
vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: async () => [],
}))

vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: async () => [],
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-alice',
    role: 'patient',
    profile: { kind: 'patient', patient: { pat_id: 'p-alice' } },
  }),
}))

const { RecoveryPage } = await import('@/features/recovery-logs/pages/recovery-page')

// Mid-morning, local time, so no case sits on a date boundary.
const TODAY = new Date(2026, 9, 14, 10, 30)

/** The `recovery_log_date` key of the day `daysAgo` before TODAY. */
function dayKey(daysAgo: number): string {
  const date = new Date(TODAY)
  date.setDate(date.getDate() - daysAgo)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function entries(...daysAgo: number[]) {
  // Most recent first, as the API returns them.
  return [...daysAgo]
    .sort((a, b) => a - b)
    .map((ago, index) => ({
      recovery_log_id: `log-${index}`,
      pat_id: 'p-alice',
      recovery_log_date: dayKey(ago),
      recovery_log_mood_rating: 4,
      recovery_log_notes: null,
      recovery_log_created_at: TODAY.toISOString(),
    }))
}

async function renderWith(logs: ReturnType<typeof entries>) {
  api.fetchRecoveryLogs.mockResolvedValue(logs)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RecoveryPage />
    </QueryClientProvider>,
  )
  // The journal heading's list appears once the entries have loaded.
  await screen.findByRole('heading', { name: 'Your progress' })
}

/** The streak line, number and words together, as it reads. */
async function streakLine() {
  const line = await screen.findByText(/in a row$/)
  return line.textContent?.replace(/\s+/g, ' ').trim()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(TODAY)
  api.fetchRecoveryLogs.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the recovery streak on My recovery', () => {
  it('shows none before anything is logged', async () => {
    await renderWith(entries())
    expect(await streakLine()).toBe('0 days in a row')
  })

  it('counts a run of days up to and including today', async () => {
    await renderWith(entries(0, 1, 2))
    expect(await streakLine()).toBe('3 days in a row')
  })

  it('keeps a run that ended yesterday while today is not logged yet', async () => {
    await renderWith(entries(1, 2, 3, 4))
    expect(await streakLine()).toBe('4 days in a row')
  })

  it('counts only back to the last missed day', async () => {
    // Logged today and yesterday, missed the day before, logged before that.
    await renderWith(entries(0, 1, 3, 4, 5))
    expect(await streakLine()).toBe('2 days in a row')
  })

  it('shows none when the last entry is older than yesterday', async () => {
    await renderWith(entries(2, 3, 4))
    expect(await streakLine()).toBe('0 days in a row')
  })

  it('says “day”, not “days”, for one', async () => {
    await renderWith(entries(0))
    expect(await streakLine()).toBe('1 day in a row')
  })
})
