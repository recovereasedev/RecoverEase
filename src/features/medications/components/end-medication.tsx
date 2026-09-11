import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import type { MedicationSchedule } from '@/features/medications/api'
import { useEndMedicationSchedule } from '@/features/medications/hooks'
import { toDateKey } from '@/lib/format'

type EndableSchedule = Pick<
  MedicationSchedule,
  | 'medication_schedule_id'
  | 'medication_schedule_name'
  | 'medication_schedule_dosage'
  | 'medication_schedule_start_date'
  | 'medication_schedule_end_date'
>

/**
 * Whether a schedule can still be ended: it has started, and it runs past
 * today. One that has not started is not running yet, and one already ending
 * today — or earlier — has nothing left to end.
 */
export function canEndSchedule(
  schedule: Pick<
    MedicationSchedule,
    'medication_schedule_start_date' | 'medication_schedule_end_date'
  >,
  today: string,
): boolean {
  return (
    schedule.medication_schedule_start_date <= today &&
    (schedule.medication_schedule_end_date === null ||
      schedule.medication_schedule_end_date > today)
  )
}

/**
 * QA-01 "End medication", for the clinician.
 *
 * Confirmed first: it cannot be undone from the app, and a patient's
 * reminders stop with it. The course keeps today and ends after it.
 */
export function EndMedicationAction({
  patientId,
  schedule,
  today = toDateKey(),
}: {
  patientId: string
  schedule: EndableSchedule
  /** The day to judge "still running" against. Injectable for tests. */
  today?: string
}) {
  const [isOpen, setOpen] = useState(false)

  if (!canEndSchedule(schedule, today)) return null

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 max-sm:self-start"
        // Names the medicine for screen readers, so a list of several reads
        // as distinct actions. A label rather than hidden text, which would
        // repeat the medicine's name in the page's text as well.
        aria-label={`End medication: ${schedule.medication_schedule_name}`}
        onClick={() => setOpen(true)}
      >
        End medication
      </Button>

      {isOpen ? (
        <EndMedicationDialog
          patientId={patientId}
          schedule={schedule}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function EndMedicationDialog({
  patientId,
  schedule,
  onClose,
}: {
  patientId: string
  schedule: EndableSchedule
  onClose: () => void
}) {
  const endSchedule = useEndMedicationSchedule(patientId)

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="End this medication?"
      description={`${schedule.medication_schedule_name}, ${schedule.medication_schedule_dosage}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep medication
          </Button>
          <Button
            variant="danger"
            isLoading={endSchedule.isPending}
            loadingLabel="Ending…"
            onClick={() =>
              endSchedule.mutate(schedule.medication_schedule_id, {
                onSuccess: onClose,
              })
            }
          >
            End medication
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-body">
          It stays on today’s schedule and ends after today. Later doses are no
          longer scheduled, and the patient is not reminded about them.
        </p>
        <p className="text-sm text-muted">
          Doses already taken, missed or skipped stay in the patient’s record.
          This cannot be undone from here.
        </p>
        {endSchedule.isError ? (
          <FormError
            error={endSchedule.error}
            title="The medication was not ended"
          />
        ) : null}
      </div>
    </Dialog>
  )
}
