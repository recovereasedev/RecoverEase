import type { AppointmentWithPatient } from '@/features/appointments/api'
import { zonedDayAndTime } from '@/features/calendar/calendar-model'
import type { DoseWithSchedule } from '@/features/medications/api'
import type { TreatmentGoal } from '@/features/treatment-plans/api'
import {
  appointmentStatus,
  medicationLogStatus,
  treatmentGoalStatus,
  type StatusDescriptor,
} from '@/lib/status'

import type { RecoveryActivity, RecoveryPhase, Roadmap } from './api'

/**
 * The roadmap's arithmetic, in one place for the patient's page, the
 * doctor's editor and the progress charts, so all three say the same thing.
 *
 * What counts towards a roadmap's progress, and only this:
 *
 *   - the activities the doctor assigned in its current phases, done when
 *     the patient has marked them done;
 *   - the plan's treatment goals, each in its own Recovery and Monitoring
 *     phase (migration 56), done when the patient has marked them achieved.
 *
 *   progress = (activities done + linked goals achieved)
 *              / (activities + linked goals) × 100
 *
 * Doses, appointments and mood check-ins are never counted: they are shown
 * as upcoming tasks, and adherence and mood keep their own charts. Each plan
 * has its own progress; plans are never added together. With nothing to
 * count there is no percentage at all - "No activities yet" - rather than a
 * 0% that would read as no progress made.
 *
 * This is a measure of progress only. A roadmap fully done does not complete
 * the treatment plan or discharge the patient: that stays the doctor's
 * clinical decision.
 */

export type RoadmapCount = {
  done: number
  total: number
  remaining: number
  /** Rounded to a whole percent; null with nothing to count. */
  percentage: number | null
}

export function countItems(activities: readonly RecoveryActivity[], goals: readonly TreatmentGoal[]): RoadmapCount {
  const done =
    activities.filter((activity) => activity.recovery_activity_completed_at !== null).length +
    goals.filter((goal) => goal.treatment_goal_status === 'achieved').length
  const total = activities.length + goals.length
  return {
    done,
    total,
    remaining: total - done,
    percentage: total === 0 ? null : Math.round((done / total) * 100),
  }
}

export type PhaseKind = NonNullable<RecoveryPhase['recovery_phase_kind']>

/** The three kinds of generated phase (migration 56), as patients and doctors read them. */
export const PHASE_KIND_LABEL: Record<PhaseKind, string> = {
  initial: 'Initial Recovery',
  goal: 'Recovery and Monitoring',
  follow_up: 'Follow-up and Assessment',
}

export type PhaseStatus = 'completed' | 'in_progress' | 'upcoming'

// The goal statuses' icons and tones, so a phase and a goal in the same
// state look the same.
export const PHASE_STATUS: Record<PhaseStatus, StatusDescriptor> = {
  completed: { ...treatmentGoalStatus.achieved, label: 'Completed' },
  in_progress: { ...treatmentGoalStatus.in_progress, label: 'In progress' },
  upcoming: { ...treatmentGoalStatus.pending, label: 'Upcoming' },
}

/**
 * A phase's state, from what has been done in it and its own dates:
 *
 *   - Completed: everything counted in it is done (and there is something).
 *   - In progress: something in it is done, or its start date has come.
 *   - Upcoming: nothing in it is done yet, and it has not started.
 */
export function phaseStatus(phase: RecoveryPhase, count: RoadmapCount, today: string): PhaseStatus {
  if (count.total > 0 && count.done === count.total) return 'completed'
  if (count.done > 0) return 'in_progress'
  if (phase.recovery_phase_start_date !== null && phase.recovery_phase_start_date <= today) return 'in_progress'
  return 'upcoming'
}

export type RoadmapPhase = {
  phase: RecoveryPhase
  /** 1, 2, 3… by position: Initial Recovery first, Follow-up and Assessment last. */
  number: number
  kind: PhaseKind
  /** A Recovery and Monitoring phase's own goal, read from the goal itself; null otherwise. */
  goal: TreatmentGoal | null
  activities: RecoveryActivity[]
  goals: TreatmentGoal[]
  count: RoadmapCount
  status: PhaseStatus
}

export type PlanRoadmap = {
  phases: RoadmapPhase[]
  count: RoadmapCount
}

/** One plan's roadmap: its phases in order, each with its items and state. */
export function planRoadmap(
  planId: string,
  goals: readonly TreatmentGoal[],
  roadmap: Roadmap,
  today: string,
): PlanRoadmap {
  const phases = roadmap.phases
    .filter((phase) => phase.treatment_plan_id === planId)
    .sort((a, b) => a.recovery_phase_order - b.recovery_phase_order)

  const built = phases.map((phase, index) => {
    const activities = roadmap.activities
      .filter((activity) => activity.recovery_phase_id === phase.recovery_phase_id)
      .sort((a, b) => a.recovery_activity_order - b.recovery_activity_order)
    const linked = goals.filter((goal) => goal.recovery_phase_id === phase.recovery_phase_id)
    const count = countItems(activities, linked)
    return {
      phase,
      number: index + 1,
      // Every current phase has a kind from migration 56 on.
      kind: phase.recovery_phase_kind ?? 'initial',
      goal: goals.find((goal) => goal.treatment_goal_id === phase.treatment_goal_id) ?? null,
      activities,
      goals: linked,
      count,
      status: phaseStatus(phase, count, today),
    }
  })

  return {
    phases: built,
    count: countItems(
      built.flatMap((phase) => phase.activities),
      built.flatMap((phase) => phase.goals),
    ),
  }
}

/** A phase's heading: its kind, and for a goal's phase the goal itself. */
export function phaseHeading(item: Pick<RoadmapPhase, 'kind' | 'goal'>): string {
  const label = PHASE_KIND_LABEL[item.kind]
  return item.kind === 'goal' && item.goal ? `${label}: ${item.goal.treatment_goal_description}` : label
}

/**
 * The appointment the doctor chose as the plan's follow-up, as it is now -
 * its date and status read from the appointment. Null when none was chosen;
 * undefined when one was chosen but is not among `appointments` (still
 * loading, or unreadable), which must never be shown as "none chosen". No
 * other appointment is ever taken for it.
 */
export function followUpAppointment<T extends { appointment_id: string }>(
  plan: { treatment_plan_follow_up_appointment_id: string | null },
  appointments: readonly T[],
): T | null | undefined {
  const id = plan.treatment_plan_follow_up_appointment_id
  return id === null ? null : appointments.find((appointment) => appointment.appointment_id === id)
}

// ---------------------------------------------------------------------------
// Upcoming tasks
// ---------------------------------------------------------------------------

export type UpcomingTaskKind = 'activity' | 'dose' | 'appointment' | 'goal'

export type UpcomingTask = {
  id: string
  kind: UpcomingTaskKind
  /** `YYYY-MM-DD`, in the clinic's time zone. */
  day: string
  /** `HH:mm` where the item has a time; activities and goals have only a day. */
  time: string | null
  title: string
  status: StatusDescriptor
  /** Where the item lives and is acted on: the roadmap never copies it. */
  href: string
}

const OPEN_ACTIVITY: StatusDescriptor = { ...treatmentGoalStatus.pending, label: 'To do' }

/**
 * What is coming up, from where each already lives: the plan's activities
 * not yet done and its goals still open, by their target dates; doses still
 * pending; and appointments still scheduled or confirmed. Today through
 * `days` days ahead, soonest first, at most `limit`.
 */
export function upcomingTasks(input: {
  roadmaps: readonly PlanRoadmap[]
  goals: readonly TreatmentGoal[]
  doses: readonly DoseWithSchedule[]
  appointments: readonly AppointmentWithPatient[]
  today: string
  lastDay: string
  now: number
  zone: string
  limit?: number
}): UpcomingTask[] {
  const inWindow = (day: string) => day >= input.today && day <= input.lastDay
  const tasks: UpcomingTask[] = []

  for (const roadmap of input.roadmaps) {
    for (const phase of roadmap.phases) {
      for (const activity of phase.activities) {
        const day = activity.recovery_activity_target_date
        if (activity.recovery_activity_completed_at !== null || day === null || !inWindow(day)) continue
        tasks.push({
          id: `activity-${activity.recovery_activity_id}`,
          kind: 'activity',
          day,
          time: null,
          title: activity.recovery_activity_title,
          status: OPEN_ACTIVITY,
          href: `#activity-${activity.recovery_activity_id}`,
        })
      }
    }
  }

  for (const goal of input.goals) {
    const day = goal.treatment_goal_target_date
    const open = goal.treatment_goal_status === 'pending' || goal.treatment_goal_status === 'in_progress'
    if (!open || day === null || !inWindow(day)) continue
    tasks.push({
      id: `goal-${goal.treatment_goal_id}`,
      kind: 'goal',
      day,
      time: null,
      title: goal.treatment_goal_description,
      status: treatmentGoalStatus[goal.treatment_goal_status],
      href: '/patient/treatment',
    })
  }

  for (const dose of input.doses) {
    if (dose.medication_log_status !== 'pending') continue
    if (new Date(dose.medication_log_scheduled_at).getTime() < input.now) continue
    const at = zonedDayAndTime(dose.medication_log_scheduled_at, input.zone)
    if (!at || !inWindow(at.day)) continue
    const schedule = dose.medication_schedule
    tasks.push({
      id: `dose-${dose.medication_log_id}`,
      kind: 'dose',
      day: at.day,
      time: at.time,
      title: schedule
        ? `${schedule.medication_schedule_name}, ${schedule.medication_schedule_dosage}`
        : 'Medicine',
      status: { ...medicationLogStatus.pending, label: 'Due' },
      href: '/patient/medications',
    })
  }

  for (const appointment of input.appointments) {
    if (appointment.appointment_status !== 'scheduled' && appointment.appointment_status !== 'confirmed') continue
    if (new Date(appointment.appointment_date).getTime() < input.now) continue
    const at = zonedDayAndTime(appointment.appointment_date, input.zone)
    if (!at || !inWindow(at.day)) continue
    tasks.push({
      id: `appointment-${appointment.appointment_id}`,
      kind: 'appointment',
      day: at.day,
      time: at.time,
      title: 'Follow-up appointment',
      status: appointmentStatus[appointment.appointment_status],
      href: '/patient/appointments',
    })
  }

  // Soonest first; a day's untimed items before its timed ones.
  tasks.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.title.localeCompare(b.title),
  )
  return tasks.slice(0, input.limit ?? 8)
}

// ---------------------------------------------------------------------------
// The charts: what happened in a period
// ---------------------------------------------------------------------------

/**
 * For the progress charts: activities whose current completion falls in
 * the period - each counted once, however often it was marked and undone -
 * and goals achieved in it according to the recorded history, where the
 * goal is still achieved. A goal achieved before that history began
 * (migration 45) has no date and is not counted in any period.
 */
export function completedInPeriod(input: {
  activities: readonly RecoveryActivity[]
  goals: readonly TreatmentGoal[]
  achievedAt: ReadonlyMap<string, string>
  from: string
  to: string
}): { activities: RecoveryActivity[]; goals: TreatmentGoal[] } {
  // As instants: the database writes `+00:00` where a period's bounds say `Z`.
  const from = Date.parse(input.from)
  const to = Date.parse(input.to)
  const within = (at: string) => {
    const time = Date.parse(at)
    return time >= from && time <= to
  }
  return {
    activities: input.activities.filter(
      (activity) => activity.recovery_activity_completed_at !== null && within(activity.recovery_activity_completed_at),
    ),
    goals: input.goals.filter((goal) => {
      const at = input.achievedAt.get(goal.treatment_goal_id)
      return goal.treatment_goal_status === 'achieved' && at !== undefined && within(at)
    }),
  }
}

/**
 * When each goal was last recorded as achieved, from its status history -
 * the latest change to achieved, so a goal reopened and achieved again
 * counts on its latest date only.
 */
export function lastAchieved(
  events: readonly { treatment_goal_id: string; treatment_goal_new_status: string; treatment_goal_changed_at: string }[],
): Map<string, string> {
  const latest = new Map<string, string>()
  for (const event of events) {
    if (event.treatment_goal_new_status !== 'achieved') continue
    const seen = latest.get(event.treatment_goal_id)
    if (seen === undefined || Date.parse(event.treatment_goal_changed_at) > Date.parse(seen)) {
      latest.set(event.treatment_goal_id, event.treatment_goal_changed_at)
    }
  }
  return latest
}
