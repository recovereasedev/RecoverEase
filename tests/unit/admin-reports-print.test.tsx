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
  recordGeneratedReport: vi.fn(),
}))

vi.mock('@/features/reports/api', () => api)

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
  api.recordGeneratedReport.mockResolvedValue(REPORTS[0])
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  api.recordGeneratedReport.mockReset()
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
    await waitFor(() =>
      expect(api.recordGeneratedReport).toHaveBeenCalledWith({
        userId: 'u-admin',
        type: 'system_wide',
        patientId: null,
      }),
    )

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
