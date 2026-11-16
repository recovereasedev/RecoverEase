import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Textarea } from '@/components/ui/field'
import type { MedicationSchedule } from '@/features/medications/api'
import { useUpdateMedicationInstructions } from '@/features/medications/hooks'

/**
 * A medicine's own instructions (migration 58): the doctor's wording for one
 * medicine, apart from the notes that apply to the whole prescription.
 *
 * Optional everywhere. The app never suggests or fills them in - not even a
 * placeholder, which could be read as an instruction to follow.
 */

/** Mirrors the `medication_schedule_instructions_valid` check. */
export const INSTRUCTIONS_MAX = 500

/** What is saved for the text typed: trimmed, and null when nothing is left. */
export function instructionsToSave(text: string): string | null {
  return text.trim() || null
}

/** Why the text typed cannot be saved, if it cannot. */
export function instructionsError(text: string): string | undefined {
  return text.trim().length > INSTRUCTIONS_MAX
    ? `Instructions can be at most ${INSTRUCTIONS_MAX} characters.`
    : undefined
}

/** The field, with its counter. Used when prescribing and when editing. */
export function InstructionsField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string | undefined
}) {
  return (
    <Field
      label="Instructions"
      description="Optional. How to take this medicine, in your own words. Shown to the patient under this medicine only."
      error={error}
    >
      <Textarea
        rows={3}
        maxLength={INSTRUCTIONS_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-right text-xs text-muted" data-numeric>
        {value.length} / {INSTRUCTIONS_MAX}
      </p>
    </Field>
  )
}

/** A medicine's instructions as written, or nothing at all when it has none. */
export function MedicineInstructions({
  text,
}: {
  text: string | null | undefined
}) {
  if (!text) return null

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
      <p className="text-xs font-medium text-muted">Instructions</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-heading">
        {text}
      </p>
    </div>
  )
}

type EditableSchedule = Pick<
  MedicationSchedule,
  | 'medication_schedule_id'
  | 'medication_schedule_name'
  | 'medication_schedule_dosage'
  | 'medication_schedule_instructions'
>

/**
 * The doctor's "Add instructions" / "Edit instructions" on a medicine already
 * prescribed. Whether the save is allowed is the database's decision: only
 * the patient's own doctor can update a schedule.
 */
export function EditInstructionsAction({
  patientId,
  schedule,
}: {
  patientId: string
  schedule: EditableSchedule
}) {
  const [isOpen, setOpen] = useState(false)
  const [wasSaved, setSaved] = useState(false)
  const verb = schedule.medication_schedule_instructions ? 'Edit' : 'Add'

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 max-sm:self-start"
        // Names the medicine, so a list of several reads as distinct actions.
        aria-label={`${verb} instructions: ${schedule.medication_schedule_name}`}
        onClick={() => {
          setSaved(false)
          setOpen(true)
        }}
      >
        {verb} instructions
      </Button>
      {wasSaved ? (
        <p role="status" className="text-sm text-muted">
          Instructions saved.
        </p>
      ) : null}

      {isOpen ? (
        <EditInstructionsDialog
          patientId={patientId}
          schedule={schedule}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setSaved(true)
            setOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

function EditInstructionsDialog({
  patientId,
  schedule,
  onClose,
  onSaved,
}: {
  patientId: string
  schedule: EditableSchedule
  onClose: () => void
  onSaved: () => void
}) {
  const update = useUpdateMedicationInstructions(patientId)
  const [text, setText] = useState(schedule.medication_schedule_instructions ?? '')
  const [error, setError] = useState<string>()

  const save = () => {
    const problem = instructionsError(text)
    setError(problem)
    if (problem) return
    update.mutate(
      {
        scheduleId: schedule.medication_schedule_id,
        instructions: instructionsToSave(text),
      },
      { onSuccess: onSaved },
    )
  }

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="Instructions for this medicine"
      description={`${schedule.medication_schedule_name}, ${schedule.medication_schedule_dosage}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button isLoading={update.isPending} loadingLabel="Saving…" onClick={save}>
            Save instructions
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <InstructionsField
          value={text}
          onChange={(value) => {
            setText(value)
            setError(undefined)
          }}
          error={error}
        />
        <p className="text-sm text-muted">
          The schedule, its doses and the patient’s reminders do not change.
          Leave it empty to remove the instructions.
        </p>
        {update.isError ? (
          <FormError error={update.error} title="The instructions were not saved" />
        ) : null}
      </div>
    </Dialog>
  )
}
