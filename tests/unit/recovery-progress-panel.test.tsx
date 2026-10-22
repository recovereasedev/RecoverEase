import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { endOfDay, startOfDay, subDays } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MedicationLog } from '@/features/medications/api'
import type { PlanWithGoals } from '@/features/treatment-plans/api'

/**
 * The recovery progress panel, as the patient and their clinician see it:
 * what it says for the rows it is given, what it says when one of its three
 * reads fails, how its chart reads from the keyboard, and which copy keeps
 * itself current. The arithmetic itself is in recovery-progress.test.ts.
 */

const api = vi.hoisted(() => ({
  fetchRecoveryLogs: vi.fn(),
  fetchAllDoses: vi.fn(),
  fetchTreatmentPlans: vi.fn(),
}))

vi.mock('@/features/recovery-logs/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-logs/api')>()),
  fetchRecoveryLogs: api.fetchRecoveryLogs,
}))

vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: api.fetchAllDoses,
}))

vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: api.fetchTreatmentPlans,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-doctor',
    role: 'doctor',
    profile: { kind: 'doctor', doctor: { doc_id: 'd-1' } },
  }),
}))

const { RecoveryProgress } = await import(
  '@/features/recovery-progress/components/recovery-progress'
)

const TODAY = new Date(2026, 9, 23, 10, 30) // Friday 23 October 2026

function dayKey(daysAgo: number): string {
  const date = subDays(TODAY, daysAgo)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function log(daysAgo: number, rating: number | null) {
  return {
    recovery_log_id: `log-${daysAgo}`,
    pat_id: 'p-alice',
    recovery_log_date: dayKey(daysAgo),
    recovery_log_notes: null,
    recovery_log_mood_rating: rating,
    recovery_log_created_at: TODAY.toISOString(),
  }
}

function dose(
  daysAgo: number,
  status: MedicationLog['medication_log_status'],
  hour = 8,
): MedicationLog {
  const when = subDays(TODAY, daysAgo)
  when.setHours(hour, 0, 0, 0)
  return {
    medication_log_id: `dose-${daysAgo}-${hour}`,
    medication_schedule_id: 'schedule-1',
    medication_log_scheduled_at: when.toISOString(),
    medication_log_taken_at: null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: null,
  }
}

// Five of the seven days have a record; the overall average is 70%.
//   6 days ago: rated 3 (50%), 1 of 1 taken (100%)  -> 75%
//   5 days ago: rated 4 (75%), 0 of 1 taken (0%)    -> 37.5%
//   4 days ago: 1 taken, 1 skipped (50%)            -> 50%
//   3 days ago: rated 5 (100%)                      -> 100%
//   today:      rated 4 (75%), 1 taken + 1 pending  -> 87.5%
const LOGS = [log(6, 3), log(5, 4), log(3, 5), log(0, 4)]
const DOSES = [
  dose(6, 'taken'),
  dose(5, 'missed'),
  dose(4, 'taken'),
  dose(4, 'skipped', 20),
  dose(0, 'taken'),
  dose(0, 'pending', 20),
]

const PLANS: PlanWithGoals[] = [
  {
    treatment_plan_id: 'plan-1',
    pat_id: 'p-alice',
    doc_id: 'd-1',
    treatment_plan_title: 'Post-operative knee recovery',
    treatment_plan_description: null,
    treatment_plan_start_date: '2026-09-01',
    treatment_plan_end_date: null,
    treatment_plan_status: 'active',
    treatment_plan_created_at: '2026-09-01T00:00:00Z',
    treatment_plan_updated_at: '2026-09-01T00:00:00Z',
    treatment_goal: [
      {
        treatment_goal_id: 'g-1',
        treatment_plan_id: 'plan-1',
        treatment_goal_description: 'Walk 500 metres unaided',
        treatment_goal_target_date: '2026-11-01',
        treatment_goal_status: 'in_progress',
        treatment_goal_created_at: '2026-09-01T00:00:00Z',
      },
      {
        treatment_goal_id: 'g-2',
        treatment_plan_id: 'plan-1',
        treatment_goal_description: 'Climb stairs with a rail',
        treatment_goal_target_date: '2026-10-01',
        treatment_goal_status: 'achieved',
        treatment_goal_created_at: '2026-09-01T00:00:00Z',
      },
    ],
  },
]

beforeEach(() => {
  // Only the clock is faked, so queries and user events run as they would.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(TODAY)
  api.fetchRecoveryLogs.mockReset().mockResolvedValue(LOGS)
  api.fetchAllDoses.mockReset().mockResolvedValue(DOSES)
  api.fetchTreatmentPlans.mockReset().mockResolvedValue(PLANS)
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

function renderPanel({
  live = false,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: { live?: boolean; client?: QueryClient } = {}) {
  render(
    <QueryClientProvider client={client}>
      <RecoveryProgress patientId="p-alice" live={live} />
    </QueryClientProvider>,
  )
  return client
}

/** A paragraph whose whole text is `text`, across the spans inside it. */
function paragraph(text: string) {
  return screen.getByText(
    (_, element) => element?.tagName === 'P' && element.textContent === text,
  )
}

describe('the recovery progress panel', () => {
  it('heads the overall chart with the average of the days plotted, and says how many days it rests on', async () => {
    renderPanel()

    expect(await screen.findByText('70%')).toBeInTheDocument()
    expect(screen.getByText('Based on 5 of 7 days with records.')).toBeInTheDocument()
    expect(screen.getByText('17–23 October 2026')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '7 days' })).toBeChecked()
  })

  it('shows the mood average and leaves unrated days as gaps in the line', async () => {
    renderPanel()

    expect(await screen.findByText('Average reported mood')).toBeInTheDocument()
    expect(paragraph('4.0 / 5')).toBeInTheDocument()

    const chart = screen.getByRole('group', { name: /Mood rating by day/ })
    // Four rated days are four points; only the two consecutive ones are
    // joined, so the line never crosses an unrated day.
    expect(chart.querySelectorAll('circle')).toHaveLength(4)
    expect(chart.querySelectorAll('path')).toHaveLength(1)
  })

  it('draws a bar only for days with resolved doses, and a genuine 0% as a baseline cap', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('radio', { name: 'Medication' }))

    // 3 taken of 5 resolved, pooled across the period; the pending dose is out.
    expect(paragraph('60%')).toBeInTheDocument()
    expect(paragraph('3 of 5 resolved doses taken · 1 not yet recorded')).toBeInTheDocument()

    const chart = screen.getByRole('group', { name: /Doses taken by day/ })
    expect(chart.querySelectorAll('path')).toHaveLength(3) // 100%, 50%, 100%
    expect(chart.querySelectorAll('rect')).toHaveLength(1) // the missed day, 0%
    expect(chart.querySelectorAll('circle.stroke-outline')).toHaveLength(3) // nothing resolved
  })

  it('shows the treatment goals as they stand today, apart from the period', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('radio', { name: 'Treatment goals' }))

    expect(await screen.findByText('1 of 2', { exact: false })).toHaveTextContent(
      '1 of 2 goals (50%)',
    )
    expect(screen.getByText(/As of today, 23 October\./)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Goals achieved' })).toHaveAttribute(
      'aria-valuetext',
      '1 of 2 goals achieved',
    )
  })

  it('says there is no data in the period, rather than 0%', async () => {
    api.fetchRecoveryLogs.mockResolvedValue([])
    api.fetchAllDoses.mockResolvedValue([])
    renderPanel()

    expect(await screen.findAllByText('No data in this period.')).toHaveLength(2)
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('reads the full 30 days when the period changes', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('70%')

    await user.click(screen.getByRole('radio', { name: '30 days' }))

    expect(api.fetchAllDoses).toHaveBeenLastCalledWith({
      patientId: 'p-alice',
      from: startOfDay(subDays(TODAY, 29)).toISOString(),
      to: endOfDay(TODAY).toISOString(),
    })
    expect(await screen.findByText('24 September – 23 October 2026')).toBeInTheDocument()
    expect(await screen.findByText('Based on 5 of 30 days with records.')).toBeInTheDocument()
  })

  it('keeps the mood chart when medication records fail, and withholds only the overall score', async () => {
    const user = userEvent.setup()
    api.fetchAllDoses.mockRejectedValue(new Error('Failed to fetch'))
    renderPanel()

    const problem = await screen.findByRole('alert')
    expect(problem).toHaveTextContent('Medication records could not be loaded.')
    expect(screen.queryByText('70%')).not.toBeInTheDocument()
    expect(screen.getByText('Average reported mood')).toBeInTheDocument()

    api.fetchAllDoses.mockResolvedValue(DOSES)
    await user.click(within(problem).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('70%')).toBeInTheDocument()
    expect(api.fetchAllDoses).toHaveBeenCalledTimes(2)
  })

  it('reads each day from the keyboard, announcing it', async () => {
    const user = userEvent.setup()
    renderPanel()

    const chart = await screen.findByRole('group', {
      name: /Overall recovery progress by day/,
    })
    const status = chart.querySelector('[data-chart-announcement]')!
    expect(status).toHaveAttribute('aria-live', 'polite')

    // Arriving on the chart starts on the latest day with a value.
    act(() => chart.focus())
    expect(status).toHaveTextContent('Today, 88%, Mood 75%, Medication 100%')

    await user.keyboard('{ArrowLeft}')
    expect(status).toHaveTextContent('Yesterday, No data, No rating and no resolved doses')

    await user.keyboard('{Home}')
    expect(status).toHaveTextContent('Sat 17 October, 75%, Mood 50%, Medication 100%')

    await user.keyboard('{End}')
    expect(status).toHaveTextContent(/^Today, 88%/)
  })

  it('puts every day in a data table on request', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('70%')

    const toggle = screen.getByRole('button', { name: 'Show the data table' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)

    const table = screen.getByRole('table', {
      name: 'Recovery progress by day, 17–23 October 2026',
    })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(8)
    expect(rows[1]).toHaveTextContent('Sat 17 October3 of 5, Okay100% (1 of 1 dose taken)75%')
    expect(rows[6]).toHaveTextContent('YesterdayNo ratingNo doses dueNo data')
    expect(screen.getByRole('button', { name: 'Hide the data table' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })
})

describe('keeping current', () => {
  // The application's own defaults: no refetch on focus unless a query asks.
  const appLikeClient = () =>
    new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(TODAY)
  })

  it('refreshes the clinician’s copy every minute and when the window regains focus', async () => {
    renderPanel({ live: true, client: appLikeClient() })
    await screen.findByText('70%')
    expect(api.fetchRecoveryLogs).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(api.fetchRecoveryLogs).toHaveBeenCalledTimes(2)
    expect(api.fetchAllDoses).toHaveBeenCalledTimes(2)
    expect(api.fetchTreatmentPlans).toHaveBeenCalledTimes(2)

    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect(api.fetchRecoveryLogs).toHaveBeenCalledTimes(3)
  })

  it('leaves the patient’s copy to the writes that change it', async () => {
    renderPanel({ client: appLikeClient() })
    await screen.findByText('70%')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })

    expect(api.fetchRecoveryLogs).toHaveBeenCalledTimes(1)
    expect(api.fetchAllDoses).toHaveBeenCalledTimes(1)
    expect(api.fetchTreatmentPlans).toHaveBeenCalledTimes(1)
  })
})
