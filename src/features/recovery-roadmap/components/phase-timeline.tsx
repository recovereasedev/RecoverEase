import { CalendarDays, Check, CircleDashed, RotateCcw, Target } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { ProgressBar } from '@/components/ui/progress'
import { formatDate } from '@/lib/format'
import { treatmentGoalStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

import type { RecoveryActivity } from '../api'
import { PHASE_STATUS, type PhaseStatus, type PlanRoadmap } from '../roadmap'

// The phase's number on the path, in its state: filled once completed,
// ringed while in progress, open until it starts - as the treatment plan
// page marks goals.
const MARKER: Record<PhaseStatus, string> = {
  completed: 'border-fill-success-600 bg-fill-success-600 text-white',
  in_progress: 'border-info-600 bg-info-50 text-info-700',
  upcoming: 'border-[var(--color-border-strong)] bg-surface text-neutral-600',
}

export function phaseDates(start: string | null, end: string | null): string | null {
  if (start && end) return `${formatDate(start)} — ${formatDate(end)}`
  if (start) return `From ${formatDate(start)}`
  if (end) return `By ${formatDate(end)}`
  return null
}

/**
 * Module 5.7: a plan's phases down a path, in the doctor's order, each with
 * its state, its dates, how much of it is done, and what is in it - the
 * activities the patient marks done, and the goals the doctor linked to it,
 * which only the doctor marks. Every state is said in words beside its
 * colour.
 */
export function PhaseTimeline({
  roadmap,
  onComplete,
  onReopen,
  savingId,
}: {
  roadmap: PlanRoadmap
  onComplete: (activity: RecoveryActivity) => void
  onReopen: (activity: RecoveryActivity) => void
  /** The activity being saved, if any: its button shows it, and no other takes a press. */
  savingId: string | null
}) {
  return (
    <ol className="space-y-0">
      {roadmap.phases.map((item, index) => {
        const isLast = index === roadmap.phases.length - 1
        const headingId = `phase-${item.phase.recovery_phase_id}`
        const dates = phaseDates(item.phase.recovery_phase_start_date, item.phase.recovery_phase_target_end_date)
        return (
          <li key={item.phase.recovery_phase_id} className={cn('relative flex gap-4', !isLast && 'pb-8')}>
            {!isLast ? (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute bottom-0 left-5 top-11 w-0.5 -translate-x-1/2 rounded-full',
                  item.status === 'completed' ? 'bg-success-600' : 'bg-[var(--color-border-strong)]',
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'relative flex size-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold',
                MARKER[item.status],
              )}
              data-numeric
            >
              {item.status === 'completed' ? <Check className="size-5" /> : item.number}
            </span>

            <section aria-labelledby={headingId} className="min-w-0 flex-1 pt-1.5">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <h3 id={headingId} className="text-base font-semibold text-heading">
                  Phase {item.number} — {item.phase.recovery_phase_title}
                </h3>
                <StatusBadge status={PHASE_STATUS[item.status]} />
              </div>

              {dates ? (
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted" data-numeric>
                  <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
                  {dates}
                </p>
              ) : null}

              {item.phase.recovery_phase_description ? (
                <p className="mt-2 whitespace-pre-wrap leading-relaxed text-body">
                  {item.phase.recovery_phase_description}
                </p>
              ) : null}

              {item.count.total === 0 ? (
                <p className="mt-3 text-sm text-muted">No activities yet</p>
              ) : (
                <>
                  <div className="mt-3 flex items-center gap-3">
                    <ProgressBar
                      className="flex-1"
                      value={item.count.percentage ?? 0}
                      tone={item.status === 'completed' ? 'success' : 'accent'}
                      label={`Phase ${item.number} done`}
                      valueText={`${item.count.done} of ${item.count.total} done`}
                    />
                    <span className="shrink-0 text-sm text-muted" data-numeric>
                      {item.count.done} of {item.count.total} done
                    </span>
                  </div>

                  <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                    {item.activities.map((activity) => {
                      const done = activity.recovery_activity_completed_at !== null
                      const saving = savingId === activity.recovery_activity_id
                      return (
                        <li
                          key={activity.recovery_activity_id}
                          id={`activity-${activity.recovery_activity_id}`}
                          className="flex scroll-mt-28 flex-col gap-2.5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                        >
                          <div className="flex min-w-0 gap-3">
                            {done ? (
                              <Check className="mt-0.5 size-5 shrink-0 text-success-700" aria-hidden="true" />
                            ) : (
                              <CircleDashed className="mt-0.5 size-5 shrink-0 text-neutral-500" aria-hidden="true" />
                            )}
                            <div className="min-w-0">
                              <p className={cn('text-body', done && 'text-muted')}>
                                {activity.recovery_activity_title}
                              </p>
                              {activity.recovery_activity_description ? (
                                <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">
                                  {activity.recovery_activity_description}
                                </p>
                              ) : null}
                              <p className="mt-0.5 text-sm text-muted" data-numeric>
                                {done
                                  ? `Done on ${formatDate(activity.recovery_activity_completed_at)}`
                                  : activity.recovery_activity_target_date
                                    ? `By ${formatDate(activity.recovery_activity_target_date)}`
                                    : 'Not done yet'}
                              </p>
                            </div>
                          </div>
                          <div className="sm:shrink-0">
                            {done ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="max-sm:w-full"
                                isLoading={saving}
                                loadingLabel="Saving…"
                                aria-label={`Mark "${activity.recovery_activity_title}" as not done`}
                                onClick={() => {
                                  if (savingId === null) onReopen(activity)
                                }}
                              >
                                <RotateCcw aria-hidden="true" />
                                Undo
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="max-sm:w-full"
                                isLoading={saving}
                                loadingLabel="Saving…"
                                aria-label={`Mark "${activity.recovery_activity_title}" as done`}
                                onClick={() => {
                                  if (savingId === null) onComplete(activity)
                                }}
                              >
                                <Check aria-hidden="true" />
                                Mark as done
                              </Button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                    {item.goals.map((goal) => (
                      <li
                        key={goal.treatment_goal_id}
                        className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <div className="flex min-w-0 gap-3">
                          <Target className="mt-0.5 size-5 shrink-0 text-accent-700" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="text-body">
                              <span className="font-medium">Goal: </span>
                              {goal.treatment_goal_description}
                            </p>
                            <p className="mt-0.5 text-sm text-muted" data-numeric>
                              {goal.treatment_goal_target_date
                                ? `By ${formatDate(goal.treatment_goal_target_date)} · marked by your doctor`
                                : 'Marked by your doctor'}
                            </p>
                          </div>
                        </div>
                        <StatusBadge status={treatmentGoalStatus[goal.treatment_goal_status]} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </li>
        )
      })}
    </ol>
  )
}
