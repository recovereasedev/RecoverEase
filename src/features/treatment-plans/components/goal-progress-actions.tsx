import { CheckCircle2, Play } from 'lucide-react'
import { useRef } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import type {
  PatientGoalProgress,
  TreatmentGoal,
} from '@/features/treatment-plans/api'
import { useUpdateGoalStatus } from '@/features/treatment-plans/hooks'

const LABEL: Record<PatientGoalProgress, string> = {
  in_progress: 'Start goal',
  achieved: 'Mark achieved',
}

/** What the patient may do next from each status; the database enforces the same moves. */
const NEXT: Record<TreatmentGoal['treatment_goal_status'], PatientGoalProgress[]> = {
  pending: ['in_progress', 'achieved'],
  in_progress: ['achieved'],
  // Reached late: the missed status stays in the goal's history.
  missed: ['achieved'],
  achieved: [],
}

/**
 * Module 5.8: the patient records progress on one goal (migration 55). One
 * press saves - no confirmation for an ordinary update - and a second press
 * while it saves is swallowed. Missed is never set here: the system marks a
 * goal missed once its target date has passed.
 */
export function GoalProgressActions({
  patientId,
  goal,
}: {
  patientId: string
  goal: TreatmentGoal
}) {
  const progress = useUpdateGoalStatus(patientId)
  const moves = NEXT[goal.treatment_goal_status]
  // The pressed button may be gone once the goal moves on; focus stays on
  // this goal instead of falling to the top of the page.
  const container = useRef<HTMLDivElement>(null)

  const record = (status: PatientGoalProgress) => {
    if (progress.isPending) return
    progress.mutate(
      { goalId: goal.treatment_goal_id, status },
      { onSuccess: () => container.current?.focus() },
    )
  }

  return (
    <div ref={container} tabIndex={-1} className="outline-none print:hidden">
      {goal.treatment_goal_status === 'missed' ? (
        <p className="mt-2 text-sm text-warning-700">
          The target date has passed. If you reach this goal, you can still
          mark it achieved.
        </p>
      ) : null}

      {moves.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {moves.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={status === 'achieved' ? 'primary' : 'secondary'}
              className="max-sm:flex-1"
              isLoading={
                progress.isPending && progress.variables?.status === status
              }
              loadingLabel="Saving…"
              aria-label={`${LABEL[status]}: ${goal.treatment_goal_description}`}
              onClick={() => record(status)}
            >
              {status === 'achieved' ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {LABEL[status]}
            </Button>
          ))}
        </div>
      ) : null}

      {progress.isError ? (
        <div className="mt-3">
          <FormError
            error={progress.error}
            title="Your progress was not saved"
          />
        </div>
      ) : null}

      <p role="status" className="sr-only">
        {progress.isSuccess
          ? `Saved: ${progress.variables.status === 'achieved' ? 'goal achieved' : 'goal started'}.`
          : ''}
      </p>
    </div>
  )
}
