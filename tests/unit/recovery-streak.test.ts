import { describe, expect, it } from 'vitest'

import { calculateStreak } from '@/features/recovery-logs/api'

/**
 * Module 5.12 "View Recovery Streak".
 *
 * The streak is the one number on the patient dashboard that is computed
 * rather than fetched, so it is the one that can silently be wrong. These
 * cases pin down the boundaries: what breaks a streak, what does not, and
 * what happens around midnight and across a timezone offset.
 */
const asLogs = (dates: string[]) =>
  dates.map((recovery_log_date) => ({ recovery_log_date }))

describe('calculateStreak', () => {
  const today = new Date(2026, 8, 2) // 2 September 2026, local time

  it('is zero when nothing has been logged', () => {
    expect(calculateStreak([], today)).toBe(0)
  })

  it('counts a single entry made today', () => {
    expect(calculateStreak(asLogs(['2026-09-02']), today)).toBe(1)
  })

  it('counts consecutive days ending today', () => {
    expect(
      calculateStreak(
        asLogs(['2026-09-02', '2026-09-01', '2026-08-31']),
        today,
      ),
    ).toBe(3)
  })

  it('keeps the streak alive when today is not logged yet', () => {
    // Someone who logged yesterday but has not opened the app this morning
    // still has a streak. Zeroing it before the day is over would punish them
    // for being early.
    expect(
      calculateStreak(asLogs(['2026-09-01', '2026-08-31']), today),
    ).toBe(2)
  })

  it('breaks when both today and yesterday are missing', () => {
    expect(calculateStreak(asLogs(['2026-08-31', '2026-08-30']), today)).toBe(0)
  })

  it('stops at the first gap rather than counting every entry', () => {
    expect(
      calculateStreak(
        asLogs(['2026-09-02', '2026-09-01', '2026-08-28', '2026-08-27']),
        today,
      ),
    ).toBe(2)
  })

  it('counts across a month boundary', () => {
    expect(
      calculateStreak(
        asLogs(['2026-09-02', '2026-09-01', '2026-08-31', '2026-08-30']),
        today,
      ),
    ).toBe(4)
  })

  it('is not confused by unordered input', () => {
    expect(
      calculateStreak(
        asLogs(['2026-08-31', '2026-09-02', '2026-09-01']),
        today,
      ),
    ).toBe(3)
  })

  it('uses local dates, not UTC', () => {
    // 07:00 local in a UTC+8 zone is still the previous day in UTC. If the
    // implementation formatted dates with toISOString() it would look up
    // 2026-09-01 while the patient believes it is the 2nd, and report a
    // broken streak every morning.
    const earlyMorning = new Date(2026, 8, 2, 7, 0, 0)
    expect(calculateStreak(asLogs(['2026-09-02']), earlyMorning)).toBe(1)
  })

  it('handles a single day that is neither today nor yesterday', () => {
    expect(calculateStreak(asLogs(['2026-01-01']), today)).toBe(0)
  })
})
