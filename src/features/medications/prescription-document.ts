import type { ScheduleWithPrescription } from '@/features/medications/api'
import type { Doctor, Patient } from '@/features/patients/api'
import { reportDate, reportDateTime } from '@/features/reports/report-format'
import {
  documentFileName,
  PDF_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { renderPdf, type PdfBlock } from '@/lib/documents/pdf'
import { formatScheduleTime } from '@/lib/format'
import { fullName } from '@/lib/utils'

/**
 * Module 4.10, "Download Prescription": the printed prescription (QA 9/12,
 * 9/13) as a PDF file.
 *
 * It carries what the printed one does - whose prescription it is, their
 * doctor, and each medicine with its dose, how often and when, its course,
 * and the doctor's instructions - from the schedules the page has already
 * loaded. The doctor is named only when the caller passes them, which both
 * pages do only for the patient's assigned doctor, who issues their
 * prescriptions (module 4.3); otherwise it says "Not available" rather than
 * naming anyone.
 */
export type PrescriptionDocumentInput = {
  patient: Pick<Patient, 'pat_first_name' | 'pat_last_name'>
  doctor: Pick<Doctor, 'doc_first_name' | 'doc_last_name'> | null | undefined
  schedules: ScheduleWithPrescription[]
  generatedAt: Date
}

/** How a schedule reads, in the words the screen and the printout use. */
export function describeSchedule(schedule: ScheduleWithPrescription): string[] {
  const times = schedule.medication_schedule_times.map(formatScheduleTime).join(', ')
  const frequency = schedule.medication_schedule_frequency
  return [
    `${schedule.medication_schedule_dosage} · ${frequency} ${frequency === 1 ? 'time' : 'times'} a day at ${times}`,
    `From ${reportDate(schedule.medication_schedule_start_date)}${
      schedule.medication_schedule_end_date
        ? ` until ${reportDate(schedule.medication_schedule_end_date)}`
        : ', ongoing'
    }`,
  ]
}

export function prescriptionBlocks(input: PrescriptionDocumentInput): PdfBlock[] {
  const blocks: PdfBlock[] = [
    {
      kind: 'facts',
      items: [
        {
          label: 'Patient',
          value: fullName(input.patient.pat_first_name, input.patient.pat_last_name),
        },
        {
          label: 'Doctor',
          value: input.doctor
            ? `Dr. ${fullName(input.doctor.doc_first_name, input.doctor.doc_last_name)}`
            : 'Not available',
        },
      ],
    },
    { kind: 'heading', text: 'Medicines' },
  ]

  if (input.schedules.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No prescriptions on record.', tone: 'muted' })
    return blocks
  }

  for (const schedule of input.schedules) {
    blocks.push({
      kind: 'item',
      title: schedule.medication_schedule_name,
      lines: describeSchedule(schedule),
      note: schedule.prescription?.prescription_notes ?? null,
    })
  }
  return blocks
}

export async function buildPrescriptionPdf(
  input: PrescriptionDocumentInput,
): Promise<DownloadableFile> {
  const generated = reportDateTime(input.generatedAt.toISOString())
  const bytes = await renderPdf({
    title: 'Prescription',
    subtitle: 'As recorded in RecoverEase',
    meta: [{ label: 'Generated', value: generated }],
    blocks: prescriptionBlocks(input),
    footer: `RecoverEase prescription · Generated ${generated}`,
    generatedAt: input.generatedAt,
  })
  return {
    bytes,
    mimeType: PDF_TYPE,
    fileName: documentFileName(
      ['prescription', input.patient.pat_first_name, input.patient.pat_last_name],
      input.generatedAt,
      'pdf',
    ),
  }
}
