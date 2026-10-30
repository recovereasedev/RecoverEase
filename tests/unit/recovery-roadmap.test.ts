import { describe, expect, it } from 'vitest'

import type { RecoveryActivity, RecoveryPhase } from '@/features/recovery-roadmap/api'
import {
  completedInPeriod,
  countItems,
  lastAchieved,
  phaseStatus,
  planRoadmap,
  upcomingTasks,
} from '@/features/recovery-roadmap/roadmap'
import type { TreatmentGoal } from '@/features/treatment-plans/api'

/**
 * The roadmap's arithmetic (`roadmap.ts`), which the patient's page, the
 * doctor's editor and the progress charts all use: what counts towards a
 * plan's progress, a phase's state, what is coming up, and what was done in
 * a period - from the records as they are, never invented.
 */

const TODAY = '2026-11-04'

const phase = (id: string, order: number, overrides: Partial<RecoveryPhase> = {}): RecoveryPhase => ({
  recovery_phase_id: id,
  treatment_plan_id: 'plan-1',
  recovery_phase_title: `Phase ${id}`,
  recovery_phase_description: null,
  recovery_phase_order: order,
  recovery_phase_start_date: null,
  recovery_phase_target_end_date: null,
  recovery_phase_archived_at: null,
  recovery_phase_created_at: '2026-10-01T00:00:00Z',
  recovery_phase_updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
})

const activity = (id: string, phaseId: string, order: number, overrides: Partial<RecoveryActivity> = {}): RecoveryActivity => ({
  recovery_activity_id: id,
  recovery_phase_id: phaseId,
  recovery_activity_title: `Activity ${id}`,
  recovery_activity_description: null,
  recovery_activity_target_date: null,
  recovery_activity_order: order,
  recovery_activity_completed_at: null,
  recovery_activity_completed_by: null,
  recovery_activity_archived_at: null,
  recovery_activity_created_at: '2026-10-01T00:00:00Z',
  recovery_activity_updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
})

const goal = (id: string, overrides: Partial<TreatmentGoal> = {}): TreatmentGoal => ({
  treatment_goal_id: id,
  treatment_plan_id: 'plan-1',
  treatment_goal_description: `Goal ${id}`,
  treatment_goal_target_date: null,
  treatment_goal_status: 'pending',
  treatment_goal_created_at: '2026-10-01T00:00:00Z',
  recovery_phase_id: null,
  ...overrides,
})

const done = { recovery_activity_completed_at: '2026-11-02T03:00:00+00:00', recovery_activity_completed_by: 'u-alice' }

describe('what counts towards a roadmap', () => {
  it('is the assigned activities marked done and the linked goals achieved, out of all of them', () => {
    const count = countItems(
      [activity('a', 'p', 1, done), activity('b', 'p', 2), activity('c', 'p', 3, done)],
      [goal('g1', { treatment_goal_status: 'achieved' }), goal('g2', { treatment_goal_status: 'in_progress' })],
    )
    // (2 activities + 1 goal) / (3 + 2) = 60%.
    expect(count).toEqual({ done: 3, total: 5, remaining: 2, percentage: 60 })
  })

  it('has no percentage at all when there is nothing to count - never 0% or a division by zero', () => {
    expect(countItems([], [])).toEqual({ done: 0, total: 0, remaining: 0, percentage: null })
  })

  it('counts a goal in progress or not met as not done', () => {
    const count = countItems([], [goal('g1', { treatment_goal_status: 'in_progress' }), goal('g2', { treatment_goal_status: 'missed' })])
    expect(count.done).toBe(0)
    expect(count.percentage).toBe(0)
  })
})

describe('a plan’s roadmap', () => {
  const roadmap = {
    phases: [phase('second', 2), phase('first', 1), phase('elsewhere', 1, { treatment_plan_id: 'plan-2' })],
    activities: [
      activity('b', 'first', 2),
      activity('a', 'first', 1, done),
      activity('c', 'second', 1),
      activity('x', 'elsewhere', 1, done),
    ],
  }
  const goals = [goal('linked', { recovery_phase_id: 'second', treatment_goal_status: 'achieved' }), goal('loose')]

  it('lays its own phases out in the doctor’s order, numbered, each with its own items', () => {
    const built = planRoadmap('plan-1', goals, roadmap, TODAY)
    expect(built.phases.map((item) => [item.number, item.phase.recovery_phase_id])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
    expect(built.phases[0]!.activities.map((item) => item.recovery_activity_id)).toEqual(['a', 'b'])
    expect(built.phases[1]!.goals.map((item) => item.treatment_goal_id)).toEqual(['linked'])
  })

  it('counts only this plan, and only goals placed in a phase', () => {
    const built = planRoadmap('plan-1', goals, roadmap, TODAY)
    // a (done), b, c, and the linked goal (achieved): 2 of 4. The other
    // plan's activity and the goal in no phase are not counted.
    expect(built.count).toEqual({ done: 2, total: 4, remaining: 2, percentage: 50 })
    expect(built.unlinkedGoals.map((item) => item.treatment_goal_id)).toEqual(['loose'])
  })
})

describe('a phase’s state', () => {
  const count = (finished: number, total: number) =>
    countItems(
      Array.from({ length: total }, (_, index) => activity(String(index), 'p', index + 1, index < finished ? done : {})),
      [],
    )

  it('is completed when everything in it is done', () => {
    expect(phaseStatus(phase('p', 1), count(2, 2), TODAY)).toBe('completed')
  })

  it('is in progress once something is done, or once its start date has come', () => {
    expect(phaseStatus(phase('p', 1), count(1, 3), TODAY)).toBe('in_progress')
    expect(phaseStatus(phase('p', 1, { recovery_phase_start_date: TODAY }), count(0, 3), TODAY)).toBe('in_progress')
  })

  it('is upcoming while nothing is done and it has not started - including a phase with nothing in it', () => {
    expect(phaseStatus(phase('p', 1, { recovery_phase_start_date: '2026-12-01' }), count(0, 3), TODAY)).toBe('upcoming')
    expect(phaseStatus(phase('p', 1), count(0, 0), TODAY)).toBe('upcoming')
  })
})

describe('upcoming tasks', () => {
  const now = Date.parse('2026-11-04T02:00:00Z') // 10:00 in Manila
  const built = planRoadmap(
    'plan-1',
    [],
    {
      phases: [phase('p', 1)],
      activities: [
        activity('soon', 'p', 1, { recovery_activity_target_date: '2026-11-06' }),
        activity('finished', 'p', 2, { ...done, recovery_activity_target_date: '2026-11-05' }),
        activity('far', 'p', 3, { recovery_activity_target_date: '2026-12-25' }),
        activity('undated', 'p', 4),
      ],
    },
    TODAY,
  )

  it('gathers activities, goals, doses and appointments from where they live, soonest first, with links there', () => {
    const tasks = upcomingTasks({
      roadmaps: [built],
      goals: [
        goal('open', { treatment_goal_target_date: '2026-11-05', treatment_goal_status: 'in_progress' }),
        goal('achieved', { treatment_goal_target_date: '2026-11-05', treatment_goal_status: 'achieved' }),
      ],
      doses: [
        {
          medication_log_id: 'due',
          medication_schedule_id: 'ms',
          medication_log_scheduled_at: '2026-11-04T12:00:00Z',
          medication_log_taken_at: null,
          medication_log_status: 'pending',
          medication_schedule: { medication_schedule_id: 'ms', medication_schedule_name: 'Amoxicillin', medication_schedule_dosage: '500 mg' },
        },
        {
          medication_log_id: 'past',
          medication_schedule_id: 'ms',
          medication_log_scheduled_at: '2026-11-04T00:00:00Z',
          medication_log_taken_at: null,
          medication_log_status: 'pending',
          medication_schedule: null,
        },
      ] as never,
      appointments: [
        { appointment_id: 'visit', pat_id: 'p', doc_id: 'd', appointment_date: '2026-11-07T06:00:00Z', appointment_status: 'confirmed' },
        { appointment_id: 'cancelled', pat_id: 'p', doc_id: 'd', appointment_date: '2026-11-07T06:00:00Z', appointment_status: 'cancelled' },
      ] as never,
      today: TODAY,
      lastDay: '2026-11-17',
      now,
      zone: 'Asia/Manila',
    })

    expect(tasks.map((task) => [task.kind, task.day, task.time, task.href])).toEqual([
      ['dose', '2026-11-04', '20:00', '/patient/medications'],
      ['goal', '2026-11-05', null, '/patient/treatment'],
      ['activity', '2026-11-06', null, '#activity-soon'],
      ['appointment', '2026-11-07', '14:00', '/patient/appointments'],
    ])
    expect(tasks[0]!.title).toBe('Amoxicillin, 500 mg')
  })
})

describe('what was done in a period', () => {
  const from = '2026-10-28T16:00:00.000Z'
  const to = '2026-11-04T15:59:59.999Z'

  it('counts each activity once, by when it is currently marked done, comparing instants not text', () => {
    const result = completedInPeriod({
      activities: [
        activity('in', 'p', 1, { ...done, recovery_activity_completed_at: '2026-11-01T00:00:00+00:00' }),
        activity('before', 'p', 2, { ...done, recovery_activity_completed_at: '2026-10-28T15:59:59+00:00' }),
        activity('undone', 'p', 3),
      ],
      goals: [],
      achievedAt: new Map(),
      from,
      to,
    })
    expect(result.activities.map((item) => item.recovery_activity_id)).toEqual(['in'])
  })

  it('counts a goal on the day it was last recorded achieved, and never one with no recorded day', () => {
    const achievedAt = lastAchieved([
      { treatment_goal_id: 'again', treatment_goal_new_status: 'achieved', treatment_goal_changed_at: '2026-10-20T00:00:00+00:00' },
      { treatment_goal_id: 'again', treatment_goal_new_status: 'in_progress', treatment_goal_changed_at: '2026-10-25T00:00:00+00:00' },
      { treatment_goal_id: 'again', treatment_goal_new_status: 'achieved', treatment_goal_changed_at: '2026-11-02T00:00:00+00:00' },
      { treatment_goal_id: 'reopened', treatment_goal_new_status: 'achieved', treatment_goal_changed_at: '2026-11-01T00:00:00+00:00' },
    ])
    expect(achievedAt.get('again')).toBe('2026-11-02T00:00:00+00:00')

    const result = completedInPeriod({
      activities: [],
      goals: [
        goal('again', { treatment_goal_status: 'achieved' }),
        // Achieved in the period, but reopened since: not achieved now.
        goal('reopened', { treatment_goal_status: 'in_progress' }),
        // Achieved before history was kept: no day, so in no period.
        goal('before-history', { treatment_goal_status: 'achieved' }),
      ],
      achievedAt,
      from,
      to,
    })
    expect(result.goals.map((item) => item.treatment_goal_id)).toEqual(['again'])
  })
})
