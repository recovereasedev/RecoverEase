import { Pill, Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  useCreateMedicationSchedule,
  useCreatePrescription,
} from '@/features/medications/hooks'
import { toDateKey } from '@/lib/format'

/** The database allows between one and twelve doses a day. */
const MAX_TIMES = 12

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

  const [notes, setNotes] = useState('')
  const [name, setName] = useState('')
  const [dosage, setDosage] = useState('')
  const [times, setTimes] = useState<string[]>(['08:00'])
  const [startDate, setStartDate] = useState(toDateKey())
  const [endDate, setEndDate] = useState('')
  const [errors, setErrors] = useState<{
    name?: string
    dosage?: string
    times?: string
    startDate?: string
    endDate?: string
  }>({})

  const inFlight = useRef(false)
  const isPending = createPrescription.isPending || createSchedule.isPending

  const setTimeAt = (index: number, value: string) => {
    setTimes((current) =>
      current.map((time, position) => (position === index ? value : time)),
    )
  }

  const submit = () => {
    // Mirrors the CHECK constraints on `medication_schedule`: a non-blank
    // name and dosage, between one and twelve times, and an end date that is
    // not before the start.
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Name the medicine.'
    if (!dosage.trim()) next.dosage = 'Say how much to take, e.g. 500 mg.'
    if (times.length === 0 || times.some((time) => !time)) {
      next.times = 'Give a time for every dose.'
    } else if (new Set(times).size !== times.length) {
      next.times = 'Each dose needs a different time.'
    }
    if (!startDate) next.startDate = 'Choose when the course starts.'
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

      <Field
        label="Times of day"
        required
        description="One row per dose. The patient's checklist and reminders follow these."
        error={errors.times}
      >
        <div className="space-y-2">
          {times.map((time, index) => (
            // Times are positional and may repeat while being typed, so the
            // index is the only stable key here.
            <div key={index} className="flex items-center gap-2">
              <Input
                type="time"
                value={time}
                aria-label={`Dose ${index + 1} time`}
                onChange={(event) => setTimeAt(index, event.target.value)}
              />
              {times.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove dose ${index + 1}`}
                  onClick={() =>
                    setTimes((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}

          {times.length < MAX_TIMES ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTimes((current) => [...current, ''])}
            >
              <Plus aria-hidden="true" />
              Add another time
            </Button>
          ) : null}
        </div>
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
