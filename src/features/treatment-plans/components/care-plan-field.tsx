import { useEffect } from 'react'

import { Field, Select } from '@/components/ui/field'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'

import { careHasEnded, chooseCarePlan, isOpenCare } from '../api'

export type CarePlanChoice = {
  /** The plan to send; null leaves it to the database (no plan, or a follow-up request). */
  planId: string | null
  /** Several active plans and none chosen: the form must not be sent. */
  needsChoice: boolean
}

/**
 * Which care plan a new prescription or appointment belongs to (migration
 * 60). Nothing is asked when the patient has one active plan - it is used -
 * or none. With several, the person chooses; the database refuses to guess.
 * The resolved choice is handed up as it changes, for the form to send.
 */
export function CarePlanField({
  patientId,
  value,
  onChange,
  onResolved,
  error,
  endedNotice,
}: {
  patientId: string
  value: string
  onChange: (planId: string) => void
  onResolved: (choice: CarePlanChoice) => void
  error?: string | undefined
  /** Shown when every plan of the patient's is discharged. */
  endedNotice?: string
}) {
  const plansQuery = useTreatmentPlans(patientId)
  const plans = plansQuery.data ?? []
  const active = plans.filter((plan) => isOpenCare(plan.treatment_plan_status))
  const choice = chooseCarePlan(plans, value)

  useEffect(() => {
    onResolved(choice)
    // `choice` is rebuilt each render; its two fields are what matter.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [choice.planId, choice.needsChoice])

  if (active.length > 1) {
    return (
      <Field label="Care plan" required error={error}>
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose a care plan…</option>
          {active.map((plan) => (
            <option key={plan.treatment_plan_id} value={plan.treatment_plan_id}>
              {plan.treatment_plan_title}
            </option>
          ))}
        </Select>
      </Field>
    )
  }
  if (endedNotice && careHasEnded(plans)) {
    return <p className="text-sm text-muted">{endedNotice}</p>
  }
  return null
}
