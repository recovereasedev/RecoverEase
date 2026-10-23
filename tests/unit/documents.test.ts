import { strFromU8, unzipSync } from 'fflate'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { prescribedBy, prescriberOf } from '@/features/medications/prescriber'
import { buildPrescriptionPdf } from '@/features/medications/prescription-document'
import type { ScheduleWithPrescription } from '@/features/medications/api'
import type { DashboardStats, ReportWithPatient } from '@/features/reports/api'
import {
  buildSystemReportPdf,
  buildSystemReportXlsx,
} from '@/features/reports/system-report-export'
import type { PlanWithGoals } from '@/features/treatment-plans/api'
import { buildTreatmentPlanPdf } from '@/features/treatment-plans/treatment-plan-document'
import { documentFileName, PDF_TYPE, XLSX_TYPE } from '@/lib/documents/download'
import { renderPdf, toWinAnsi, wrapText } from '@/lib/documents/pdf'
import { buildXlsx, columnName, safeSheetName, xmlText } from '@/lib/documents/xlsx'

import { pdfLines, pdfPages } from './support/pdf-text'

/**
 * Modules 3.5, 4.10 and 9.4: the files RecoverEase builds for download.
 *
 * Each document is checked by what it says - the text drawn on its pages, or
 * the cells of its sheets - and by being a file its readers can open: a PDF
 * pdf-lib can load again, a workbook whose every part is well-formed XML with
 * the content types Excel looks for.
 */

const GENERATED = new Date(2026, 9, 20, 8, 15)

function schedule(overrides: Partial<ScheduleWithPrescription> = {}): ScheduleWithPrescription {
  return {
    medication_schedule_id: 's1',
    prescription_id: 'rx1',
    medication_schedule_name: 'Amoxicillin',
    medication_schedule_dosage: '500 mg',
    medication_schedule_frequency: 3,
    medication_schedule_times: ['08:00:00', '14:00:00', '20:00:00'],
    medication_schedule_start_date: '2026-10-01',
    medication_schedule_end_date: '2026-10-10',
    medication_schedule_created_at: '2026-10-01T00:00:00Z',
    prescription: {
      prescription_id: 'rx1',
      prescription_issued_date: '2026-10-01',
      prescription_notes: 'Take with food.\nFinish the course.',
      doc_id: 'd-alan',
    },
    ...overrides,
  } as ScheduleWithPrescription
}

const ALICE = {
  pat_first_name: 'Alice',
  pat_last_name: 'Santos',
  pat_birth_date: '1991-04-02',
  pat_gender: 'Female',
}

const DR_CRUZ = {
  doc_id: 'd-alan',
  doc_first_name: 'Alan',
  doc_last_name: 'Cruz',
  doc_specialization: 'Orthopaedic rehabilitation',
  doc_license_no: 'LIC-A-001',
  doc_contact_no: '032 000 0000',
}

/** A page's text as one string, so a cell wrapped over two lines still reads whole. */
function pageText(lines: string[]): string {
  return lines.join(' ')
}

describe('text Helvetica can draw', () => {
  it('keeps Filipino and English names and the app’s punctuation', () => {
    expect(toWinAnsi('Niño Peñafiel – “ok” — 5…')).toBe('Niño Peñafiel – “ok” — 5…')
  })

  it('replaces what Windows-1252 cannot carry, rather than failing the download', () => {
    expect(toWinAnsi('₱500 💊 薬')).toBe('?500 ? ?')
    expect(toWinAnsi('a\tb')).toBe('a b')
  })

  it('wraps to the width, keeps the writer’s line breaks, and breaks an over-long word', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const lines = wrapText('one two three four five six\nseven', font, 10, 60)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(60)
    expect(lines.at(-1)).toBe('seven')

    const long = wrapText('X'.repeat(80), font, 10, 60)
    expect(long.join('')).toBe('X'.repeat(80))
    for (const line of long) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(60)
  })
})

describe('a rendered PDF', () => {
  it('is a PDF pdf-lib can open again, titled and dated, with its text in reading order', async () => {
    const bytes = await renderPdf({
      title: 'Prescription',
      subtitle: 'As recorded in RecoverEase',
      meta: [{ label: 'Generated', value: '20 Oct 2026, 08:15' }],
      blocks: [{ kind: 'paragraph', text: 'Hello' }],
      footer: 'Footer text',
      generatedAt: GENERATED,
    })

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    // Loaded as it is: by default pdf-lib stamps itself as producer on load.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getTitle()).toBe('Prescription')
    expect(doc.getProducer()).toBe('RecoverEase')
    expect(doc.getCreationDate()?.getTime()).toBe(GENERATED.getTime())
    const lines = await pdfLines(bytes)
    expect(lines.indexOf('Prescription')).toBeLessThan(lines.indexOf('Hello'))
    expect(lines).toContain('Page 1 of 1')
  })

  it('runs onto further pages, numbering each, when the content is long', async () => {
    const bytes = await renderPdf({
      title: 'Long',
      meta: [],
      blocks: Array.from({ length: 60 }, (_, index) => ({
        kind: 'item' as const,
        title: `Item ${index + 1}`,
        lines: ['A line of detail'],
      })),
      footer: 'Footer',
      generatedAt: GENERATED,
    })

    const pages = await pdfPages(bytes)
    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((lines, index) => {
      expect(lines).toContain(`Page ${index + 1} of ${pages.length}`)
    })
    expect(pages.flat().filter((line) => /^Item \d+$/.test(line))).toHaveLength(60)
  })
})

describe('the prescription (module 4.10)', () => {
  const paracetamol = schedule({
    medication_schedule_id: 's2',
    medication_schedule_name: 'Paracetamol',
    medication_schedule_dosage: '500mg',
    medication_schedule_frequency: 1,
    medication_schedule_times: ['20:00:00'],
    medication_schedule_end_date: null,
  })

  it('lays a prescription out as a sheet, from the records alone', async () => {
    const file = await buildPrescriptionPdf({
      patient: ALICE,
      doctors: [DR_CRUZ],
      clinicName: 'Harbor Clinic',
      schedules: [schedule(), paracetamol],
      generatedAt: GENERATED,
    })

    expect(file.mimeType).toBe(PDF_TYPE)
    expect(file.fileName).toBe('recoverease-prescription-alice-santos-2026-10-20.pdf')
    const pages = await pdfPages(file.bytes)
    expect(pages).toHaveLength(1)
    const text = pageText(pages[0]!)

    for (const expected of [
      // Letterhead: the mark, the wordmark and the reader's clinic.
      'Recover Ease',
      'Harbor Clinic Prescription',
      // The prescription's own doctor, with what their record holds.
      'Prescribing physician',
      'Dr. Alan Cruz',
      'Orthopaedic rehabilitation',
      'Licence no.: LIC-A-001',
      'Date issued 1 Oct 2026',
      'Prescription ID rx1',
      // The patient.
      'Patient information',
      'Alice Santos',
      '2 Apr 1991 (35 years old)',
      'Female',
      // The ℞ and its medicines.
      'Rx',
      'Medication Dosage Instructions Course',
      'Amoxicillin',
      '500 mg',
      '3 times a day at 08:00, 14:00, 20:00',
      '1 Oct 2026 to 10 Oct 2026',
      'Paracetamol',
      '1 time a day at 20:00',
      'From 1 Oct 2026, ongoing',
      // The doctor's instructions, one per line as they wrote them.
      'Notes / additional instructions',
      'Take with food.',
      'Finish the course.',
      // The prescriber's block, with the signature line left blank.
      'Printed name Dr. Alan Cruz',
      'Contact no. 032 000 0000',
      "Prescriber's signature",
      'RecoverEase prescription · Generated 20 Oct 2026, 08:15 · Page 1 of 1',
    ]) {
      expect(text, expected).toContain(expected)
    }
    // Nothing the records do not hold.
    expect(text).not.toMatch(/Quantity|tablets|capsules/)
  })

  it('names each prescription’s own prescriber, and nobody the reader may not read', async () => {
    const earlier = schedule({
      medication_schedule_id: 's-old',
      medication_schedule_name: 'Ibuprofen',
      prescription_id: 'rx-old',
      prescription: {
        prescription_id: 'rx-old',
        prescription_issued_date: '2026-09-01',
        prescription_notes: null,
        doc_id: 'd-previous',
      },
    })
    const file = await buildPrescriptionPdf({
      patient: ALICE,
      doctors: [DR_CRUZ],
      clinicName: null,
      schedules: [earlier, schedule()],
      generatedAt: GENERATED,
    })

    // One sheet per prescription, the newest first.
    const [current, previous] = (await pdfPages(file.bytes)).map(pageText)
    expect(current).toContain('Date issued 1 Oct 2026')
    expect(current).toContain('Dr. Alan Cruz')
    expect(previous).toContain('Date issued 1 Sep 2026')
    expect(previous).toContain('Ibuprofen')
    expect(previous).toContain("The prescriber's details are not available to this account.")
    expect(previous).toContain('Printed name Not available')
    expect(previous).not.toContain('Dr.')
    expect(previous).toContain('None recorded.')
  })

  it('says what is not recorded rather than inventing it, and leaves off a clinic it could not read', async () => {
    const file = await buildPrescriptionPdf({
      patient: { ...ALICE, pat_birth_date: null, pat_gender: null },
      doctors: [{ ...DR_CRUZ, doc_specialization: null, doc_contact_no: null }],
      clinicName: null,
      schedules: [schedule()],
      generatedAt: GENERATED,
    })
    const text = pageText((await pdfLines(file.bytes)))

    expect(text).toContain('Date of birth / Age Not recorded')
    expect(text).toContain('Gender Not recorded')
    expect(text).toContain('Specialisation Not recorded')
    expect(text).toContain('Contact no. Not recorded')
    expect(text).not.toContain('Harbor')
  })

  it('carries a long prescription onto a continuation sheet without splitting a row', async () => {
    const many = Array.from({ length: 24 }, (_, index) =>
      schedule({
        medication_schedule_id: `s-${index}`,
        medication_schedule_name: `Medicine ${index + 1}`,
      }),
    )
    const file = await buildPrescriptionPdf({
      patient: ALICE,
      doctors: [DR_CRUZ],
      clinicName: null,
      schedules: many,
      generatedAt: GENERATED,
    })

    const pages = await pdfPages(file.bytes)
    expect(pages.length).toBeGreaterThan(1)
    expect(pageText(pages[1]!)).toContain('Prescription, continued')
    // The table's header is repeated above the rows that carry on.
    expect(pageText(pages[1]!)).toContain('Medication Dosage Instructions Course')
    const names = pages.flat().filter((line) => /^Medicine \d+$/.test(line))
    expect(names).toHaveLength(24)
    expect(new Set(names).size).toBe(24)
    pages.forEach((lines, index) => {
      expect(pageText(lines)).toContain(`Page ${index + 1} of ${pages.length}`)
    })
  })

  it('names nobody, and says so, when nothing is prescribed', async () => {
    const file = await buildPrescriptionPdf({
      patient: ALICE,
      doctors: [],
      clinicName: null,
      schedules: [],
      generatedAt: GENERATED,
    })
    const lines = await pdfLines(file.bytes)
    expect(lines).toContain('No prescriptions on record.')
    expect(lines.some((line) => line.startsWith('Dr.'))).toBe(false)
  })
})

describe('a prescription’s prescriber', () => {
  it('is the doctor who issued it, named only when the reader may read them', () => {
    expect(prescribedBy(schedule(), DR_CRUZ)).toBe('Prescribed by Dr. Alan Cruz')
    // Taken over by another doctor since: not the current one's name.
    expect(prescribedBy(schedule(), { ...DR_CRUZ, doc_id: 'd-new' })).toBe(
      'Prescriber not available',
    )
    expect(prescribedBy(schedule(), null)).toBe('Prescriber not available')
    expect(prescriberOf(null, [DR_CRUZ])).toBeNull()
  })
})

describe('the treatment plan (module 3.5)', () => {
  const plan = {
    treatment_plan_id: 'tp1',
    pat_id: 'p1',
    doc_id: 'd1',
    treatment_plan_title: 'Knee rehabilitation',
    treatment_plan_description: 'Six weeks of guided exercise.',
    treatment_plan_status: 'active',
    treatment_plan_start_date: '2026-10-01',
    treatment_plan_end_date: null,
    treatment_plan_created_at: '2026-10-01T00:00:00Z',
    treatment_goal: [
      { treatment_goal_id: 'g3', treatment_goal_description: 'Walk without a stick', treatment_goal_target_date: null, treatment_goal_status: 'pending' },
      { treatment_goal_id: 'g2', treatment_goal_description: 'Climb stairs', treatment_goal_target_date: '2026-11-15', treatment_goal_status: 'in_progress' },
      { treatment_goal_id: 'g1', treatment_goal_description: 'Bend the knee to 90°', treatment_goal_target_date: '2026-10-20', treatment_goal_status: 'achieved' },
    ],
  } as unknown as PlanWithGoals

  it('lists the plan with its status in words, and its goals in the order they are due', async () => {
    const file = await buildTreatmentPlanPdf({
      patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
      plans: [plan],
      generatedAt: GENERATED,
    })

    expect(file.fileName).toBe('recoverease-treatment-plan-alice-santos-2026-10-20.pdf')
    const lines = await pdfLines(file.bytes)
    expect(lines).toEqual(
      expect.arrayContaining([
        'Knee rehabilitation',
        'Active',
        '1 Oct 2026 onwards',
        '1 of 3',
        'Six weeks of guided exercise.',
        'By 20 Oct 2026 · Achieved',
        'By 15 Nov 2026 · In progress',
        'No target date · Not started',
      ]),
    )
    const order = ['Bend the knee to 90°', 'Climb stairs', 'Walk without a stick'].map((goal) =>
      lines.indexOf(goal),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says so when there is no plan yet', async () => {
    const file = await buildTreatmentPlanPdf({
      patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
      plans: [],
      generatedAt: GENERATED,
    })
    expect(await pdfLines(file.bytes)).toContain('No treatment plan yet.')
  })
})

describe('the system-wide report (module 9.4)', () => {
  const stats: DashboardStats = {
    patients: { total: 12, active: 9 },
    doctors: { total: 3, active: 2 },
    accounts: { patient: 12, doctor: 3, admin: 1 },
    appointments: { upcoming: 7 },
    generated_at: '2026-10-20T00:10:00Z',
  }
  const reports = [
    { report_id: 'r1', report_type: 'system_wide', report_generated_at: '2026-10-19T06:00:00Z' },
    { report_id: 'r2', report_type: 'patient_recovery', report_generated_at: '2026-10-18T06:00:00Z' },
  ] as unknown as ReportWithPatient[]
  const input = { stats, reports, preparer: 'Ada Reyes', generatedAt: GENERATED }

  it('as a PDF, gives the figures as loaded and who prepared it, adding nothing', async () => {
    const file = await buildSystemReportPdf(input)
    expect(file.fileName).toBe('recoverease-system-wide-report-2026-10-20.pdf')
    const lines = await pdfLines(file.bytes)
    expect(lines).toEqual(
      expect.arrayContaining([
        'System-wide report',
        'Ada Reyes',
        'Patients on record', '12', '9',
        'Doctor accounts', '3', '2',
        'Upcoming appointments', '7',
        'Patients', 'Doctors', 'Clinic Admins',
        'Patient recovery report',
      ]),
    )
  })

  it('as a workbook, puts the same figures in number cells, one sheet per part', async () => {
    const file = await buildSystemReportXlsx(input)
    expect(file.mimeType).toBe(XLSX_TYPE)
    expect(file.fileName).toBe('recoverease-system-wide-report-2026-10-20.xlsx')

    const parts = unzipSync(file.bytes)
    const workbook = strFromU8(parts['xl/workbook.xml']!)
    expect(workbook).toContain('name="Summary"')
    expect(workbook).toContain('name="Accounts by role"')
    expect(workbook).toContain('name="Recently generated"')

    const summary = strFromU8(parts['xl/worksheets/sheet1.xml']!)
    expect(summary).toContain('<t xml:space="preserve">Patients on record</t>')
    // Counts are numbers a spreadsheet can add up, not text.
    expect(summary).toMatch(/<c r="B\d+"><v>12<\/v><\/c><c r="C\d+"><v>9<\/v><\/c>/)
    expect(summary).toContain('<t xml:space="preserve">Ada Reyes</t>')
    const accounts = strFromU8(parts['xl/worksheets/sheet2.xml']!)
    expect(accounts).toContain('Clinic Admins')
    const recent = strFromU8(parts['xl/worksheets/sheet3.xml']!)
    expect(recent).toContain('Patient recovery report')
  })
})

describe('the workbook writer', () => {
  it('names columns as Excel does', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('escapes text for XML and drops characters XML cannot hold', () => {
    expect(xmlText('a & b < c > "d"\u0001')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;')
  })

  it('keeps sheet names within Excel’s rules', () => {
    expect(safeSheetName('A/B:C?*[x]')).toBe('A B C   x')
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31)
    expect(safeSheetName('   ')).toBe('Sheet')
  })

  it('writes every part as well-formed XML, with the content types Excel needs', () => {
    const bytes = buildXlsx(
      [{ name: 'One', rows: [['Name', 'Count'], ['=SUM(A1)', 3], ['+cmd', null]] }],
      { title: 'T & t', creator: 'C', created: GENERATED },
    )
    const parts = unzipSync(bytes)
    expect(Object.keys(parts)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'docProps/app.xml',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
      ]),
    )
    for (const [name, data] of Object.entries(parts)) {
      const doc = new DOMParser().parseFromString(strFromU8(data), 'application/xml')
      expect(doc.getElementsByTagName('parsererror'), name).toHaveLength(0)
    }
    expect(strFromU8(parts['[Content_Types].xml']!)).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    )

    // Text that looks like a formula stays text: no formula element at all.
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']!)
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain('<t xml:space="preserve">=SUM(A1)</t>')
    expect(sheet).toContain('<t xml:space="preserve">+cmd</t>')
  })
})

describe('file names', () => {
  it('are lower-case ASCII with the date, whatever the name', () => {
    expect(documentFileName(['prescription', 'Niño', 'Peñafiel-Cruz'], GENERATED, 'pdf')).toBe(
      'recoverease-prescription-nino-penafiel-cruz-2026-10-20.pdf',
    )
    expect(documentFileName(['x', '../../etc', 'a/b'], GENERATED, 'pdf')).toBe(
      'recoverease-x-etc-a-b-2026-10-20.pdf',
    )
  })
})
