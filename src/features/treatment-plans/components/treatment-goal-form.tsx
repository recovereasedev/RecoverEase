import { Target } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { useCreateTreatmentGoal } from '@/features/treatment-plans/hooks'

/**
 * Module 3.3 "Define Treatment Goals".
 *
 * Each goal is written on its own submit and the form then clears, so a
 * clinician adding four goals ends with four rows and never risks losing the
 * three they already entered to a failure on the fourth. Nothing is held back
 * to be saved together at the end.
 */
export function TreatmentGoalForm({
  patientId,
  planId,
  onAdded,
}: {
  patientId: string
  planId: string
  /** Called after each goal is written. */
  onAdded?: () => void
}) {
  const create = useCreateTreatmentGoal(patientId)

  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)

  const submit = () => {
    // Mirrors `treatment_goal_description_not_blank`.
    if (!description.trim()) {
      setError('Describe what the patient is working towards.')
      return
    }
    setError(undefined)

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
        description="Optional. When the patient is aiming to reach it."
      >
        <Input
          type="date"
          value={targetDate}
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
