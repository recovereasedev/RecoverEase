import { ClipboardPlus, Save } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'
import type { PlanWithGoals } from '@/features/treatment-plans/api'
import {
  useCreateTreatmentPlan,
  useUpdateTreatmentPlan,
} from '@/features/treatment-plans/hooks'
import { toDateKey } from '@/lib/format'

/**
 * Modules 3.1 "Create Treatment Plan" and 3.2 "Update Treatment Plan".
 *
 * One form for both, because the fields are the same and a separate edit form
 * would drift from the create form the first time a column changed.
 *
 * The validation below is not decoration: it mirrors the CHECK constraints
 * the database already enforces — `treatment_plan_title_not_blank` and
 * `treatment_plan_dates_ordered`. Letting the request go and rendering
 * Postgres's answer would be correct but useless, since "violates check
 * constraint" names nothing the clinician can act on.
 */
export function TreatmentPlanForm({
  patientId,
  doctorId,
  plan,
  onDone,
  onCancel,
}: {
  patientId: string
  doctorId: string
  /** Present when editing; absent when creating. */
  plan?: PlanWithGoals
  /** Called once the record is written. */
  onDone?: () => void
  /** Shown as a Cancel control when given. */
  onCancel?: () => void
}) {
  const create = useCreateTreatmentPlan(patientId, doctorId)
  const update = useUpdateTreatmentPlan(patientId)
  const mutation = plan ? update : create

  const [title, setTitle] = useState(plan?.treatment_plan_title ?? '')
  const [description, setDescription] = useState(
    plan?.treatment_plan_description ?? '',
  )
  const [startDate, setStartDate] = useState(
    plan?.treatment_plan_start_date ?? toDateKey(),
  )
  const [endDate, setEndDate] = useState(plan?.treatment_plan_end_date ?? '')
  const [errors, setErrors] = useState<{
    title?: string
    startDate?: string
    endDate?: string
  }>({})

  // Set synchronously, before the mutation is dispatched. `isPending` cannot
  // do this job alone: React commits the disabled button on a later render,
  // so two clicks in one task both get through — which is how a duplicate
  // appointment reached production once already.
  const inFlight = useRef(false)

  const submit = () => {
    const next: typeof errors = {}
    if (!title.trim()) next.title = 'Give the plan a title.'
    if (!startDate) next.startDate = 'Choose when the plan starts.'
    if (endDate && startDate && endDate < startDate) {
      next.endDate = 'The end date cannot be before the start date.'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return

    if (inFlight.current) return
    inFlight.current = true

    const release = () => {
      inFlight.current = false
    }

    if (plan) {
      update.mutate(
        {
          planId: plan.treatment_plan_id,
          changes: {
            treatment_plan_title: title.trim(),
            treatment_plan_description: description.trim() || null,
            treatment_plan_start_date: startDate,
            treatment_plan_end_date: endDate || null,
          },
        },
        { onSuccess: () => onDone?.(), onSettled: release },
      )
      return
    }

    create.mutate(
      {
        title: title.trim(),
        description: description.trim() || null,
        startDate,
        endDate: endDate || null,
      },
      { onSuccess: () => onDone?.(), onSettled: release },
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Field label="Plan title" required error={errors.title}>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Post-operative knee recovery"
        />
      </Field>

      <Field
        label="Description"
        description="Optional. What this plan covers, in a sentence or two."
      >
        <Textarea
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Twelve week programme of physiotherapy and graded weight bearing."
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" required error={errors.startDate}>
          <Input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </Field>

        <Field
          label="End date"
          description="Optional. Leave blank for an ongoing plan."
          error={errors.endDate}
        >
          {/* No `min` here on purpose. A control the browser considers
              out of range blocks form submission before any handler runs,
              so the message below would never appear and the clinician
              would get a native bubble instead of the field-level error
              this project puts next to the field. The rule is checked on
              submit, and the database checks it again. */}
          <Input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </Field>
      </div>

      {mutation.isError ? (
        <FormError
          error={mutation.error}
          title={
            plan
              ? 'The plan was not updated'
              : 'The treatment plan was not created'
          }
        />
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} className="max-sm:w-full">
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          className="max-sm:w-full"
          isLoading={mutation.isPending}
          loadingLabel={plan ? 'Saving plan…' : 'Creating plan…'}
        >
          {plan ? (
            <>
              <Save aria-hidden="true" />
              Save plan
            </>
          ) : (
            <>
              <ClipboardPlus aria-hidden="true" />
              Create treatment plan
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
