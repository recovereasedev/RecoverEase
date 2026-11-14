import { Target } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import {
  useClinicToday,
  useCreateTreatmentGoal,
} from '@/features/treatment-plans/hooks'
import { formatDate } from '@/lib/format'

/**
 * Module 3.3 "Define Treatment Goals".
 *
 * Each goal is written on its own submit and the form then clears, so a
 * clinician adding four goals ends with four rows and never risks losing the
 * three they already entered to a failure on the fourth. Nothing is held back
 * to be saved together at the end.
 *
 * A goal starts not started; the patient records its progress, and the
 * system marks it missed once its target date has passed (migration 55).
 */
export function TreatmentGoalForm({
  patientId,
  planId,
  planStartDate,
  planEndDate,
  onAdded,
}: {
  patientId: string
  planId: string
  /** The plan's dates: a target date must fall within them, as the database requires. */
  planStartDate?: string
  planEndDate?: string | null
  /** Called after each goal is written. */
  onAdded?: () => void
}) {
  const create = useCreateTreatmentGoal(patientId)
  // The clinic's day, as the database judges it. Until it is known the form
  // gives no past-date hint; the database still refuses, and says why below.
  const today = useClinicToday()
  const earliest =
    today && planStartDate && planStartDate > today ? planStartDate : (today ?? planStartDate)

  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [dateError, setDateError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)

  const submit = () => {
    // Mirrors `treatment_goal_description_not_blank`.
    const descriptionProblem = description.trim()
      ? undefined
      : 'Describe what the patient is working towards.'
    // Mirrors `treatment_goal_guard_progress` (migration 55).
    let dateProblem: string | undefined
    if (targetDate && today && planEndDate && planEndDate < today) {
      dateProblem = `This plan ended on ${formatDate(planEndDate)}; add the goal without a target date.`
    } else if (targetDate && today && targetDate < today) {
      dateProblem = 'Choose today or a later date.'
    } else if (targetDate && planStartDate && targetDate < planStartDate) {
      dateProblem = `Choose a date on or after the plan starts (${formatDate(planStartDate)}).`
    } else if (targetDate && planEndDate && targetDate > planEndDate) {
      dateProblem = `Choose a date on or before the plan ends (${formatDate(planEndDate)}).`
    }
    setError(descriptionProblem)
    setDateError(dateProblem)
    if (descriptionProblem || dateProblem) return

    if (inFlight.current) return
    inFlight.current = true

    create.mutate(
      {
        planId,
        description: description.trim(),
        targetDate: targetDate || null,
      },
      {
        onSuccess: () => {
          setDescription('')
          setTargetDate('')
          onAdded?.()
        },
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Field label="Goal" required error={error}>
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Walk 500 metres unaided"
        />
      </Field>

      <Field
        label="Target date"
        description="Optional. When the patient is aiming to reach it. Once it passes, an unfinished goal is marked missed."
        error={dateError}
      >
        <Input
          type="date"
          value={targetDate}
          min={earliest}
          max={planEndDate ?? undefined}
          onChange={(event) => setTargetDate(event.target.value)}
        />
      </Field>

      {create.isError ? (
        <FormError error={create.error} title="The goal was not added" />
      ) : null}

      <Button
        type="submit"
        variant="secondary"
        className="max-sm:w-full"
        isLoading={create.isPending}
        loadingLabel="Adding goal…"
      >
        <Target aria-hidden="true" />
        Add goal
      </Button>
    </form>
  )
}
