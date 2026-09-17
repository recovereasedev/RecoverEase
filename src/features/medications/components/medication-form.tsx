import { Pill } from 'lucide-react'
import { useId, useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  calculateDoseTimes,
  needsInterval,
  type DoseTimeField,
} from '@/features/medications/dose-times'
import {
  useCreateMedicationSchedule,
  useCreatePrescription,
} from '@/features/medications/hooks'
import { toDateKey } from '@/lib/format'

/**
 * Modules 4.3 "Create/Issue Prescription" and 4.1 "Set Medication Schedule".
 *
 * The two are one action for the clinician and two rows in the database, so
 * they are one form here: issuing a prescription with no medicine on it is
 * not something anyone means to do. When a prescription has already been
 * issued in this consultation its id is passed in, the notes field goes away
 * and only the schedule is written — a second medicine belongs to the same
 * prescription, not a new one.
 *
 * The clinician says how many doses a day, how many hours apart and when the
 * first is, and the times are worked out for them (group QA 9/12/26, item 4;
 * see `dose-times.ts`). Only those times are saved, exactly as typed times
 * were, so everything that reads a schedule is unchanged.
 *
 * Nothing is written until submit. Inserting the schedule is all that is
 * needed for the patient's checklist: a database trigger generates the
 * individual doses, and that behaviour is untouched here.
 */
export function MedicationForm({
  patientId,
  doctorId,
  prescriptionId,
  onDone,
  onCancel,
}: {
  patientId: string
  doctorId: string
  /** Adds another medicine to a prescription that already exists. */
  prescriptionId?: string
  /** Called with the prescription the medicine was written against. */
  onDone?: (prescriptionId: string) => void
  onCancel?: () => void
}) {
  const createPrescription = useCreatePrescription(patientId, doctorId)
  const createSchedule = useCreateMedicationSchedule(patientId)
  const doseTimesLabelId = useId()

  const [notes, setNotes] = useState('')
  const [name, setName] = useState('')
  const [dosage, setDosage] = useState('')
  const [frequency, setFrequency] = useState('1')
  const [intervalHours, setIntervalHours] = useState('')
  const [startTime, setStartTime] = useState('08:00')
  const [startDate, setStartDate] = useState(toDateKey())
  const [endDate, setEndDate] = useState('')
  const [errors, setErrors] = useState<
    Partial<Record<'name' | 'dosage' | DoseTimeField | 'startDate' | 'endDate', string>>
  >({})

  const inFlight = useRef(false)
  const isPending = createPrescription.isPending || createSchedule.isPending

  // Worked out on every render, so the times shown are always the ones that
  // would be saved.
  const doseTimes = calculateDoseTimes({
    frequency,
    intervalHours,
    startTime,
  })
  const intervalApplies = needsInterval(frequency)

  // A refusal is about the times as they were when saved. Once any of the
  // three fields changes, the preview below already shows the new result, so
  // a message still pointing at the old one would contradict it.
  const clearDoseTimeErrors = () =>
    setErrors((current) => {
      const next = { ...current }
      delete next.frequency
      delete next.interval
      delete next.startTime
      return next
    })

  const submit = () => {
    // Mirrors the CHECK constraints on `medication_schedule`: a non-blank
    // name and dosage, between one and twelve times, and an end date that is
    // not before the start.
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Name the medicine.'
    if (!dosage.trim()) next.dosage = 'Say how much to take, e.g. 500 mg.'
    if (!doseTimes.ok) next[doseTimes.field] = doseTimes.message
    if (!startDate) next.startDate = 'Choose when the course starts.'
    if (endDate && startDate && endDate < startDate) {
      next.endDate = 'The end date cannot be before the start date.'
    }
    setErrors(next)
    if (Object.keys(next).length > 0 || !doseTimes.ok) return

    if (inFlight.current) return
    inFlight.current = true

    const release = () => {
      inFlight.current = false
    }

    const times = doseTimes.times

    const writeSchedule = (id: string) => {
      createSchedule.mutate(
        {
          prescriptionId: id,
          name: name.trim(),
          dosage: dosage.trim(),
          times,
          startDate,
          endDate: endDate || null,
        },
        { onSuccess: () => onDone?.(id), onSettled: release },
      )
    }

    if (prescriptionId) {
      writeSchedule(prescriptionId)
      return
    }

    createPrescription.mutate(
      { notes: notes.trim() || null },
      {
        onSuccess: (prescription) =>
          writeSchedule(prescription.prescription_id),
        // Released here only when the prescription itself failed; otherwise
        // the schedule's own `onSettled` releases it.
        onError: release,
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
      {prescriptionId ? null : (
        <Field
          label="Prescription notes"
          description="Optional. Guidance that applies to the whole prescription."
        >
          <Textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Take with food. Stop if any rash appears."
          />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Medicine" required error={errors.name}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Paracetamol"
          />
        </Field>

        <Field label="Dosage" required error={errors.dosage}>
          <Input
            value={dosage}
            onChange={(event) => setDosage(event.target.value)}
            placeholder="500 mg"
          />
        </Field>
      </div>

      {/* `step="any"` rather than the default whole-number step: a value the
          browser considers invalid blocks submission before any handler
          runs, and the clinician would get a native bubble instead of the
          field-level message. Whole numbers are checked on submit. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Doses a day" required error={errors.frequency}>
          <Input
            type="number"
            inputMode="numeric"
            step="any"
            value={frequency}
            onChange={(event) => {
              setFrequency(event.target.value)
              clearDoseTimeErrors()
            }}
          />
        </Field>

        <Field
          label="Hours between doses"
          required={intervalApplies}
          {...(intervalApplies
            ? {}
            : { description: 'Not needed for one dose a day.' })}
          error={errors.interval}
        >
          <Input
            type="number"
            inputMode="numeric"
            step="any"
            value={intervalHours}
            disabled={!intervalApplies}
            onChange={(event) => {
              setIntervalHours(event.target.value)
              clearDoseTimeErrors()
            }}
          />
        </Field>

        <Field label="First dose at" required error={errors.startTime}>
          <Input
            type="time"
            value={startTime}
            onChange={(event) => {
              setStartTime(event.target.value)
              clearDoseTimeErrors()
            }}
          />
        </Field>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface-sunken px-3.5 py-3">
        <p id={doseTimesLabelId} className="text-sm font-medium text-heading">
          Dose times
        </p>
        <p className="text-sm text-muted">
          Worked out from the fields above. The patient&apos;s checklist and
          reminders follow these.
        </p>
        <div aria-live="polite">
          {doseTimes.ok ? (
            <ul
              aria-labelledby={doseTimesLabelId}
              className="mt-2 flex flex-wrap gap-2"
            >
              {doseTimes.times.map((time) => (
                <li
                  key={time}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-surface px-2.5 py-1 text-sm font-medium text-heading"
                  data-numeric
                >
                  {time}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {/* Said once: next to the field when a save was refused, here
                  while the clinician is still filling the form in. */}
              {errors[doseTimes.field]
                ? 'Correct the highlighted field to see the times.'
                : doseTimes.message}
            </p>
          )}
        </div>
      </div>

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
          description="Optional. Leave blank for an ongoing course."
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

      {createPrescription.isError ? (
        <FormError
          error={createPrescription.error}
          title="The prescription was not issued"
        />
      ) : null}
      {createSchedule.isError ? (
        <FormError
          error={createSchedule.error}
          title="The medication schedule was not saved"
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
          isLoading={isPending}
          loadingLabel="Saving medication…"
        >
          <Pill aria-hidden="true" />
          {prescriptionId ? 'Add medicine' : 'Add prescription'}
        </Button>
      </div>
    </form>
  )
}
