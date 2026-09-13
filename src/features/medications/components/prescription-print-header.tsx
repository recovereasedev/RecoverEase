import type { Doctor, Patient } from '@/features/patients/api'
import {
  ReportFacts,
  ReportLetterhead,
} from '@/features/reports/components/report-document'
import { reportDateTime } from '@/features/reports/report-format'
import { fullName } from '@/lib/utils'

/**
 * The top of the printed prescription (QA 9/13): whose prescription it is and
 * who their doctor is, above the prescriptions the page already lists.
 *
 * Print-only. The screen already says whose page it is, so nothing on screen
 * changes. Both names come from the records: the signed-in patient's own row,
 * and their assigned doctor, who issues their prescriptions (module 4.3).
 * When the doctor cannot be read the sheet says so rather than naming anyone.
 */
export function PrescriptionPrintHeader({
  patient,
  doctor,
  printedAt,
}: {
  patient: Pick<Patient, 'pat_first_name' | 'pat_last_name'>
  doctor: Pick<Doctor, 'doc_first_name' | 'doc_last_name'> | null | undefined
  printedAt: string
}) {
  return (
    <div
      data-prescription-print-header
      className="mb-5 hidden text-[12px] leading-[1.5] text-body print:block"
    >
      <ReportLetterhead
        title="Prescription"
        subtitle="As recorded in RecoverEase"
        meta={
          <p>
            <span className="text-muted">Printed</span>{' '}
            <span className="font-semibold text-heading" data-numeric>
              {reportDateTime(printedAt)}
            </span>
          </p>
        }
      />
      <ReportFacts
        items={[
          {
            label: 'Patient',
            value: fullName(patient.pat_first_name, patient.pat_last_name),
          },
          {
            label: 'Doctor',
            value: doctor
              ? `Dr. ${fullName(doctor.doc_first_name, doctor.doc_last_name)}`
              : 'Not available',
          },
        ]}
      />
    </div>
  )
}
