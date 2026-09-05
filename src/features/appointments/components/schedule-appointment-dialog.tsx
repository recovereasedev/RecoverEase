import { TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'

import { isPresentableMessage } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { useCreateAppointment } from '@/features/appointments/hooks'
import { useMyPatients } from '@/features/patients/hooks'
import { fullName } from '@/lib/utils'

/**
 * Module 6.1 "Schedule Follow-up Appointment", from the clinician's side.
 *
 * The doctor is never picked here. An appointment belongs to the patient's
 * assigned clinician and a database trigger rejects any other pairing, so the
 * assignment is read from the chosen patient rather than offered as a choice
 * that could only ever be wrong.
 *
 * `datetime-local` yields wall-clock time in the browser's zone, which is the
 * clinic's zone for the people using this, and it is converted to an instant
 * before it is sent. Storing the typed string instead would make the meaning
 * of an appointment depend on where it was later read.
 */
/**
 * Turns a scheduling failure into something a clinician can act on.
 *
 * The database is the last line against a double booking, and it answers in
 * its own language: "duplicate key value violates unique constraint" is true
 * and useless. Both rules it enforces here have a plain meaning, so they are
 * translated; anything else falls back to the server's own sentence when that
 * sentence was written for a person, and to a plain statement otherwise.
 */
function describeSchedulingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  const lowered = raw.toLowerCase()

  if (
    lowered.includes('appointment_one_active_per_slot') ||
    (lowered.includes('duplicate key') && lowered.includes('appointment'))
  ) {
    return 'That appointment already exists. Refresh to see it in the schedule.'
  }

  if (lowered.includes('assigned doctor')) {
    return 'An appointment can only be booked with the patient’s assigned doctor.'
  }

  return isPresentableMessage(raw)
    ? raw
    : 'The appointment could not be scheduled. Check the details and try again.'
}

export function ScheduleAppointmentDialog({
  isOpen,
  onClose,
  patientId: fixedPatientId,
}: {
  isOpen: boolean
  onClose: () => void
  /** Pre-selects a patient, for the dialog opened from their record. */
  patientId?: string
}) {
  const patientsQuery = useMyPatients()
  const create = useCreateAppointment()

  // Set synchronously, before the mutation is dispatched. `create.isPending`
  // cannot do this job on its own: React commits the disabled button on a
  // later render, so two submissions in the same task both get through, and
  // React Query does not deduplicate concurrent `mutate()` calls. In
  // production that put two identical appointments — same patient, same
  // clinician, same instant — into the record from one double click.
  const inFlight = useRef(false)

  const [patientId, setPatientId] = useState(fixedPatientId ?? '')
  const [scheduledFor, setScheduledFor] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const patients = patientsQuery.data ?? []
  const selected = patients.find((p) => p.pat_id === (fixedPatientId ?? patientId))

  const close = () => {
    inFlight.current = false
    setPatientId(fixedPatientId ?? '')
    setScheduledFor('')
    setValidationError(null)
    // Clears a previous failure so it is not still on screen the next time
    // this dialog is opened.
    create.reset()
    onClose()
  }

  const submit = () => {
    setValidationError(null)

    if (!selected) {
      setValidationError('Choose which patient this appointment is for.')
      return
    }
    if (!scheduledFor) {
      setValidationError('Choose a date and time.')
      return
    }

    const when = new Date(scheduledFor)
    if (Number.isNaN(when.getTime())) {
      setValidationError('That date and time could not be read.')
      return
    }
    if (when.getTime() <= Date.now()) {
      setValidationError('Choose a time in the future.')
      return
    }

    // Nothing below this line may run twice for one user action.
    if (inFlight.current) return
    inFlight.current = true

    create.mutate(
      {
        patientId: selected.pat_id,
        doctorId: selected.doc_id,
        scheduledFor: when.toISOString(),
      },
      {
        onSuccess: close,
        // Released however it ends, so a genuine failure can be retried and
        // the form is never left permanently locked.
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  // Prefills the picker's floor with now, in the browser's zone, so the
  // native control itself discourages a past time.
  const earliest = (() => {
    const now = new Date()
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
    return now.toISOString().slice(0, 16)
  })()

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title="Schedule an appointment"
      description="The patient sees this in their own calendar as soon as it is saved."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            isLoading={create.isPending}
            loadingLabel="Scheduling…"
          >
            Schedule appointment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {fixedPatientId ? null : (
          <Field label="Patient" required>
            <Select
              value={patientId}
              onChange={(event) => setPatientId(event.target.value)}
            >
              <option value="">Select a patient…</option>
              {patients.map((patient) => (
                <option key={patient.pat_id} value={patient.pat_id}>
                  {fullName(patient.pat_first_name, patient.pat_last_name)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Date and time"
          description="Clinic local time."
          required
        >
          <Input
            type="datetime-local"
            value={scheduledFor}
            min={earliest}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
        </Field>

        {validationError ? (
          <Notice
            tone="danger"
            title="Check this before scheduling"
            icon={TriangleAlert}
            live="assertive"
          >
            {validationError}
          </Notice>
        ) : null}

        {/* The database says what it rejected — an appointment outside the
            assignment, a constraint on the slot. Showing that beats a
            generic failure the clinician cannot act on. */}
        {create.isError ? (
          <Notice
            tone="danger"
            title="The appointment was not scheduled"
            icon={TriangleAlert}
            live="assertive"
          >
            {describeSchedulingError(create.error)}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  )
}
