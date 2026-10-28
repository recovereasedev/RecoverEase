import {
  LineCapStyle,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from 'pdf-lib'

import type { Patient } from '@/features/patients/api'
import { reportDate, reportDateTime } from '@/features/reports/report-format'
import { toWinAnsi, wrapText } from '@/lib/documents/pdf'
import { calculateAge } from '@/lib/format'
import { fullName } from '@/lib/utils'

/**
 * The RecoverEase document sheet: the page, letterhead, section labels,
 * fields and footer that the prescription (module 4.10) and the treatment
 * plan (module 3.5) are drawn on, so the two read as one family of documents
 * and cannot drift apart. Each document draws its own content between the
 * letterhead and the footer.
 *
 * A4, the PDF standard fonts (see `toWinAnsi` for what they can draw), and
 * the application's own colour tokens.
 */

// A4, in points.
export const PAGE_WIDTH = 595.28
export const PAGE_HEIGHT = 841.89
export const LEFT = 48
export const RIGHT = PAGE_WIDTH - 48
export const WIDTH = RIGHT - LEFT
export const TOP = 44
const FOOTER_Y = 34
const BOTTOM = 70

// The application's own tokens: brand-800, accent-700, accent-50,
// surface-sunken, border-strong, border, heading, body and muted.
export const NAVY = rgb(0, 0.259, 0.412)
export const TEAL = rgb(0, 0.42, 0.373)
export const TEAL_SOFT = rgb(0.902, 0.984, 0.965)
export const FIELD = rgb(0.941, 0.953, 1)
export const BORDER = rgb(0.757, 0.78, 0.816)
export const HAIRLINE = rgb(0.875, 0.898, 0.945)
export const INK = rgb(0.067, 0.11, 0.176)
export const BODY = rgb(0.255, 0.278, 0.31)
export const MUTED = rgb(0.373, 0.4, 0.447)
export const WHITE = rgb(1, 1, 1)
// success-700, info-700 and warning-700: a state's colour, beside its words.
export const SUCCESS = rgb(0.039, 0.373, 0.216)
export const INFO = rgb(0, 0.29, 0.459)
export const WARNING = rgb(0.494, 0.286, 0)

export const NOT_AVAILABLE = 'Not available'
export const NOT_RECORDED = 'Not recorded'

export type Fonts = { regular: PDFFont; bold: PDFFont; serif: PDFFont }
export type Colour = ReturnType<typeof rgb>
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

export class Sheet {
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

/**
 * The first page's letterhead: the RecoverEase wordmark on the left, and on
 * the right the reader's clinic, when it could be read, over what the
 * document is.
 */
export function drawLetterhead(sheet: Sheet, clinicName: string | null, documentTitle: string) {
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
    sheet.writeRight(documentTitle, RIGHT, top - 34, { size: 10, color: MUTED })
  } else {
    sheet.writeRight(documentTitle, RIGHT, top - 18, { font: bold, size: 14, color: NAVY })
  }

  sheet.y = top - 62
  sheet.line(LEFT, RIGHT, sheet.y, TEAL, 1.5)
  sheet.y -= 26
}

/** The letterhead's slimmer form on a document's later pages. */
export function drawContinuation(sheet: Sheet, title: string, aside: string) {
  const top = PAGE_HEIGHT - TOP
  drawMark(sheet, LEFT, top, 22)
  sheet.write(title, LEFT + 32, top - 15, {
    font: sheet.fonts.bold,
    size: 11,
    color: NAVY,
  })
  sheet.writeRight(aside, RIGHT, top - 15, { size: 9.5, color: MUTED })
  sheet.y = top - 32
  sheet.line(LEFT, RIGHT, sheet.y, TEAL, 1)
  sheet.y -= 22
}

/** A section's label, in the accent colour. */
export function sectionLabel(sheet: Sheet, text: string, x: number, y: number) {
  sheet.write(text, x, y, { font: sheet.fonts.bold, size: 10.5, color: TEAL })
}

/**
 * The patient's block: name, date of birth with age, and gender, each
 * "Not recorded" where the record has none.
 */
export function drawPatientBlock(
  sheet: Sheet,
  patient: Pick<Patient, 'pat_first_name' | 'pat_last_name' | 'pat_birth_date' | 'pat_gender'>,
  generatedAt: Date,
) {
  const { bold } = sheet.fonts
  const top = sheet.y
  sectionLabel(sheet, 'Patient information', LEFT, top)
  sheet.write('Name', LEFT, top - 20, { size: 9.5, color: MUTED })
  sheet.write(fullName(patient.pat_first_name, patient.pat_last_name), LEFT, top - 37, {
    font: bold,
    size: 15,
  })

  const age = calculateAge(patient.pat_birth_date, generatedAt)
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

/** A column's heading and its share of the sheet's width; a table's add up to 1. */
export type SheetColumn = { title: string; share: number }
/** A cell: its text, wrapped to the column, and whether it leads the row. */
export type SheetCell = { text: string; bold?: boolean; color?: Colour }

const CELL_PAD = 10
const CELL_SIZE = 10.5
const CELL_LEADING = CELL_SIZE * 1.35
const HEADER_HEIGHT = 30

/**
 * A table, one row per entry. A row too tall for what is left of the page
 * starts the next one - `continuePage` draws that page's slim letterhead -
 * under a repeated header, so a row is never split.
 */
export function drawTable(
  sheet: Sheet,
  columns: readonly SheetColumn[],
  rows: readonly SheetCell[][],
  continuePage: () => void,
) {
  const { regular, bold } = sheet.fonts
  const xs: number[] = []
  let x = LEFT
  for (const column of columns) {
    xs.push(x)
    x += column.share * WIDTH
  }
  xs.push(RIGHT)
  const innerWidth = (index: number) => xs[index + 1]! - xs[index]! - CELL_PAD * 2

  let segmentTop = sheet.y

  const drawHeader = () => {
    segmentTop = sheet.y
    sheet.box(LEFT, segmentTop, WIDTH, HEADER_HEIGHT, { fill: TEAL_SOFT, radius: 6 })
    columns.forEach((column, index) => {
      sheet.write(column.title, xs[index]! + CELL_PAD, segmentTop - 19, {
        font: bold,
        size: 10.5,
        color: NAVY,
      })
    })
    sheet.y = segmentTop - HEADER_HEIGHT
  }

  const closeSegment = () => {
    // The table's outline and its column rules, for the rows on this page.
    sheet.box(LEFT, segmentTop, WIDTH, segmentTop - sheet.y, { border: BORDER, radius: 6 })
    for (const rule of xs.slice(1, -1)) {
      sheet.page.drawLine({
        start: { x: rule, y: segmentTop },
        end: { x: rule, y: sheet.y },
        thickness: 0.75,
        color: BORDER,
      })
    }
  }

  drawHeader()
  rows.forEach((row, rowIndex) => {
    const cells = row.map((cell, index) =>
      wrapText(cell.text, cell.bold ? bold : regular, CELL_SIZE, innerWidth(index)),
    )
    const height =
      Math.max(...cells.map((lines) => lines.length)) * CELL_LEADING + CELL_PAD * 2

    if (!sheet.fits(height)) {
      closeSegment()
      sheet.newPage()
      continuePage()
      drawHeader()
    } else if (rowIndex > 0) {
      sheet.line(LEFT, RIGHT, sheet.y, BORDER)
    }

    const top = sheet.y
    cells.forEach((lines, index) => {
      const cell = row[index]!
      lines.forEach((text, line) => {
        sheet.page.drawText(text, {
          x: xs[index]! + CELL_PAD,
          y: top - CELL_PAD - CELL_SIZE - line * CELL_LEADING,
          size: CELL_SIZE,
          font: cell.bold ? bold : regular,
          color: cell.color ?? BODY,
        })
      })
    })
    sheet.y = top - height
  })
  closeSegment()
}

/** A new document and its sheet, titled and dated, with the three fonts embedded. */
export async function createSheetDocument(
  title: string,
  generatedAt: Date,
): Promise<{ doc: PDFDocument; sheet: Sheet }> {
  const doc = await PDFDocument.create()
  doc.setTitle(title, { showInWindowTitleBar: true })
  doc.setSubject('As recorded in RecoverEase')
  doc.setCreator('RecoverEase')
  doc.setProducer('RecoverEase')
  doc.setLanguage('en')
  doc.setCreationDate(generatedAt)
  doc.setModificationDate(generatedAt)

  const sheet = new Sheet(doc, {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRomanBold),
  })
  return { doc, sheet }
}

/**
 * The running footer, drawn last, once the number of pages is known:
 * "RecoverEase <what> · Generated <when> · Page n of m".
 */
export function drawFooters(sheet: Sheet, what: string, generatedAt: Date) {
  const generated = reportDateTime(generatedAt.toISOString())
  sheet.pages.forEach((page, index) => {
    const text = toWinAnsi(
      `RecoverEase ${what} · Generated ${generated} · Page ${index + 1} of ${sheet.pages.length}`,
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
}
