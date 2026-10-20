import type { DashboardStats, ReportWithPatient } from '@/features/reports/api'
import { reportDateTime } from '@/features/reports/report-format'
import {
  documentFileName,
  PDF_TYPE,
  XLSX_TYPE,
  type DownloadableFile,
} from '@/lib/documents/download'
import { renderPdf, type PdfBlock } from '@/lib/documents/pdf'
import { buildXlsx, type XlsxSheet } from '@/lib/documents/xlsx'

/**
 * Module 9.4, "Download/Export System-wide Report": the figures the Reports
 * page shows, as a PDF file or an Excel workbook.
 *
 * Both are made from exactly what the page has loaded - `admin_dashboard_stats`,
 * which counts only the Clinic Admin's own clinic (migration 30), and their
 * clinic's recently generated reports - and add nothing to them. Exporting
 * records nothing: "Generate report" is what adds to Recently generated
 * (module 9.5), as it always has.
 */
export type SystemReportInput = {
  stats: DashboardStats
  reports: ReportWithPatient[]
  preparer: string | null
  generatedAt: Date
}

const ROLE_LABELS: Record<string, string> = {
  patient: 'Patients',
  doctor: 'Doctors',
  admin: 'Clinic Admins',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

export function reportTypeLabel(type: string): string {
  return type === 'system_wide' ? 'System-wide report' : 'Patient recovery report'
}

/** The summary's rows, shared by the PDF and the workbook so they agree. */
export function summaryRows(stats: DashboardStats): { measure: string; total: number; active: number | null }[] {
  return [
    { measure: 'Patients on record', total: stats.patients.total, active: stats.patients.active },
    { measure: 'Doctor accounts', total: stats.doctors.total, active: stats.doctors.active },
    { measure: 'Upcoming appointments', total: stats.appointments.upcoming, active: null },
  ]
}

export function accountRows(stats: DashboardStats): { role: string; accounts: number }[] {
  return Object.entries(stats.accounts ?? {}).map(([role, accounts]) => ({
    role: roleLabel(role),
    accounts,
  }))
}

function meta(input: SystemReportInput) {
  return [
    { label: 'Figures as at', value: reportDateTime(input.stats.generated_at) },
    { label: 'Generated', value: reportDateTime(input.generatedAt.toISOString()) },
    ...(input.preparer ? [{ label: 'Prepared by', value: input.preparer }] : []),
  ]
}

export function systemReportBlocks(input: SystemReportInput): PdfBlock[] {
  return [
    { kind: 'heading', text: 'System summary' },
    {
      kind: 'table',
      columns: [
        { label: 'Measure', width: 0.56 },
        { label: 'Total', width: 0.22, align: 'right' },
        { label: 'Active', width: 0.22, align: 'right' },
      ],
      rows: summaryRows(input.stats).map((row) => [
        row.measure,
        String(row.total),
        row.active === null ? '' : String(row.active),
      ]),
    },
    { kind: 'heading', text: 'Accounts by role' },
    {
      kind: 'table',
      columns: [
        { label: 'Role', width: 0.7 },
        { label: 'Accounts', width: 0.3, align: 'right' },
      ],
      rows: accountRows(input.stats).map((row) => [row.role, String(row.accounts)]),
      empty: 'No accounts.',
    },
    { kind: 'heading', text: 'Recently generated reports' },
    {
      kind: 'table',
      columns: [
        { label: 'Report', width: 0.6 },
        { label: 'Generated', width: 0.4 },
      ],
      rows: input.reports.map((report) => [
        reportTypeLabel(report.report_type),
        reportDateTime(report.report_generated_at),
      ]),
      empty: 'No reports generated yet.',
    },
  ]
}

export async function buildSystemReportPdf(input: SystemReportInput): Promise<DownloadableFile> {
  const generated = reportDateTime(input.generatedAt.toISOString())
  const bytes = await renderPdf({
    title: 'System-wide report',
    subtitle: 'Accounts, appointments and generated reports',
    meta: meta(input),
    blocks: systemReportBlocks(input),
    footer: `RecoverEase system-wide report · Generated ${generated}`,
    generatedAt: input.generatedAt,
  })
  return {
    bytes,
    mimeType: PDF_TYPE,
    fileName: documentFileName(['system-wide-report'], input.generatedAt, 'pdf'),
  }
}

export function systemReportSheets(input: SystemReportInput): XlsxSheet[] {
  const head: (string | number | null)[][] = [
    ['System-wide report'],
    ...meta(input).map(({ label, value }) => [label, value]),
    [],
  ]
  const summaryStart = head.length
  const summary: XlsxSheet = {
    name: 'Summary',
    columnWidths: [28, 22, 12],
    rows: [
      ...head,
      ['Measure', 'Total', 'Active'],
      ...summaryRows(input.stats).map((row) => [row.measure, row.total, row.active]),
    ],
    boldRows: [0, summaryStart],
  }
  const accounts: XlsxSheet = {
    name: 'Accounts by role',
    columnWidths: [24, 12],
    rows: [['Role', 'Accounts'], ...accountRows(input.stats).map((row) => [row.role, row.accounts])],
    boldRows: [0],
  }
  const recent: XlsxSheet = {
    name: 'Recently generated',
    columnWidths: [28, 22],
    rows: [
      ['Report', 'Generated'],
      ...input.reports.map((report) => [
        reportTypeLabel(report.report_type),
        reportDateTime(report.report_generated_at),
      ]),
    ],
    boldRows: [0],
  }
  return [summary, accounts, recent]
}

export async function buildSystemReportXlsx(input: SystemReportInput): Promise<DownloadableFile> {
  return {
    bytes: buildXlsx(systemReportSheets(input), {
      title: 'System-wide report',
      creator: input.preparer ?? 'RecoverEase',
      created: input.generatedAt,
    }),
    mimeType: XLSX_TYPE,
    fileName: documentFileName(['system-wide-report'], input.generatedAt, 'xlsx'),
  }
}
