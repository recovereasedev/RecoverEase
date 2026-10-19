import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from 'pdf-lib'

/**
 * Real PDF files for the documents RecoverEase lets people download: the
 * prescription (module 4.10), the treatment plan (module 3.5) and the
 * system-wide report (module 9.4).
 *
 * Built in the browser from what the page has already loaded under the
 * signed-in user's own access, and handed straight to the browser's download.
 * Nothing is uploaded or stored anywhere, so a document can never contain
 * more than its reader could already see.
 *
 * The layout is deliberately small: a letterhead, labelled facts, section
 * headings, wrapped paragraphs, list items and simple tables, on A4 with a
 * running footer - the same shapes the printed versions use. Print stays
 * available beside each download; the browser's own "Save as PDF" also
 * produces a tagged PDF, which this one is not.
 *
 * Text is set in the PDF standard Helvetica, which covers Windows-1252: every
 * letter of a Filipino or English name and the punctuation the app writes.
 * Anything outside it is replaced by "?" rather than failing the download
 * (see `toWinAnsi`).
 */

export type PdfFact = { label: string; value: string }

export type PdfTableColumn = {
  label: string
  /** A share of the text width; the shares of a table add up to 1. */
  width: number
  align?: 'left' | 'right'
}

export type PdfBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'paragraph'; text: string; tone?: 'body' | 'muted' }
  | { kind: 'facts'; items: PdfFact[] }
  | {
      kind: 'item'
      title: string
      lines?: string[]
      /** Set apart under the item, e.g. a prescription's instructions. */
      note?: string | null
    }
  | { kind: 'table'; columns: PdfTableColumn[]; rows: string[][]; empty?: string }

export type PdfDocumentInput = {
  title: string
  subtitle?: string
  /** Shown under the letterhead, e.g. Generated or Prepared by. */
  meta: PdfFact[]
  blocks: PdfBlock[]
  /** The running footer's left half; the page number is the right half. */
  footer: string
  generatedAt: Date
}

// A4, in points.
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN_X = 56
const MARGIN_TOP = 60
const MARGIN_BOTTOM = 64
const TEXT_WIDTH = PAGE_WIDTH - MARGIN_X * 2

const INK = rgb(0.106, 0.129, 0.165)
const MUTED = rgb(0.373, 0.4, 0.447)
const RULE = rgb(0.82, 0.84, 0.87)
const BRAND = rgb(0.059, 0.38, 0.4)

const SIZE = { title: 20, heading: 13, subheading: 11, body: 10.5, small: 9 }
const LEADING = 1.35

/** Characters Helvetica's WinAnsi encoding has beyond Latin-1. */
const CP1252_EXTRA = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''),
)

/**
 * Text Helvetica can draw. Control characters become spaces (a line break
 * is handled before this is called), and anything outside Windows-1252 - an
 * emoji, a peso sign, a script Helvetica has no glyphs for - becomes "?".
 * pdf-lib would otherwise throw, and a whole document would fail to download
 * over one character.
 */
export function toWinAnsi(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) out += ' '
    else if (code < 0x7f || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(char)) out += char
    else out += '?'
  }
  return out
}

/** Breaks text into lines that fit `width` at `size`, keeping its own line breaks. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = toWinAnsi(paragraph).split(/ +/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      // A single word wider than the line - a long reference or address -
      // is broken where it has to be rather than run off the page.
      let rest = word
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}

class Layout {
  page!: PDFPage
  y = 0
  readonly pages: PDFPage[] = []
  readonly regular: PDFFont
  readonly bold: PDFFont
  private readonly doc: PDFDocument

  constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.doc = doc
    this.regular = regular
    this.bold = bold
    this.addPage()
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.pages.push(this.page)
    this.y = PAGE_HEIGHT - MARGIN_TOP
  }

  /** Starts a new page unless `height` more points fit on this one. */
  ensure(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.addPage()
  }

  gap(points: number) {
    this.y -= points
  }

  text(
    value: string,
    options: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {},
  ) {
    const font = options.font ?? this.regular
    const size = options.size ?? SIZE.body
    const x = options.x ?? MARGIN_X
    const width = options.width ?? TEXT_WIDTH
    const lineHeight = size * LEADING
    for (const line of wrapText(value, font, size, width)) {
      this.ensure(lineHeight)
      this.y -= size
      this.page.drawText(line, { x, y: this.y, size, font, color: options.color ?? INK })
      this.y -= lineHeight - size
    }
  }

  rule(color = RULE, thickness = 0.75) {
    this.ensure(thickness + 2)
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN_X, y: this.y },
      thickness,
      color,
    })
  }
}

function drawLetterhead(layout: Layout, input: PdfDocumentInput) {
  layout.text('RecoverEase', { font: layout.bold, size: SIZE.small, color: BRAND })
  layout.gap(6)
  layout.text(input.title, { font: layout.bold, size: SIZE.title })
  if (input.subtitle) {
    layout.gap(2)
    layout.text(input.subtitle, { size: SIZE.body, color: MUTED })
  }
  layout.gap(10)
  for (const { label, value } of input.meta) {
    drawFact(layout, label, value)
  }
  layout.gap(8)
  layout.rule(BRAND, 1.25)
  layout.gap(16)
}

/** A label with its value beside it, on the same baseline. */
function drawFact(layout: Layout, label: string, value: string) {
  const labelWidth = 120
  // Label and value start on the same page, side by side.
  layout.ensure(SIZE.body * LEADING * 2)
  const page = layout.page
  const top = layout.y
  layout.text(label, { color: MUTED, width: labelWidth - 8 })
  const belowLabel = layout.y
  layout.y = top
  layout.text(value, {
    font: layout.bold,
    x: MARGIN_X + labelWidth,
    width: TEXT_WIDTH - labelWidth,
  })
  // Below whichever of the two ran longer - unless a long value carried on
  // onto the next page, where the label's position no longer applies.
  if (layout.page === page) layout.y = Math.min(layout.y, belowLabel)
  layout.gap(3)
}

function drawTable(layout: Layout, block: Extract<PdfBlock, { kind: 'table' }>) {
  const xs: number[] = []
  let x = MARGIN_X
  for (const column of block.columns) {
    xs.push(x)
    x += column.width * TEXT_WIDTH
  }
  const cell = (
    texts: string[],
    font: PDFFont,
    color: ReturnType<typeof rgb>,
  ) => {
    // Every cell of a row is wrapped first, so the row is as tall as its
    // tallest cell and starts on a new page whole.
    const size = SIZE.body
    const lineHeight = size * LEADING
    const wrapped = block.columns.map((column, index) =>
      wrapText(texts[index] ?? '', font, size, column.width * TEXT_WIDTH - 8),
    )
    const height = Math.max(...wrapped.map((lines) => lines.length)) * lineHeight
    layout.ensure(height + 6)
    const top = layout.y
    wrapped.forEach((lines, index) => {
      const column = block.columns[index]!
      lines.forEach((line, row) => {
        const width = font.widthOfTextAtSize(line, size)
        const cellX =
          column.align === 'right'
            ? xs[index]! + column.width * TEXT_WIDTH - 8 - width
            : xs[index]!
        layout.page.drawText(line, {
          x: cellX,
          y: top - size - row * lineHeight,
          size,
          font,
          color,
        })
      })
    })
    layout.y = top - height - 4
    layout.rule()
    layout.gap(5)
  }

  cell(block.columns.map((column) => column.label), layout.bold, MUTED)
  if (block.rows.length === 0) {
    layout.text(block.empty ?? 'None.', { color: MUTED })
    return
  }
  for (const row of block.rows) cell(row, layout.regular, INK)
}

function drawBlock(layout: Layout, block: PdfBlock) {
  switch (block.kind) {
    case 'heading':
      // A heading is never left alone at the foot of a page.
      layout.ensure(SIZE.heading * LEADING + SIZE.body * LEADING * 3)
      layout.gap(6)
      layout.text(block.text, { font: layout.bold, size: SIZE.heading })
      layout.gap(6)
      return
    case 'subheading':
      layout.ensure(SIZE.subheading * LEADING + SIZE.body * LEADING * 2)
      layout.gap(4)
      layout.text(block.text, { font: layout.bold, size: SIZE.subheading })
      layout.gap(4)
      return
    case 'paragraph':
      layout.text(block.text, { color: block.tone === 'muted' ? MUTED : INK })
      layout.gap(6)
      return
    case 'facts':
      for (const { label, value } of block.items) drawFact(layout, label, value)
      layout.gap(8)
      return
    case 'item': {
      const lines = block.lines ?? []
      layout.ensure(SIZE.body * LEADING * (2 + lines.length))
      layout.text(block.title, { font: layout.bold })
      for (const line of lines) layout.text(line)
      if (block.note) {
        layout.gap(2)
        layout.text(block.note, { color: MUTED, x: MARGIN_X + 12, width: TEXT_WIDTH - 12 })
      }
      layout.gap(6)
      layout.rule()
      layout.gap(8)
      return
    }
    case 'table':
      drawTable(layout, block)
      layout.gap(8)
      return
  }
}

/** Renders `input` as a PDF file's bytes. */
export async function renderPdf(input: PdfDocumentInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(toWinAnsi(input.title), { showInWindowTitleBar: true })
  if (input.subtitle) doc.setSubject(toWinAnsi(input.subtitle))
  doc.setCreator('RecoverEase')
  doc.setProducer('RecoverEase')
  doc.setLanguage('en')
  doc.setCreationDate(input.generatedAt)
  doc.setModificationDate(input.generatedAt)

  const layout = new Layout(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  )

  drawLetterhead(layout, input)
  for (const block of input.blocks) drawBlock(layout, block)

  // The footer goes on last, once the number of pages is known.
  const footer = toWinAnsi(input.footer)
  layout.pages.forEach((page, index) => {
    const pageLabel = `Page ${index + 1} of ${layout.pages.length}`
    const size = SIZE.small
    page.drawText(footer, { x: MARGIN_X, y: MARGIN_BOTTOM / 2, size, font: layout.regular, color: MUTED })
    page.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN_X - layout.regular.widthOfTextAtSize(pageLabel, size),
      y: MARGIN_BOTTOM / 2,
      size,
      font: layout.regular,
      color: MUTED,
    })
  })

  return doc.save()
}
