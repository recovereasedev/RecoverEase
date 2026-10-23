import { ProgressBar } from '@/components/ui/progress'
import type { TreatmentGoalStatus } from '@/features/treatment-plans/api'
import { formatDate } from '@/lib/format'
import { treatmentGoalStatus } from '@/lib/status'

import type { GoalSnapshot } from '../progress'

const STATUS_ORDER: TreatmentGoalStatus[] = ['achieved', 'in_progress', 'pending', 'missed']

/**
 * Treatment goals, as they stand today.
 *
 * Not a chart, and not over the selected period: a goal stores its status
 * but not the day it reached it, so a line of goals achieved by date would be
 * made up. This says so on screen, beside the numbers, so the snapshot is
 * never read as part of the 7 or 30 days above it.
 */
export function GoalSnapshotView({
  snapshot,
  today,
}: {
  snapshot: GoalSnapshot
  today: string
}) {
  if (snapshot.plans.length === 0) {
    return (
      <Message title="No active treatment plan">
        Goals appear here once a treatment plan is active.
      </Message>
    )
  }

  if (snapshot.total === 0) {
    return (
      <Message title="No goals yet">
        No goals have been set in the active treatment plan.
      </Message>
    )
  }

  const goalWord = snapshot.total === 1 ? 'goal' : 'goals'

  return (
    <div>
      <p className="text-sm text-muted">Goals achieved</p>
      <p className="mt-0.5 text-headline-lg text-heading">
        {snapshot.achieved} of {snapshot.total}{' '}
        <span className="text-body-md font-normal text-muted">
          {goalWord}
          {snapshot.percentage === null ? '' : ` (${snapshot.percentage}%)`}
        </span>
      </p>
      <ProgressBar
        value={snapshot.percentage ?? 0}
        label="Goals achieved"
        valueText={`${snapshot.achieved} of ${snapshot.total} ${goalWord} achieved`}
        className="mt-3 max-w-md"
      />
      <p className="mt-3 text-sm text-muted">
        As of today, {formatDate(today)}. Goals record their current status but
        not the day it changed, so this does not follow the 7 or 30 days above
        and is not part of the overall score.
      </p>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {STATUS_ORDER.map((status) => {
          const { icon: Icon, label } = treatmentGoalStatus[status]
          return (
            <li key={status} className="flex items-center gap-2.5 text-sm">
              <Icon className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
              <span className="flex-1 text-body">{label}</span>
              <span className="font-medium text-heading" data-numeric>
                {snapshot.byStatus[status]}
              </span>
            </li>
          )
        })}
      </ul>

      {snapshot.pastTarget > 0 || snapshot.nextTarget ? (
        <div className="mt-4 space-y-1 text-sm text-body">
          {snapshot.pastTarget > 0 ? (
            <p>
              {snapshot.pastTarget}{' '}
              {snapshot.pastTarget === 1 ? 'goal is' : 'goals are'} past the
              target date and not yet marked achieved.
            </p>
          ) : null}
          {snapshot.nextTarget ? (
            <p>
              Next target date:{' '}
              <span className="font-medium text-heading">
                {formatDate(snapshot.nextTarget.date)}
              </span>
              , {snapshot.nextTarget.description}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* More than one plan can be active at once; each keeps its own count,
          the way the treatment pages show it. */}
      {snapshot.plans.length > 1 ? (
        <ul className="mt-4 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] text-sm">
          {snapshot.plans.map((plan) => (
            <li key={plan.id} className="flex flex-wrap justify-between gap-x-4 py-2">
              <span className="min-w-0 text-body [overflow-wrap:anywhere]">
                {plan.title}
              </span>
              <span className="text-muted" data-numeric>
                {plan.achieved} of {plan.total} achieved
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Message({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-surface-sunken px-4 py-6 text-center">
      <p className="font-semibold text-heading">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  )
}
