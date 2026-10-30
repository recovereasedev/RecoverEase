import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The administrator's system-wide report, printed (modules 9.3 and 9.4,
 * served by the browser's print). "Print or save as PDF" and "Generate report"
 * are controls: they stay on screen, and work there, but stay off the paper.
 * The report itself — the system summary and the list of generated reports —
 * prints under the recovery report's letterhead, which takes the place of the
 * page header on paper.
 */

const api = vi.hoisted(() => ({
  fetchAdminDashboardStats: vi.fn(),
  fetchReports: vi.fn(),
  recordSystemReport: vi.fn(),
}))

// The network calls only: `keptFigures` is the real one.
vi.mock('@/features/reports/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/reports/api')>()),
  ...api,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-admin',
    role: 'admin',
    profile: {
      kind: 'admin',
      admin: { admin_id: 'a-1', admin_first_name: 'Ada', admin_last_name: 'Reyes' },
    },
  }),
}))

import { strFromU8, unzipSync } from 'fflate'

import { captureDownloads } from './support/capture-download'
import { pdfLines } from './support/pdf-text'

const { reportCreator } = await import('@/features/reports/report-creator')

const { AdminReportsPage } = await import('@/features/reports/pages/admin-reports-page')

const STATS = {
  patients: { total: 7, active: 6 },
  doctors: { total: 3, active: 2 },
  accounts: { admin: 1, doctor: 3, patient: 7 },
  appointments: { upcoming: 5 },
  generated_at: '2026-09-13T12:00:00Z',
}

const REPORTS = [
  {
    report_id: 'rep-1',
    user_id: 'u-admin',
    pat_id: null,
    report_type: 'system_wide',
    report_generated_at: '2026-09-12T10:00:00Z',
    patient: null,
  },
]

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <AdminReportsPage />
    </QueryClientProvider>,
  )
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

const printButton = () => screen.getByRole('button', { name: /print or save as pdf/i })
const generateButton = () => screen.getByRole('button', { name: /generate report/i })

/** The list has loaded: its one row is on the page. */
const listLoaded = () => screen.findByRole('listitem')

beforeEach(() => {
  api.fetchAdminDashboardStats.mockResolvedValue(STATS)
  api.fetchReports.mockResolvedValue(REPORTS)
  api.recordSystemReport.mockResolvedValue(REPORTS[0])
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  api.recordSystemReport.mockReset()
})

describe('printing the system-wide report', () => {
  it('offers Print or save as PDF and Generate report on screen', async () => {
    renderPage()
    await screen.findByText('Patients on record')

    expect(printButton()).toBeEnabled()
    expect(generateButton()).toBeEnabled()
  })

  it('still prints and generates from those controls', async () => {
    renderPage()
    await screen.findByText('Patients on record')

    fireEvent.click(printButton())
    expect(window.print).toHaveBeenCalledTimes(1)

    const fetchesBefore = api.fetchReports.mock.calls.length
    fireEvent.click(generateButton())
    // The database computes and keeps the figures (migration 43): nothing
    // from the page is sent with it.
    await waitFor(() => expect(api.recordSystemReport).toHaveBeenCalledTimes(1))
    expect(api.recordSystemReport.mock.calls[0]!.slice(0, 1)).toEqual([undefined])

    // Recording a report refreshes the list, and React Query tells the page
    // with setTimeout(0). Wait for the refresh, then let those updates land
    // inside act rather than after the test has finished.
    await waitFor(() =>
      expect(api.fetchReports.mock.calls.length).toBeGreaterThan(fetchesBefore),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it('keeps both controls off the paper', async () => {
    renderPage()
    await screen.findByText('Patients on record')

    expect(leftOffPaper(printButton())).toBe(true)
    expect(leftOffPaper(generateButton())).toBe(true)
  })

  it('keeps the report itself on the paper', async () => {
    renderPage()
    await screen.findByText('Patients on record')
    await listLoaded()

    for (const text of [
      'System summary',
      'Patients on record',
      '7',
      '6 active',
      'Doctor accounts',
      'Upcoming appointments',
      '5',
      'Accounts by role',
      '1 admin',
      'Recently generated reports',
    ]) {
      expect(leftOffPaper(screen.getByText(text)), text).toBe(false)
    }
    // The generated report's own row.
    expect(
      leftOffPaper(within(screen.getByRole('listitem')).getByText('System-wide report')),
    ).toBe(false)
  })

  it('prints the letterhead in place of the page header', async () => {
    renderPage()
    await screen.findByText('Patients on record')
    await listLoaded()

    const letterhead = screen.getByRole('heading', { level: 2, name: 'System-wide report' })
    expect(leftOffPaper(letterhead)).toBe(false)
    // Paper only: on screen the page header says what the page is.
    expect(letterhead.closest('[class~="hidden"][class~="print:block"]')).not.toBeNull()
    expect(leftOffPaper(screen.getByText('Printed'))).toBe(false)
    expect(leftOffPaper(screen.getByText('Ada Reyes'))).toBe(false)

    // The page header, with its title, stays on screen and off the paper.
    expect(
      leftOffPaper(screen.getByRole('heading', { level: 1, name: 'Reports' })),
    ).toBe(true)
  })

  it('prints on the report page', async () => {
    renderPage()
    await screen.findByText('Patients on record')

    // `report-sheet` puts the printout on the A4 `report` page, with its
    // margins, running footer and page numbers.
    const sheet = screen.getByText('System summary').closest('.report-sheet')
    expect(sheet).not.toBeNull()
    expect(sheet).toContainElement(screen.getByRole('heading', { level: 2, name: 'System-wide report' }))
  })

  it('prints no control at all', async () => {
    renderPage()
    await screen.findByText('Patients on record')
    await listLoaded()

    const onPaper = screen
      .getAllByRole('button')
      .filter((button) => !leftOffPaper(button))
      .map((button) => button.textContent)
    expect(onPaper).toEqual([])
  })
})

describe('exporting the system-wide report (module 9.4)', () => {
  it('saves the figures shown as a PDF, and records no generated report', async () => {
    const capture = captureDownloads()
    try {
      renderPage()
      const button = await screen.findByRole('button', { name: 'Download PDF' })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const [file] = capture.files
      expect(file!.type).toBe('application/pdf')
      expect(file!.name).toMatch(/^recoverease-system-wide-report-\d{4}-\d{2}-\d{2}\.pdf$/)
      expect(await pdfLines(await file!.bytes())).toEqual(
        expect.arrayContaining([
          'System-wide report',
          'Ada Reyes',
          'Patients on record', '7', '6',
          'Doctor accounts', '3', '2',
          'Upcoming appointments', '5',
          'Clinic Admins',
        ]),
      )
      expect(api.recordSystemReport).not.toHaveBeenCalled()
      expect(window.print).not.toHaveBeenCalled()
    } finally {
      capture.release()
    }
  })

  it('saves the same figures as an Excel workbook', async () => {
    const capture = captureDownloads()
    try {
      renderPage()
      const button = await screen.findByRole('button', { name: 'Download Excel' })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const [file] = capture.files
      expect(file!.type).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      expect(file!.name).toMatch(/^recoverease-system-wide-report-\d{4}-\d{2}-\d{2}\.xlsx$/)
      const parts = unzipSync(await file!.bytes())
      const summary = strFromU8(parts['xl/worksheets/sheet1.xml']!)
      expect(summary).toContain('Patients on record')
      expect(summary).toMatch(/<v>7<\/v><\/c><c r="C\d+"><v>6<\/v>/)
      expect(strFromU8(parts['xl/worksheets/sheet3.xml']!)).toContain('System-wide report')
      expect(api.recordSystemReport).not.toHaveBeenCalled()
    } finally {
      capture.release()
    }
  })

  it('keeps both export controls off the paper', async () => {
    renderPage()
    for (const name of ['Download PDF', 'Download Excel']) {
      expect(leftOffPaper(await screen.findByRole('button', { name }))).toBe(true)
    }
  })
})

describe('who generated each report (module 9.5)', () => {
  // As RLS returns them to a Clinic Admin: their own, another Clinic Admin's
  // in the same clinic with that account's address, and one whose account
  // the reader may not see.
  const CLINIC_REPORTS = [
    { ...REPORTS[0]!, user_account: { user_email: 'ada.reyes@harborview.test' } },
    {
      report_id: 'rep-2',
      user_id: 'u-noel',
      pat_id: null,
      report_type: 'system_wide',
      report_generated_at: '2026-09-11T15:20:00Z',
      patient: null,
      user_account: { user_email: 'noel.bautista@harborview.test' },
    },
    {
      report_id: 'rep-3',
      user_id: 'u-unseen',
      pat_id: null,
      report_type: 'system_wide',
      report_generated_at: '2026-09-10T08:05:00Z',
      patient: null,
      user_account: null,
    },
  ]

  const rows = async () => {
    api.fetchReports.mockResolvedValue(CLINIC_REPORTS)
    renderPage()
    return screen.findAllByRole('listitem')
  }

  it('names the reader’s own reports, another administrator’s by address, and guesses no one', async () => {
    const [own, other, unseen] = await rows()

    expect(own).toHaveTextContent('Generated by Ada Reyes (you)')
    expect(other).toHaveTextContent('Generated by noel.bautista@harborview.test')
    expect(unseen).toHaveTextContent('Generated by Not available')
    // On paper too: it is part of the record.
    expect(leftOffPaper(within(own!).getByText(/^Generated by Ada Reyes \(you\)/))).toBe(false)
  })

  it('says a report generated before its figures were kept has none, and offers nothing for it', async () => {
    const items = await rows()

    expect(
      screen.getByText(
        'Each report generated: who generated it, and when. A report keeps the figures it was generated with, so it can be downloaded again exactly as it was. Reports generated before this was added did not keep theirs.',
      ),
    ).toBeInTheDocument()
    for (const item of items) {
      expect(item).toHaveTextContent('Its figures were not kept')
      expect(within(item).queryAllByRole('button')).toEqual([])
      expect(within(item).queryAllByRole('link')).toEqual([])
    }
  })

  it('downloads a kept report again with the figures it was generated with, not today’s', async () => {
    const KEPT = {
      patients: { total: 4, active: 3 },
      doctors: { total: 2, active: 2 },
      accounts: { admin: 1, doctor: 2, patient: 4 },
      appointments: { upcoming: 9 },
      generated_at: '2026-09-01T09:30:00Z',
    }
    api.fetchReports.mockResolvedValue([
      { ...CLINIC_REPORTS[1], report_id: 'rep-kept', report_snapshot: KEPT },
      ...CLINIC_REPORTS,
    ])
    const capture = captureDownloads()
    try {
      renderPage()
      const [kept] = await screen.findAllByRole('listitem')
      expect(kept).not.toHaveTextContent('Its figures were not kept')
      fireEvent.click(within(kept!).getByRole('button', { name: /as PDF$/ }))

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const file = capture.files[0]!
      expect(file.name).toBe('recoverease-system-wide-report-as-generated-2026-09-11.pdf')
      const text = (await pdfLines(await file.bytes())).join(' ')
      for (const expected of [
        'As generated: the figures recorded at the time',
        'Generated by noel.bautista@harborview.test',
        'the figures are the ones recorded then',
        'Upcoming appointments 9',
      ]) {
        expect(text, expected).toContain(expected)
      }
      // Today's figures are not in it, nor is the list of other reports.
      expect(text).not.toContain('Upcoming appointments 5')
      expect(text).not.toContain('Recently generated reports')

      fireEvent.click(within(kept!).getByRole('button', { name: /as Excel$/ }))
      await waitFor(() => expect(capture.files).toHaveLength(2))
      const workbook = unzipSync(await capture.files[1]!.bytes())
      expect(Object.keys(workbook).filter((name) => name.startsWith('xl/worksheets/'))).toHaveLength(2)
      expect(strFromU8(workbook['xl/worksheets/sheet1.xml']!)).toContain('recorded then')
    } finally {
      capture.release()
    }
  })

  it('names them in the downloaded PDF as on the page', async () => {
    const capture = captureDownloads()
    try {
      await rows()
      const button = screen.getByRole('button', { name: 'Download PDF' })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)

      await waitFor(() => expect(capture.files).toHaveLength(1))
      expect(await pdfLines(await capture.files[0]!.bytes())).toEqual(
        expect.arrayContaining([
          'Generated by',
          'Ada Reyes (you)',
          'noel.bautista@harborview.test',
          'Not available',
        ]),
      )
    } finally {
      capture.release()
    }
  })

  it('falls back to the reader’s address, then to "You", for their own', () => {
    const own = { user_id: 'u-admin', user_account: null }
    expect(reportCreator(own, { userId: 'u-admin', name: null, email: 'ada.reyes@harborview.test' })).toBe(
      'ada.reyes@harborview.test (you)',
    )
    expect(reportCreator(own, { userId: 'u-admin', name: null, email: null })).toBe('You')
  })
})
