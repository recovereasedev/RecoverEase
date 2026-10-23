import {
  LineCapStyle,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from 'pdf-lib'

import type { ScheduleWithPrescription } from '@/features/medications/api'
import {
  prescriberName,
  prescriberOf,
  type PrescriberDetails,
} from '@/features/medications/prescriber'
import type { Patient } from '@/features/patients/api'
import { reportDate, reportDateTime } from '@/features/reports/report-format'
import {
  documentFileName,
  PDF_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { toWinAnsi, wrapText } from '@/lib/documents/pdf'
import { calculateAge, formatScheduleTime } from '@/lib/format'
import { fullName } from '@/lib/utils'

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

// A4, in points.
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const LEFT = 48
const RIGHT = PAGE_WIDTH - 48
const WIDTH = RIGHT - LEFT
const TOP = 44
const FOOTER_Y = 34
const BOTTOM = 70

// The application's own tokens: brand-800, accent-700, accent-50,
// surface-sunken, border-strong, border, heading, body and muted.
const NAVY = rgb(0, 0.259, 0.412)
const TEAL = rgb(0, 0.42, 0.373)
const TEAL_SOFT = rgb(0.902, 0.984, 0.965)
const FIELD = rgb(0.941, 0.953, 1)
const BORDER = rgb(0.757, 0.78, 0.816)
const HAIRLINE = rgb(0.875, 0.898, 0.945)
const INK = rgb(0.067, 0.11, 0.176)
const BODY = rgb(0.255, 0.278, 0.31)
const MUTED = rgb(0.373, 0.4, 0.447)
const WHITE = rgb(1, 1, 1)

const NOT_AVAILABLE = 'Not available'
const NOT_RECORDED = 'Not recorded'

type Fonts = { regular: PDFFont; bold: PDFFont; serif: PDFFont }
type Colour = ReturnType<typeof rgb>
type TextOptions = { font?: PDFFont; size?: number; color?: Colour }

/** A rounded rectangle as an SVG path, its origin at the top left. */
function roundedRect(width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2)
  return [
    `M${r},0`,
    `H${width - r}`,
    `A${r},${r} 0 0 1 ${width},${r}`,
    `V${height - r}`,
    `A${r},${r} 0 0 1 ${width - r},${height}`,
    `H${r}`,
    `A${r},${r} 0 0 1 0,${height - r}`,
    `V${r}`,
    `A${r},${r} 0 0 1 ${r},0`,
    'Z',
  ].join(' ')
}

class Sheet {
  readonly pages: PDFPage[] = []
  page!: PDFPage
  /** The baseline the next line sits on, in PDF points from the bottom. */
  y = 0
  private readonly doc: PDFDocument
  readonly fonts: Fonts

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc
    this.fonts = fonts
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.pages.push(this.page)
    this.y = PAGE_HEIGHT - TOP
  }

  /** Room for `height` more points above the footer. */
  fits(height: number): boolean {
    return this.y - height >= BOTTOM
  }

  write(text: string, x: number, y: number, options: TextOptions = {}) {
    this.page.drawText(toWinAnsi(text), {
      x,
      y,
      size: options.size ?? 10.5,
      font: options.font ?? this.fonts.regular,
      color: options.color ?? INK,
    })
  }

  writeRight(text: string, right: number, y: number, options: TextOptions = {}) {
    const font = options.font ?? this.fonts.regular
    const size = options.size ?? 10.5
    this.write(text, right - font.widthOfTextAtSize(toWinAnsi(text), size), y, options)
  }

  /** Letters set apart, for the wordmark's strapline. */
  writeTracked(text: string, x: number, y: number, size: number, tracking: number, color: Colour) {
    let cursor = x
    for (const char of toWinAnsi(text)) {
      this.page.drawText(char, { x: cursor, y, size, font: this.fonts.regular, color })
      cursor += this.fonts.regular.widthOfTextAtSize(char, size) + tracking
    }
  }

  line(x1: number, x2: number, y: number, color = HAIRLINE, thickness = 0.75) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color })
  }

  box(
    x: number,
    top: number,
    width: number,
    height: number,
    options: { fill?: Colour; border?: Colour; radius?: number },
  ) {
    this.page.drawSvgPath(roundedRect(width, height, options.radius ?? 4), {
      x,
      y: top,
      ...(options.fill ? { color: options.fill } : {}),
      ...(options.border ? { borderColor: options.border, borderWidth: 0.75 } : {}),
    })
  }
}

/** The RecoverEase mark: the app's cross carrying a pulse, on a rounded tile. */
function drawMark(sheet: Sheet, x: number, top: number, size: number) {
  const scale = size / 32
  sheet.page.drawSvgPath(roundedRect(32, 32, 8), { x, y: top, scale, color: NAVY })
  sheet.page.drawSvgPath('M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z', {
    x,
    y: top,
    scale,
    color: WHITE,
    opacity: 0.22,
  })
  sheet.page.drawSvgPath('M5 16h4.6l2.2-4.4 3.4 8.2 2.6-5.4 1.7 1.6H27', {
    x,
    y: top,
    scale,
    borderColor: WHITE,
    borderWidth: 2.4,
    borderLineCap: LineCapStyle.Round,
  })
}

function drawLetterhead(sheet: Sheet, clinicName: string | null) {
  const top = PAGE_HEIGHT - TOP
  const { bold } = sheet.fonts
  drawMark(sheet, LEFT, top, 44)

  const wordmarkX = LEFT + 56
  sheet.write('Recover', wordmarkX, top - 26, { font: bold, size: 24, color: NAVY })
  sheet.write('Ease', wordmarkX + bold.widthOfTextAtSize('Recover', 24), top - 26, {
    font: bold,
    size: 24,
    color: TEAL,
  })
  sheet.writeTracked('POST-TREATMENT CARE', wordmarkX + 1, top - 41, 8, 1.6, MUTED)

  if (clinicName) {
    sheet.writeRight(clinicName, RIGHT, top - 18, { font: bold, size: 14, color: NAVY })
    sheet.writeRight('Prescription', RIGHT, top - 34, { size: 10, color: MUTED })
  } else {
    sheet.writeRight('Prescription', RIGHT, top - 18, { font: bold, size: 14, color: NAVY })
  }

  sheet.y = top - 62
  sheet.line(LEFT, RIGHT, sheet.y, TEAL, 1.5)
  sheet.y -= 26
}

/** The letterhead's slimmer form on a prescription's later sheets. */
function drawContinuation(sheet: Sheet, group: PrescriptionGroup) {
  const top = PAGE_HEIGHT - TOP
  drawMark(sheet, LEFT, top, 22)
  sheet.write('Prescription, continued', LEFT + 32, top - 15, {
    font: sheet.fonts.bold,
    size: 11,
    color: NAVY,
  })
  sheet.writeRight(`Issued ${reportDate(group.issuedDate)}`, RIGHT, top - 15, {
    size: 9.5,
    color: MUTED,
  })
  sheet.y = top - 32
  sheet.line(LEFT, RIGHT, sheet.y, TEAL, 1)
  sheet.y -= 22
}

function label(sheet: Sheet, text: string, x: number, y: number) {
  sheet.write(text, x, y, { font: sheet.fonts.bold, size: 10.5, color: TEAL })
}

function drawPrescriber(
  sheet: Sheet,
  group: PrescriptionGroup,
  prescriber: PrescriberDetails | null,
) {
  const { bold } = sheet.fonts
  const top = sheet.y
  label(sheet, 'Prescribing physician', LEFT, top)
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

function drawPatient(sheet: Sheet, input: PrescriptionDocumentInput) {
  const { bold } = sheet.fonts
  const { patient } = input
  const top = sheet.y
  label(sheet, 'Patient information', LEFT, top)
  sheet.write('Name', LEFT, top - 20, { size: 9.5, color: MUTED })
  sheet.write(fullName(patient.pat_first_name, patient.pat_last_name), LEFT, top - 37, {
    font: bold,
    size: 15,
  })

  const age = calculateAge(patient.pat_birth_date, input.generatedAt)
  const birth = patient.pat_birth_date
    ? `${reportDate(patient.pat_birth_date)}${age === null ? '' : ` (${age} ${age === 1 ? 'year' : 'years'} old)`}`
    : NOT_RECORDED
  sheet.write('Date of birth / Age', LEFT, top - 58, { size: 9.5, color: MUTED })
  sheet.write(birth, LEFT, top - 74, { font: bold, size: 12 })
  sheet.write('Gender', 330, top - 58, { size: 9.5, color: MUTED })
  sheet.write(patient.pat_gender?.trim() || NOT_RECORDED, 330, top - 74, {
    font: bold,
    size: 12,
  })

  sheet.y = top - 96
}

// Medication, Dosage, Instructions, Course: shares of the table's width.
const COLUMNS = [
  { title: 'Medication', share: 0.27 },
  { title: 'Dosage', share: 0.17 },
  { title: 'Instructions', share: 0.31 },
  { title: 'Course', share: 0.25 },
] as const
const CELL_PAD = 10
const CELL_SIZE = 10.5
const CELL_LEADING = CELL_SIZE * 1.35

function columnXs(): number[] {
  const xs: number[] = []
  let x = LEFT
  for (const column of COLUMNS) {
    xs.push(x)
    x += column.share * WIDTH
  }
  return [...xs, RIGHT]
}

/**
 * The medicines, one row each. A row too tall for what is left of the sheet
 * starts the next one, under a repeated header, so a row is never split.
 */
function drawMedicines(sheet: Sheet, group: PrescriptionGroup) {
  const { regular, bold } = sheet.fonts
  const xs = columnXs()
  const innerWidth = (index: number) => xs[index + 1]! - xs[index]! - CELL_PAD * 2

  // The ℞, as a prescription sheet sets it.
  sheet.write('Rx', LEFT, sheet.y - 30, { font: sheet.fonts.serif, size: 38, color: NAVY })
  sheet.y -= 46

  const headerHeight = 30
  let segmentTop = sheet.y

  const drawHeader = () => {
    segmentTop = sheet.y
    sheet.box(LEFT, segmentTop, WIDTH, headerHeight, { fill: TEAL_SOFT, radius: 6 })
    COLUMNS.forEach((column, index) => {
      sheet.write(column.title, xs[index]! + CELL_PAD, segmentTop - 19, {
        font: bold,
        size: 10.5,
        color: NAVY,
      })
    })
    sheet.y = segmentTop - headerHeight
  }

  const closeSegment = () => {
    // The table's outline and its column rules, for the rows on this sheet.
    sheet.box(LEFT, segmentTop, WIDTH, segmentTop - sheet.y, { border: BORDER, radius: 6 })
    for (const x of xs.slice(1, -1)) {
      sheet.page.drawLine({
        start: { x, y: segmentTop },
        end: { x, y: sheet.y },
        thickness: 0.75,
        color: BORDER,
      })
    }
  }

  drawHeader()
  group.schedules.forEach((schedule, rowIndex) => {
    const cells = [
      wrapText(schedule.medication_schedule_name, bold, CELL_SIZE, innerWidth(0)),
      wrapText(schedule.medication_schedule_dosage, regular, CELL_SIZE, innerWidth(1)),
      wrapText(scheduleInstructions(schedule), regular, CELL_SIZE, innerWidth(2)),
      wrapText(scheduleCourse(schedule), regular, CELL_SIZE, innerWidth(3)),
    ]
    const height =
      Math.max(...cells.map((lines) => lines.length)) * CELL_LEADING + CELL_PAD * 2

    if (!sheet.fits(height)) {
      closeSegment()
      sheet.newPage()
      drawContinuation(sheet, group)
      drawHeader()
    } else if (rowIndex > 0) {
      sheet.line(LEFT, RIGHT, sheet.y, BORDER)
    }

    const top = sheet.y
    cells.forEach((lines, index) => {
      lines.forEach((text, line) => {
        sheet.page.drawText(text, {
          x: xs[index]! + CELL_PAD,
          y: top - CELL_PAD - CELL_SIZE - line * CELL_LEADING,
          size: CELL_SIZE,
          font: index === 0 ? bold : regular,
          color: index === 0 ? INK : BODY,
        })
      })
    })
    sheet.y = top - height
  })
  closeSegment()
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
    drawContinuation(sheet, group)
  }

  label(sheet, 'Notes / additional instructions', LEFT, sheet.y)
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
    drawContinuation(sheet, group)
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
  drawLetterhead(sheet, input.clinicName)
  drawPrescriber(sheet, group, prescriber)
  drawPatient(sheet, input)
  drawMedicines(sheet, group)
  drawNotes(sheet, group)
  drawSignature(sheet, group, prescriber)
}

function drawNothingPrescribed(sheet: Sheet, input: PrescriptionDocumentInput) {
  sheet.newPage()
  drawLetterhead(sheet, input.clinicName)
  drawPatient(sheet, input)
  sheet.write('No prescriptions on record.', LEFT, sheet.y - 10, { size: 11, color: MUTED })
}

export async function buildPrescriptionPdf(
  input: PrescriptionDocumentInput,
): Promise<DownloadableFile> {
  const generated = reportDateTime(input.generatedAt.toISOString())
  const doc = await PDFDocument.create()
  doc.setTitle('Prescription', { showInWindowTitleBar: true })
  doc.setSubject('As recorded in RecoverEase')
  doc.setCreator('RecoverEase')
  doc.setProducer('RecoverEase')
  doc.setLanguage('en')
  doc.setCreationDate(input.generatedAt)
  doc.setModificationDate(input.generatedAt)

  const sheet = new Sheet(doc, {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRomanBold),
  })

  const groups = groupPrescriptions(input.schedules)
  if (groups.length === 0) drawNothingPrescribed(sheet, input)
  for (const group of groups) drawPrescription(sheet, input, group)

  // The footer goes on last, once the number of pages is known.
  sheet.pages.forEach((page, index) => {
    const text = toWinAnsi(
      `RecoverEase prescription · Generated ${generated} · Page ${index + 1} of ${sheet.pages.length}`,
    )
    const size = 8.5
    page.drawLine({
      start: { x: LEFT + 60, y: FOOTER_Y + 14 },
      end: { x: RIGHT - 60, y: FOOTER_Y + 14 },
      thickness: 0.75,
      color: TEAL,
    })
    page.drawText(text, {
      x: (PAGE_WIDTH - sheet.fonts.regular.widthOfTextAtSize(text, size)) / 2,
      y: FOOTER_Y,
      size,
      font: sheet.fonts.regular,
      color: MUTED,
    })
  })

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
