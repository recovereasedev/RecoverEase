import type { MedicationLog } from './api'
import type { PatientDoseState } from '@/lib/status'

/**
 * Where a dose stands on the patient's own screens (QA 9/13): Due, Overdue,
 * Missed, Taken or Skipped.
 *
 * Only a `pending` dose is decided here, by comparing its scheduled time with
 * `now`. Every other state is the database's. In particular Missed is only
 * ever what the overdue job recorded once the grace period ran out; that rule
 * is not repeated here, so a dose past the grace period that the hourly job
 * has not yet written off is still pending, can still be recorded, and still
 * reads Overdue.
 *
 * At the scheduled instant itself a dose is still Due; it is Overdue once that
 * time is earlier than now. That is the same strict comparison the appointment
 * screens use for a time in the past, and the overdue job uses for its own
 * threshold.
 */
export function patientDoseState(
  dose: Pick<MedicationLog, 'medication_log_status' | 'medication_log_scheduled_at'>,
  now: number = Date.now(),
): PatientDoseState {
  switch (dose.medication_log_status) {
    case 'taken':
      return 'taken'
    case 'skipped':
      return 'skipped'
    case 'missed':
      return 'missed'
    case 'pending':
      // An unreadable time compares false, so it stays Due rather than being
      // announced as late.
      return new Date(dose.medication_log_scheduled_at).getTime() < now
        ? 'overdue'
        : 'due'
  }
}
