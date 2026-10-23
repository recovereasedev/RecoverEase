import type { ScheduleWithPrescription } from '@/features/medications/api'
import type { Doctor } from '@/features/patients/api'
import { fullName } from '@/lib/utils'

/**
 * Who issued a prescription, as far as the reader may know.
 *
 * A prescription records the doctor who issued it (`prescription.doc_id`).
 * That is its prescriber - not whoever is treating the patient today, who
 * may have taken the patient over since. A doctor is named only when the
 * reader's own access returned them: for a patient, their current doctor
 * (`doctor_select` lets a patient read no other); for a doctor, themselves.
 * Anyone else is "Not available", never a guess.
 *
 * Kept apart from the PDF builder so the screens can use it without loading
 * pdf-lib.
 */

export type PrescriberDetails = Pick<
  Doctor,
  | 'doc_id'
  | 'doc_first_name'
  | 'doc_last_name'
  | 'doc_specialization'
  | 'doc_license_no'
  | 'doc_contact_no'
>

/** The prescription's own doctor, if they are one of the doctors the reader may read. */
export function prescriberOf(
  doctorId: string | null | undefined,
  doctors: readonly (PrescriberDetails | null | undefined)[],
): PrescriberDetails | null {
  if (!doctorId) return null
  return doctors.find((doctor) => doctor?.doc_id === doctorId) ?? null
}

/** "Dr. Alan Cruz", for a prescriber who could be read. */
export function prescriberName(doctor: Pick<Doctor, 'doc_first_name' | 'doc_last_name'>): string {
  return `Dr. ${fullName(doctor.doc_first_name, doctor.doc_last_name)}`
}

/** "Prescribed by Dr. Alan Cruz", or "Prescriber not available". */
export function prescribedBy(
  schedule: ScheduleWithPrescription,
  doctor: PrescriberDetails | null | undefined,
): string {
  const prescriber = prescriberOf(schedule.prescription?.doc_id, [doctor])
  return prescriber ? `Prescribed by ${prescriberName(prescriber)}` : 'Prescriber not available'
}
