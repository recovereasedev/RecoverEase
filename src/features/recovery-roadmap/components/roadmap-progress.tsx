import { Check, Target } from 'lucide-react'
import { parseISO } from 'date-fns'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { ProgressBar } from '@/components/ui/progress'
import { periodWindow, type ProgressRange } from '@/features/recovery-progress/progress'
import type { PlanWithGoals } from '@/features/treatment-plans/api'
import { formatDate } from '@/lib/format'

import { useGoalStatusEvents, useRoadmap } from '../hooks'
import { completedInPeriod, lastAchieved, planRoadmap } from '../roadmap'

/**
 * The progress panel's Roadmap view (migration 45), for the patient and
 * their clinician alike: each active plan's roadmap as it stands, and what
 * was done in it during the period the panel shows.
 *
 * The same records as the Recovery Roadmap page, read the same way: an
 * activity counts once, on the day the patient marked it done (and not at
 * all if they undid it); a goal counts on the day its status was last
 * recorded as achieved. Doses and mood are not part of it - they have
 * their own views above - and no date is invented for a goal achieved
 * before goal history was kept.
 */
export function RoadmapProgress({
  patientId,
  plans,
  range,
  today,
  period,
  live = false,
}: {
  patientId: string
  plans: readonly PlanWithGoals[]
  range: ProgressRange
  today: string
  period: string
  live?: boolean
}) {
  const active = plans.filter((plan) => plan.treatment_plan_status === 'active')
  const roadmapQuery = useRoadmap(patientId, active, { live })
  const bounds = periodWindow(range, parseISO(today))
  const goalIds = active.flatMap((plan) => plan.treatment_goal.map((goal) => goal.treatment_goal_id))
  const eventsQuery = useGoalStatusEvents(patientId, goalIds, bounds.from, { live })

  if (active.length === 0) {
    return <p className="text-sm text-muted">No active treatment plan, so there is no roadmap to show.</p>
  }
  if (roadmapQuery.isPending || eventsQuery.isPending) return <LoadingState label="Loading the roadmap…" />
  const error = roadmapQuery.error ?? eventsQuery.error
  if (error || !roadmapQuery.data || !eventsQuery.data) {
    return (
      <ErrorState
        error={error ?? new Error('No data was returned.')}
        onRetry={() => {
          void roadmapQuery.refetch()
          void eventsQuery.refetch()
        }}
      />
    )
  }

  const achievedAt = lastAchieved(eventsQuery.data)

  return (
    <div className="space-y-6">
      {active.map((plan) => {
        const roadmap = planRoadmap(plan.treatment_plan_id, plan.treatment_goal, roadmapQuery.data, today)
        const counted = {
          activities: roadmap.phases.flatMap((phase) => phase.activities),
          goals: roadmap.phases.flatMap((phase) => phase.goals),
        }
        const inPeriod = completedInPeriod({ ...counted, achievedAt, from: bounds.from, to: bounds.to })
        const headingId = `roadmap-progress-${plan.treatment_plan_id}`
        return (
          <section key={plan.treatment_plan_id} aria-labelledby={headingId}>
            <h4 id={headingId} className="font-semibold text-heading">
              {plan.treatment_plan_title}
            </h4>
            {roadmap.count.percentage === null ? (
              <p className="mt-1 text-sm text-muted">No activities yet</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted" data-numeric>
                  {roadmap.count.percentage}% of the roadmap done · {roadmap.count.done} of {roadmap.count.total}
                </p>
                <ProgressBar
                  className="mt-2"
                  value={roadmap.count.percentage}
                  tone="accent"
                  label={`Roadmap progress for ${plan.treatment_plan_title}`}
                  valueText={`${roadmap.count.done} of ${roadmap.count.total} done`}
                />
              </>
            )}

            <h5 className="mt-4 text-sm font-medium text-heading">Done in {period}</h5>
            {inPeriod.activities.length === 0 && inPeriod.goals.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Nothing on the roadmap was marked done in this period.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {inPeriod.activities.map((activity) => (
                  <li key={activity.recovery_activity_id} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-success-700" aria-hidden="true" />
                    <span>
                      {activity.recovery_activity_title}
                      <span className="text-muted" data-numeric>
                        {' '}
                        · activity, done {formatDate(activity.recovery_activity_completed_at)}
                      </span>
                    </span>
                  </li>
                ))}
                {inPeriod.goals.map((goal) => (
                  <li key={goal.treatment_goal_id} className="flex gap-2">
                    <Target className="mt-0.5 size-4 shrink-0 text-accent-700" aria-hidden="true" />
                    <span>
                      {goal.treatment_goal_description}
                      <span className="text-muted" data-numeric>
                        {' '}
                        · goal, achieved {formatDate(achievedAt.get(goal.treatment_goal_id))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      <p className="text-xs text-muted">
        How this is counted: the roadmap’s percentage is the activities the doctor assigned that are marked done,
        plus the goals placed in a phase that are achieved, out of all of them. Each activity counts once, on the day
        it was marked done; a goal counts on the day it was last recorded as achieved. Goals achieved before goal
        history was kept have no recorded day, so they appear in no period. Medicines and mood are measured
        separately, above.
      </p>
    </div>
  )
}
