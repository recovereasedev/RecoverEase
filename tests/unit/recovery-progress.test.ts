import { endOfDay, startOfDay, startOfToday, subDays } from 'date-fns'
import { describe, expect, it } from 'vitest'

import { summariseAdherence, type MedicationLog } from '@/features/medications/api'
import type { PlanWithGoals, TreatmentGoal } from '@/features/treatment-plans/api'
import {
  dailyProgress,
  formatMoodAverage,
  formatPercent,
  formatPeriod,
  goalSnapshot,
  isMoodRating,
  mean,
  moodScore,
  periodDays,
  periodWindow,
  resolvedAdherence,
  summariseProgress,
} from '@/features/recovery-progress/progress'

/**
 * The arithmetic behind the recovery progress charts (src/features/
 * recovery-progress/progress.ts): the period's days, the mood and adherence
 * scores, the daily overall score, coverage, the headlines and the goal
 * snapshot. Every case is in local time, mid-morning, so none sits on a
 * date boundary by accident; the boundary cases are written on purpose.
 */

const TODAY = new Date(2026, 9, 23, 10, 30) // Friday 23 October 2026

function dayKey(daysAgo: number, from: Date = TODAY): string {
  const date = subDays(from, daysAgo)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function log(daysAgo: number, rating: number | null) {
  return { recovery_log_date: dayKey(daysAgo), recovery_log_mood_rating: rating }
}

let doseCount = 0
function dose(
  daysAgo: number,
  status: MedicationLog['medication_log_status'],
  hour = 8,
  minute = 0,
): MedicationLog {
  const when = subDays(TODAY, daysAgo)
  when.setHours(hour, minute, 0, 0)
  doseCount += 1
  return {
    medication_log_id: `dose-${doseCount}`,
    medication_schedule_id: 'schedule-1',
    medication_log_scheduled_at: when.toISOString(),
    medication_log_taken_at: null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: null,
  }
}

const week = periodDays(7, TODAY)

describe('the period', () => {
  it('is today and the six days before it for 7 days', () => {
    expect(week).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ])
  })

  it('is today and the twenty-nine days before it for 30 days', () => {
    const month = periodDays(30, TODAY)
    expect(month).toHaveLength(30)
    expect(month[0]).toBe('2026-09-24')
    expect(month.at(-1)).toBe('2026-10-23')
    expect(new Set(month).size).toBe(30)
  })

  it('runs across the end of a month and of a year', () => {
    expect(periodDays(7, new Date(2026, 9, 3, 10))[0]).toBe('2026-09-27')
    expect(periodDays(7, new Date(2026, 0, 2, 10))).toEqual([
      '2025-12-27',
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ])
  })

  it('reads doses from the start of its first day to the end of today, as the 7-day adherence windows do', () => {
    expect(periodWindow(7, TODAY)).toEqual({
      from: startOfDay(subDays(TODAY, 6)).toISOString(),
      to: endOfDay(TODAY).toISOString(),
    })
    expect(periodWindow(30, TODAY).from).toBe(startOfDay(subDays(TODAY, 29)).toISOString())

    // The expression the record page and the medications page use today.
    const now = new Date()
    expect(periodWindow(7, now).from).toBe(subDays(startOfToday(), 6).toISOString())
  })
})

describe('mood normalisation', () => {
  it('puts the 1-5 rating on a 0-100 scale', () => {
    expect([1, 2, 3, 4, 5].map(moodScore)).toEqual([0, 25, 50, 75, 100])
  })

  it('accepts only the ratings the database allows', () => {
    expect(isMoodRating(3)).toBe(true)
    expect(isMoodRating(null)).toBe(false)
    expect(isMoodRating(0)).toBe(false)
    expect(isMoodRating(6)).toBe(false)
    expect(isMoodRating(2.5)).toBe(false)
  })
})

describe('resolved-dose adherence', () => {
  it('is taken ÷ (taken + missed + skipped)', () => {
    expect(resolvedAdherence({ taken: 2, missed: 1, skipped: 0 })).toBeCloseTo(66.667, 2)
    expect(resolvedAdherence({ taken: 1, missed: 0, skipped: 1 })).toBe(50)
    expect(resolvedAdherence({ taken: 0, missed: 2, skipped: 0 })).toBe(0)
  })

  it('has no value when nothing was resolved', () => {
    expect(resolvedAdherence({ taken: 0, missed: 0, skipped: 0 })).toBeNull()
  })
})

describe('a day of progress', () => {
  it('averages the mood score and the adherence of the same day', () => {
    const [day] = dailyProgress({
      days: [dayKey(0)],
      logs: [log(0, 4)],
      doses: [dose(0, 'taken'), dose(0, 'taken', 12), dose(0, 'missed', 16)],
    })

    expect(day!.moodScore).toBe(75)
    expect(day!.adherence).toBeCloseTo(66.667, 2)
    expect(day!.overall).toBeCloseTo((75 + 200 / 3) / 2, 6)
  })

  it('leaves pending doses out of the denominator', () => {
    const [day] = dailyProgress({
      days: [dayKey(0)],
      logs: [],
      doses: [dose(0, 'taken'), dose(0, 'pending', 20)],
    })

    expect(day!.doses).toEqual({ taken: 1, missed: 0, skipped: 0, pending: 1 })
    expect(day!.resolved).toBe(1)
    expect(day!.adherence).toBe(100)
  })

  it('uses whichever of the two exists', () => {
    const [moodOnly, dosesOnly] = dailyProgress({
      days: [dayKey(1), dayKey(0)],
      logs: [log(1, 2)],
      doses: [dose(0, 'taken'), dose(0, 'missed', 20)],
    })

    expect(moodOnly!.overall).toBe(25)
    expect(dosesOnly!.overall).toBe(50)
  })

  it('treats a missing mood as missing, never as zero', () => {
    const [unrated, nullRating] = dailyProgress({
      days: [dayKey(1), dayKey(0)],
      logs: [log(0, null)],
      doses: [],
    })

    for (const day of [unrated!, nullRating!]) {
      expect(day.mood).toBeNull()
      expect(day.moodScore).toBeNull()
      expect(day.overall).toBeNull()
    }
  })

  it('has no adherence on a day whose doses are all still pending', () => {
    const [day] = dailyProgress({
      days: [dayKey(0)],
      logs: [log(0, 3)],
      doses: [dose(0, 'pending', 20), dose(0, 'pending', 22)],
    })

    expect(day!.adherence).toBeNull()
    // Mood alone carries the day; the pending doses do not pull it to zero.
    expect(day!.overall).toBe(50)
  })

  it('has no overall score on a day with neither', () => {
    const [day] = dailyProgress({ days: [dayKey(0)], logs: [], doses: [] })
    expect(day!.overall).toBeNull()
  })

  it('files a dose under the local day it was scheduled for', () => {
    const [yesterday, today] = dailyProgress({
      days: [dayKey(1), dayKey(0)],
      logs: [],
      doses: [dose(1, 'taken', 23, 30), dose(0, 'missed', 0, 15)],
    })

    expect(yesterday!.doses.taken).toBe(1)
    expect(yesterday!.doses.missed).toBe(0)
    expect(today!.doses.missed).toBe(1)
  })

  it('ignores rows outside the period and doses with an unreadable time', () => {
    const [day] = dailyProgress({
      days: [dayKey(0)],
      logs: [log(1, 5)],
      doses: [
        dose(1, 'missed'),
        { ...dose(0, 'missed'), medication_log_scheduled_at: 'not a time' },
      ],
    })

    expect(day!.mood).toBeNull()
    expect(day!.resolved).toBe(0)
  })
})

describe('the period summary', () => {
  it('makes the overall headline the mean of the daily points plotted', () => {
    const summary = summariseProgress({
      days: week,
      logs: [log(6, 3), log(5, 4), log(3, 5), log(0, 4)],
      doses: [
        dose(6, 'taken'),
        dose(5, 'missed'),
        dose(4, 'taken'),
        dose(4, 'skipped', 20),
        dose(0, 'taken'),
        dose(0, 'pending', 20),
      ],
    })

    const plotted = summary.days.flatMap((day) => (day.overall === null ? [] : [day.overall]))
    // 6 days ago: (50 + 100) / 2; 5: (75 + 0) / 2; 4: 50; 3: 100; 0: (75 + 100) / 2.
    expect(plotted).toEqual([75, 37.5, 50, 100, 87.5])
    expect(summary.overall.average).toBe(mean(plotted))
    expect(summary.overall.average).toBe(70)
    expect(formatPercent(summary.overall.average!)).toBe('70%')
  })

  it('counts the days with records as its coverage', () => {
    const summary = summariseProgress({
      days: week,
      logs: [log(6, 3), log(2, null)],
      doses: [dose(4, 'taken'), dose(1, 'pending')],
    })

    // A null rating and a pending-only day are not records of progress.
    expect(summary.overall.daysWithData).toBe(2)
    expect(summary.mood.ratedDays).toBe(1)
    expect(summary.medication.daysWithResolved).toBe(1)
  })

  it('has no headline, rather than 0%, for a period with no data', () => {
    const summary = summariseProgress({ days: week, logs: [], doses: [] })

    expect(summary.overall).toEqual({ average: null, daysWithData: 0 })
    expect(summary.mood.average).toBeNull()
    expect(summary.medication.rate).toBeNull()
  })

  it('averages the rated days for the mood headline: the reference design’s 3.9 / 5', () => {
    const summary = summariseProgress({
      days: week,
      logs: [3, 4, 3, 4, 4, 5, 4].map((rating, index) => log(6 - index, rating)),
      doses: [],
    })

    expect(summary.mood.average).toBeCloseTo(27 / 7, 10)
    expect(formatMoodAverage(summary.mood.average!)).toBe('3.9')
  })

  it('takes the medication headline from summariseAdherence over the period’s doses', () => {
    const inside = [dose(1, 'taken'), dose(0, 'taken'), dose(0, 'missed', 12), dose(0, 'missed', 16)]
    const summary = summariseProgress({
      days: week,
      logs: [],
      doses: [...inside, dose(10, 'missed')],
    })

    const { daysWithResolved, ...headline } = summary.medication
    expect(headline).toEqual(summariseAdherence(inside))
    expect(daysWithResolved).toBe(2)
    // Pooled - 2 of 4 doses - not the mean of the bars (100% and 33%).
    expect(summary.medication.rate).toBe(50)
  })

  it('includes a day 20 days ago over 30 days, and not over 7', () => {
    const rows = { logs: [log(20, 5)], doses: [dose(20, 'taken')] }

    expect(summariseProgress({ days: week, ...rows }).overall.daysWithData).toBe(0)
    expect(
      summariseProgress({ days: periodDays(30, TODAY), ...rows }).overall,
    ).toEqual({ average: 100, daysWithData: 1 })
  })
})

describe('the goal snapshot', () => {
  const TODAY_KEY = dayKey(0)

  function goal(
    id: string,
    status: TreatmentGoal['treatment_goal_status'],
    target: string | null,
  ): TreatmentGoal {
    return {
      treatment_goal_id: id,
      treatment_plan_id: 'plan',
      treatment_goal_description: `Goal ${id}`,
      treatment_goal_target_date: target,
      treatment_goal_status: status,
      treatment_goal_created_at: '2026-09-01T00:00:00Z',
    }
  }

  function plan(
    id: string,
    status: PlanWithGoals['treatment_plan_status'],
    goals: TreatmentGoal[],
  ): PlanWithGoals {
    return {
      treatment_plan_id: id,
      pat_id: 'p-1',
      doc_id: 'd-1',
      treatment_plan_title: `Plan ${id}`,
      treatment_plan_description: null,
      treatment_plan_start_date: '2026-09-01',
      treatment_plan_end_date: null,
      treatment_plan_status: status,
      treatment_plan_created_at: '2026-09-01T00:00:00Z',
      treatment_plan_updated_at: '2026-09-01T00:00:00Z',
      treatment_goal: goals,
    }
  }

  it('counts the goals of active plans only', () => {
    const snapshot = goalSnapshot(
      [
        plan('a', 'active', [goal('1', 'achieved', '2026-10-01'), goal('2', 'in_progress', null), goal('3', 'pending', null)]),
        plan('b', 'draft', [goal('4', 'achieved', null)]),
        plan('c', 'completed', [goal('5', 'achieved', null)]),
      ],
      TODAY_KEY,
    )

    expect(snapshot.plans.map((entry) => entry.id)).toEqual(['a'])
    expect(snapshot).toMatchObject({ total: 3, achieved: 1, percentage: 33 })
    expect(snapshot.byStatus).toEqual({ pending: 1, in_progress: 1, achieved: 1, missed: 0 })
  })

  it('adds up several active plans, keeping each plan’s own count', () => {
    const snapshot = goalSnapshot(
      [
        plan('a', 'active', [goal('1', 'achieved', null)]),
        plan('b', 'active', [goal('2', 'missed', null), goal('3', 'achieved', null)]),
      ],
      TODAY_KEY,
    )

    expect(snapshot).toMatchObject({ total: 3, achieved: 2, percentage: 67 })
    expect(snapshot.plans).toEqual([
      { id: 'a', title: 'Plan a', total: 1, achieved: 1, percentage: 100 },
      { id: 'b', title: 'Plan b', total: 2, achieved: 1, percentage: 50 },
    ])
  })

  it('tells open goals past their target date from the next one due', () => {
    const snapshot = goalSnapshot(
      [
        plan('a', 'active', [
          goal('late', 'in_progress', '2026-10-01'),
          goal('late-done', 'achieved', '2026-10-01'),
          goal('late-unmet', 'missed', '2026-10-01'),
          goal('due-today', 'pending', TODAY_KEY),
          goal('later', 'pending', '2026-11-30'),
        ]),
      ],
      TODAY_KEY,
    )

    // Only an open goal is late; achieved and not-met goals are settled.
    expect(snapshot.pastTarget).toBe(1)
    expect(snapshot.nextTarget).toEqual({ description: 'Goal due-today', date: TODAY_KEY })
  })

  it('is empty, with no percentage, without an active plan', () => {
    const snapshot = goalSnapshot([plan('a', 'completed', [goal('1', 'achieved', null)])], TODAY_KEY)

    expect(snapshot).toMatchObject({ plans: [], total: 0, achieved: 0, percentage: null, nextTarget: null })
  })
})

describe('formatting', () => {
  it('rounds scores to a whole percentage', () => {
    expect(formatPercent(70.83)).toBe('71%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(100)).toBe('100%')
  })

  it('writes the period out in words', () => {
    expect(formatPeriod(week)).toBe('17–23 October 2026')
    expect(formatPeriod(periodDays(30, TODAY))).toBe('24 September – 23 October 2026')
    expect(formatPeriod(periodDays(7, new Date(2026, 0, 2, 10)))).toBe(
      '27 December 2025 – 2 January 2026',
    )
  })
})
