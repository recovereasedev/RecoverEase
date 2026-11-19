import type { ScheduleWithPrescription } from '@/features/medications/api'
import {
  prescriberName,
  prescriberOf,
  type PrescriberDetails,
} from '@/features/medications/prescriber'
import type { Patient } from '@/features/patients/api'
import { reportDate } from '@/features/reports/report-format'
import {
  documentFileName,
  PDF_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { wrapText } from '@/lib/documents/pdf'
import {
  BODY,
  BORDER,
  createSheetDocument,
  drawContinuation,
  drawFooters,
  drawLetterhead,
  drawPatientBlock,
  drawTable,
  FIELD,
  HAIRLINE,
  INK,
  LEFT,
  MUTED,
  NAVY,
  NOT_AVAILABLE,
  NOT_RECORDED,
  RIGHT,
  sectionLabel,
  type Sheet,
  TEAL,
  WIDTH,
} from '@/lib/documents/sheet'
import { formatScheduleTime } from '@/lib/format'

/**
 * Module 4.10, "Download Prescription": the patient's prescriptions as a PDF,
 * laid out as a prescription sheet - a letterhead, the prescribing physician,
 * the date issued and the prescription's id, the patient, the ℞ and its
 * medicines, the doctor's instructions, and the prescriber's block.
 *
 * One sheet per prescription, newest first, because a prescription is one
 * doctor's order on one date: its medicines are the schedules issued under
 * it, and its prescriber is the doctor who issued it (`prescription.doc_id`),
 * not whoever is treating the patient today.
 *
 * Everything on a sheet is a field the reader's own access returned. What
 * the records do not hold is left off rather than made up: the clinic keeps a
 * name but no address or telephone, a schedule carries no quantity to
 * dispense, and nothing stores a signature, so the signature line is left
 * blank. A prescriber is named only when the reader may read that doctor -
 * for a patient, their current doctor; for a doctor, themselves - and is
 * otherwise "Not available".
 *
 * Built in the browser from what the page has loaded, with pdf-lib and the
 * PDF standard fonts, and handed straight to the download - nothing is
 * uploaded or stored.
 */

export type PrescriptionDocumentInput = {
  patient: Pick<
    Patient,
    'pat_first_name' | 'pat_last_name' | 'pat_birth_date' | 'pat_gender'
  >
  /** The doctors the reader may read. A prescription names its prescriber only when they are here. */
  doctors: readonly (PrescriberDetails | null | undefined)[]
  /** The reader's clinic, when it could be read; left off the letterhead otherwise. */
  clinicName: string | null
  schedules: readonly ScheduleWithPrescription[]
  generatedAt: Date
}

export type PrescriptionGroup = {
  prescriptionId: string
  issuedDate: string | null
  doctorId: string | null
  notes: string | null
  schedules: ScheduleWithPrescription[]
}

/** The schedules under each prescription, newest prescription first. */
export function groupPrescriptions(
  schedules: readonly ScheduleWithPrescription[],
): PrescriptionGroup[] {
  const groups = new Map<string, PrescriptionGroup>()
  for (const schedule of schedules) {
    const prescription = schedule.prescription
    const id = prescription?.prescription_id ?? schedule.prescription_id
    let group = groups.get(id)
    if (!group) {
      group = {
        prescriptionId: id,
        issuedDate: prescription?.prescription_issued_date ?? null,
        doctorId: prescription?.doc_id ?? null,
        notes: prescription?.prescription_notes ?? null,
        schedules: [],
      }
      groups.set(id, group)
    }
    group.schedules.push(schedule)
  }
  return [...groups.values()].sort(
    (a, b) =>
      (b.issuedDate ?? '').localeCompare(a.issuedDate ?? '') ||
      a.prescriptionId.localeCompare(b.prescriptionId),
  )
}

/** How often and when, in the words the screen uses. */
export function scheduleInstructions(schedule: ScheduleWithPrescription): string {
  const times = schedule.medication_schedule_times.map(formatScheduleTime).join(', ')
  const frequency = schedule.medication_schedule_frequency
  return `${frequency} ${frequency === 1 ? 'time' : 'times'} a day at ${times}`
}

/** The course, from its start to its end or "ongoing". */
export function scheduleCourse(schedule: ScheduleWithPrescription): string {
  const start = reportDate(schedule.medication_schedule_start_date)
  return schedule.medication_schedule_end_date
    ? `${start} to ${reportDate(schedule.medication_schedule_end_date)}`
    : `From ${start}, ongoing`
}

// --- The sheet ---------------------------------------------------------------
//
// Drawn on the shared RecoverEase sheet (`@/lib/documents/sheet`), which the
// treatment plan uses too.

/** The letterhead's slimmer form on a prescription's later sheets. */
function continuePrescription(sheet: Sheet, group: PrescriptionGroup) {
  drawContinuation(sheet, 'Prescription, continued', `Issued ${reportDate(group.issuedDate)}`)
}

function drawPrescriber(
  sheet: Sheet,
  group: PrescriptionGroup,
  prescriber: PrescriberDetails | null,
) {
  const { bold } = sheet.fonts
  const top = sheet.y
  sectionLabel(sheet, 'Prescribing physician', LEFT, top)
  sheet.write(prescriber ? prescriberName(prescriber) : NOT_AVAILABLE, LEFT, top - 24, {
    font: bold,
    size: 18,
  })
  let y = top - 42
  if (prescriber) {
    if (prescriber.doc_specialization) {
      sheet.write(prescriber.doc_specialization, LEFT, y, { size: 11, color: BODY })
      y -= 16
    }
    sheet.write(`Licence no.: ${prescriber.doc_license_no}`, LEFT, y, { size: 11, color: BODY })
  } else {
    sheet.write("The prescriber's details are not available to this account.", LEFT, y, {
      size: 9.5,
      color: MUTED,
    })
  }

  // The date and the id, in fields of their own on the right.
  const boxX = 330
  const boxWidth = RIGHT - boxX
  sheet.write('Date issued', boxX, top, { size: 10, color: MUTED })
  sheet.box(boxX, top - 6, boxWidth, 24, { fill: FIELD, border: HAIRLINE })
  sheet.write(reportDate(group.issuedDate), boxX + 10, top - 22, { size: 11 })
  sheet.write('Prescription ID', boxX, top - 44, { size: 10, color: MUTED })
  sheet.box(boxX, top - 50, boxWidth, 24, { fill: FIELD, border: HAIRLINE })
  sheet.write(group.prescriptionId, boxX + 10, top - 65.5, { size: 8.5, color: BODY })

  sheet.y = top - 92
  sheet.line(LEFT, RIGHT, sheet.y)
  sheet.y -= 22
}

// Medication, Dosage, Instructions, Course: shares of the table's width.
const COLUMNS = [
  { title: 'Medication', share: 0.27 },
  { title: 'Dosage', share: 0.17 },
  { title: 'Instructions', share: 0.31 },
  { title: 'Course', share: 0.25 },
] as const

/** The ℞, then the medicines, one row each (`drawTable`). */
function drawMedicines(sheet: Sheet, group: PrescriptionGroup) {
  // The ℞, as a prescription sheet sets it.
  sheet.write('Rx', LEFT, sheet.y - 30, { font: sheet.fonts.serif, size: 38, color: NAVY })
  sheet.y -= 46

  drawTable(
    sheet,
    COLUMNS,
    group.schedules.map((schedule) => [
      { text: schedule.medication_schedule_name, bold: true, color: INK },
      { text: schedule.medication_schedule_dosage },
      { text: scheduleInstructions(schedule) },
      { text: scheduleCourse(schedule) },
    ]),
    () => continuePrescription(sheet, group),
  )
  sheet.y -= 26
}

function drawNotes(sheet: Sheet, group: PrescriptionGroup) {
  const { regular } = sheet.fonts
  const notes = (group.notes ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const wrapped = notes.map((note) => wrapText(note, regular, 10.5, WIDTH - 16))
  const height = 22 + Math.max(1, wrapped.flat().length) * 15
  if (!sheet.fits(height)) {
    sheet.newPage()
    continuePrescription(sheet, group)
  }

  sectionLabel(sheet, 'Notes / additional instructions', LEFT, sheet.y)
  sheet.y -= 20
  if (wrapped.length === 0) {
    sheet.write('None recorded.', LEFT, sheet.y, { size: 10.5, color: MUTED })
    sheet.y -= 15
  }
  for (const lines of wrapped) {
    sheet.write('•', LEFT + 2, sheet.y, { size: 10.5, color: TEAL })
    for (const text of lines) {
      sheet.write(text, LEFT + 16, sheet.y, { size: 10.5, color: BODY })
      sheet.y -= 15
    }
  }
  sheet.y -= 24
}

/**
 * The prescriber's block: the physician's printed details, and a signature
 * line left blank - RecoverEase stores no signature, so none is drawn.
 */
function drawSignature(
  sheet: Sheet,
  group: PrescriptionGroup,
  prescriber: PrescriberDetails | null,
) {
  const height = 112
  if (!sheet.fits(height)) {
    sheet.newPage()
    continuePrescription(sheet, group)
  }
  const top = sheet.y
  const rows: [string, string][] = [
    ['Printed name', prescriber ? prescriberName(prescriber) : NOT_AVAILABLE],
    [
      'Specialisation',
      prescriber ? prescriber.doc_specialization || NOT_RECORDED : NOT_AVAILABLE,
    ],
    ['Licence no.', prescriber ? prescriber.doc_license_no : NOT_AVAILABLE],
    ['Contact no.', prescriber ? prescriber.doc_contact_no || NOT_RECORDED : NOT_AVAILABLE],
  ]
  rows.forEach(([name, value], index) => {
    const y = top - index * 24
    sheet.write(name, 300, y, { size: 9.5, color: TEAL })
    sheet.write(value, 390, y, { size: 10.5 })
    sheet.line(390, RIGHT, y - 7, BORDER)
  })

  sheet.line(LEFT, 240, top - 62, INK, 0.75)
  sheet.write("Prescriber's signature", LEFT, top - 78, { size: 10, color: TEAL })
  sheet.y = top - height
}

function drawPrescription(
  sheet: Sheet,
  input: PrescriptionDocumentInput,
  group: PrescriptionGroup,
) {
  const prescriber = prescriberOf(group.doctorId, input.doctors)
  sheet.newPage()
  drawLetterhead(sheet, input.clinicName, 'Prescription')
  drawPrescriber(sheet, group, prescriber)
  drawPatientBlock(sheet, input.patient, input.generatedAt)
  drawMedicines(sheet, group)
  drawNotes(sheet, group)
  drawSignature(sheet, group, prescriber)
}

function drawNothingPrescribed(sheet: Sheet, input: PrescriptionDocumentInput) {
  sheet.newPage()
  drawLetterhead(sheet, input.clinicName, 'Prescription')
  drawPatientBlock(sheet, input.patient, input.generatedAt)
  sheet.write('No prescriptions on record.', LEFT, sheet.y - 10, { size: 11, color: MUTED })
}

export async function buildPrescriptionPdf(
  input: PrescriptionDocumentInput,
): Promise<DownloadableFile> {
  const { doc, sheet } = await createSheetDocument('Prescription', input.generatedAt)

  const groups = groupPrescriptions(input.schedules)
  if (groups.length === 0) drawNothingPrescribed(sheet, input)
  for (const group of groups) drawPrescription(sheet, input, group)

  drawFooters(sheet, 'prescription', input.generatedAt)

  return {
    bytes: await doc.save(),
    mimeType: PDF_TYPE,
    fileName: documentFileName(
      ['prescription', input.patient.pat_first_name, input.patient.pat_last_name],
      input.generatedAt,
      'pdf',
    ),
  }
}
