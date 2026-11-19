import { endOfDay, format, parseISO, startOfDay, subDays } from 'date-fns'

import {
  summariseAdherence,
  type Adherence,
  type MedicationLog,
} from '@/features/medications/api'
import type { RecoveryLog } from '@/features/recovery-logs/api'
import {
  summariseGoals,
  type PlanWithGoals,
  type TreatmentGoalStatus,
} from '@/features/treatment-plans/api'
import { toDateKey } from '@/lib/format'

/**
 * Recovery progress (the 2nd-half plan's progress charts): every number the
 * charts and their headlines show is worked out here, from the rows the
 * existing queries return, so that the arithmetic can be tested apart from
 * anything drawn.
 *
 * Three rules run through all of it:
 *
 *   - A day is a calendar day in local time, as everywhere else in the
 *     browser: `toDateKey` is how a patient's entry is dated, and the 7-day
 *     adherence windows already run from the start of the day six days ago to
 *     the end of today.
 *   - Missing is never zero. A day with no rating has no mood score; a day
 *     with no resolved dose has no adherence; a day with neither has no
 *     overall score, and is left blank rather than drawn at 0%.
 *   - A headline is the arithmetic of the points it sits above. The overall
 *     headline is the mean of the daily scores plotted; nothing is weighted,
 *     carried forward or interpolated.
 *
 * Treatment goals are not part of the daily score. A goal records its status
 * now but not when it reached it, so there is no history to put on a date
 * axis; `goalSnapshot` describes the current state instead.
 */

export const PROGRESS_RANGES = [7, 30] as const
export type ProgressRange = (typeof PROGRESS_RANGES)[number]

/**
 * The calendar days of a period, oldest first: today and the `range - 1`
 * days before it, as `YYYY-MM-DD` keys.
 */
export function periodDays(range: ProgressRange, today: Date): string[] {
  const days: string[] = []
  for (let back = range - 1; back >= 0; back -= 1) {
    days.push(toDateKey(subDays(today, back)))
  }
  return days
}

/**
 * The instants a period's doses are read between: the start of its first day
 * to the end of today, local time - the same bounds the 7-day adherence
 * windows use.
 */
export function periodWindow(
  range: ProgressRange,
  today: Date,
): { from: string; to: string } {
  return {
    from: startOfDay(subDays(today, range - 1)).toISOString(),
    to: endOfDay(today).toISOString(),
  }
}

/** A 1-5 mood rating, as the database's check constraint allows it. */
export function isMoodRating(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
  )
}

/** A mood rating on the 0-100 scale: 1 is 0, 3 is 50, 5 is 100. */
export function moodScore(rating: number): number {
  return ((rating - 1) / 4) * 100
}

export type DoseCounts = {
  taken: number
  missed: number
  skipped: number
  /** Doses with no record yet: still to come, due now, or overdue. */
  pending: number
}

/**
 * The share of resolved doses taken, 0-100: taken ÷ (taken + missed +
 * skipped). Pending doses are not in the denominator - the rule
 * `summariseAdherence` follows - and with nothing resolved there is no rate.
 */
export function resolvedAdherence(
  counts: Pick<DoseCounts, 'taken' | 'missed' | 'skipped'>,
): number | null {
  const resolved = counts.taken + counts.missed + counts.skipped
  return resolved === 0 ? null : (counts.taken / resolved) * 100
}

/** The arithmetic mean, or null for no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export type DayProgress = {
  /** `YYYY-MM-DD`, local. */
  date: string
  /** The day's 1-5 rating, or null when none was recorded. */
  mood: number | null
  /** That rating on the 0-100 scale, or null. */
  moodScore: number | null
  doses: DoseCounts
  /** Doses that came due and were recorded: taken + missed + skipped. */
  resolved: number
  /** Taken ÷ resolved × 100, or null when no dose was resolved. */
  adherence: number | null
  /** The mean of whichever of `moodScore` and `adherence` exist, or null. */
  overall: number | null
}

type LogRow = Pick<RecoveryLog, 'recovery_log_date' | 'recovery_log_mood_rating'>
type DoseRow = Pick<MedicationLog, 'medication_log_status' | 'medication_log_scheduled_at'>

/**
 * One row per day of the period, in the period's order.
 *
 * A dose belongs to the local calendar day it was scheduled for. Rows
 * outside the period - and a dose whose time cannot be read - are ignored
 * rather than counted against some other day.
 */
export function dailyProgress(input: {
  days: readonly string[]
  logs: readonly LogRow[]
  doses: readonly DoseRow[]
}): DayProgress[] {
  const ratings = new Map<string, number>()
  for (const log of input.logs) {
    if (isMoodRating(log.recovery_log_mood_rating)) {
      ratings.set(log.recovery_log_date, log.recovery_log_mood_rating)
    }
  }

  const counts = new Map<string, DoseCounts>()
  for (const day of input.days) {
    counts.set(day, { taken: 0, missed: 0, skipped: 0, pending: 0 })
  }
  for (const dose of input.doses) {
    const day = counts.get(toDateKey(new Date(dose.medication_log_scheduled_at)))
    if (day) day[dose.medication_log_status] += 1
  }

  return input.days.map((date) => {
    const mood = ratings.get(date) ?? null
    const doses = counts.get(date) ?? { taken: 0, missed: 0, skipped: 0, pending: 0 }
    const score = mood === null ? null : moodScore(mood)
    const adherence = resolvedAdherence(doses)
    const available = [score, adherence].filter(
      (value): value is number => value !== null,
    )

    return {
      date,
      mood,
      moodScore: score,
      doses,
      resolved: doses.taken + doses.missed + doses.skipped,
      adherence,
      overall: mean(available),
    }
  })
}

export type ProgressSummary = {
  days: DayProgress[]
  overall: {
    /** The mean of the daily overall scores plotted, or null for none. */
    average: number | null
    /** Days with a mood rating, a resolved dose, or both. */
    daysWithData: number
  }
  mood: {
    /** The mean 1-5 rating of the rated days, or null for none. */
    average: number | null
    ratedDays: number
  }
  /**
   * Every dose in the period through `summariseAdherence`, so the 7-day
   * figure is the one the record's summary strip shows: taken ÷ resolved
   * across the whole period, not an average of the daily bars.
   */
  medication: Adherence & {
    /** Days with at least one resolved dose: the days that have a bar. */
    daysWithResolved: number
  }
}

export function summariseProgress(input: {
  days: readonly string[]
  logs: readonly LogRow[]
  doses: readonly MedicationLog[]
}): ProgressSummary {
  const days = dailyProgress(input)
  const period = new Set(input.days)
  const dosesInPeriod = input.doses.filter((dose) =>
    period.has(toDateKey(new Date(dose.medication_log_scheduled_at))),
  )

  const overall = days.flatMap((day) => (day.overall === null ? [] : [day.overall]))
  const ratings = days.flatMap((day) => (day.mood === null ? [] : [day.mood]))

  return {
    days,
    overall: { average: mean(overall), daysWithData: overall.length },
    mood: { average: mean(ratings), ratedDays: ratings.length },
    medication: {
      ...summariseAdherence(dosesInPeriod),
      daysWithResolved: days.filter((day) => day.adherence !== null).length,
    },
  }
}

export type GoalSnapshot = {
  /** Active plans only: a draft is not yet the patient's plan, and a finished one no longer is. */
  plans: {
    id: string
    title: string
    total: number
    achieved: number
    percentage: number | null
  }[]
  total: number
  achieved: number
  /** Achieved ÷ total, rounded as `summariseGoals` rounds it; null with no goals. */
  percentage: number | null
  byStatus: Record<TreatmentGoalStatus, number>
  /** Not started or in progress, with a target date before today. */
  pastTarget: number
  /** The earliest target date from today on among goals still open. */
  nextTarget: { description: string; date: string } | null
}

/**
 * The goals as they stand today, across the patient's active plans.
 *
 * Only a status is stored - no date a goal was achieved - so this is a
 * snapshot, and it says nothing about the period the charts are showing. A
 * target date is when a goal was planned for, not when anything happened.
 */
export function goalSnapshot(
  plans: readonly PlanWithGoals[],
  today: string,
): GoalSnapshot {
  const active = plans.filter((plan) => plan.treatment_plan_status === 'active')
  const goals = active.flatMap((plan) => plan.treatment_goal)
  const all = summariseGoals(goals)

  const byStatus: Record<TreatmentGoalStatus, number> = {
    pending: 0,
    in_progress: 0,
    achieved: 0,
    missed: 0,
  }
  for (const goal of goals) byStatus[goal.treatment_goal_status] += 1

  const open = goals.filter(
    (goal) =>
      goal.treatment_goal_status === 'pending' ||
      goal.treatment_goal_status === 'in_progress',
  )
  const upcoming = open
    .filter(
      (goal): goal is typeof goal & { treatment_goal_target_date: string } =>
        goal.treatment_goal_target_date !== null &&
        goal.treatment_goal_target_date >= today,
    )
    .sort((a, b) =>
      a.treatment_goal_target_date.localeCompare(b.treatment_goal_target_date),
    )[0]

  return {
    plans: active.map((plan) => ({
      id: plan.treatment_plan_id,
      title: plan.treatment_plan_title,
      ...summariseGoals(plan.treatment_goal),
    })),
    total: all.total,
    achieved: all.achieved,
    percentage: all.percentage,
    byStatus,
    pastTarget: open.filter(
      (goal) =>
        goal.treatment_goal_target_date !== null &&
        goal.treatment_goal_target_date < today,
    ).length,
    nextTarget: upcoming
      ? {
          description: upcoming.treatment_goal_description,
          date: upcoming.treatment_goal_target_date,
        }
      : null,
  }
}

/** A 0-100 score as shown: a whole percentage. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

/** A mean 1-5 rating as shown: one decimal place. */
export function formatMoodAverage(value: number): string {
  return value.toFixed(1)
}

/**
 * The period as a date range: "17–23 October 2026", "24 September – 23
 * October 2026", or across a new year "29 December 2025 – 4 January 2026".
 * Written out in words, never numerically, as every date in the application
 * is.
 */
export function formatPeriod(days: readonly string[]): string {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return ''
  const start = parseISO(first)
  const end = parseISO(last)

  if (start.getFullYear() !== end.getFullYear()) {
    return `${format(start, 'd MMMM yyyy')} – ${format(end, 'd MMMM yyyy')}`
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${format(start, 'd MMMM')} – ${format(end, 'd MMMM yyyy')}`
  }
  return `${format(start, 'd')}–${format(end, 'd MMMM yyyy')}`
}
