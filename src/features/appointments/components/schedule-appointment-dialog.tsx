import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'

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

  const [patientId, setPatientId] = useState(fixedPatientId ?? '')
  const [scheduledFor, setScheduledFor] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const patients = patientsQuery.data ?? []
  const selected = patients.find((p) => p.pat_id === (fixedPatientId ?? patientId))

  const close = () => {
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

    create.mutate(
      {
        patientId: selected.pat_id,
        doctorId: selected.doc_id,
        scheduledFor: when.toISOString(),
      },
      { onSuccess: close },
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
            {create.error instanceof Error
              ? create.error.message
              : 'The appointment could not be scheduled.'}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  )
}
