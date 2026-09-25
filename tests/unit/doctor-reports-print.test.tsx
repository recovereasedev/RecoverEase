import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The doctor's list of generated reports, printed (module 9.2, served by the
 * browser's print). The page header, "Generate a recovery report" and "Print
 * list" belong to the screen: they stay there, and work there, but stay off
 * the paper. The list itself - its heading and every report on it - prints as
 * it always has.
 */

const fixture = vi.hoisted(() => ({
  reports: vi.fn(),
  record: vi.fn(),
  user: {} as Record<string, unknown>,
}))

// The signed-in clinician, as the app shell has them.
const DOCTOR_USER = {
  userId: 'u-doctor',
  profile: {
    kind: 'doctor',
    doctor: { doc_id: 'd-1', doc_first_name: 'Alan', doc_last_name: 'Cruz' },
  },
}

vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => ({
    data: [{ pat_id: 'p-1', pat_first_name: 'Alice', pat_last_name: 'Santos' }],
    isPending: false,
    error: null,
  }),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => fixture.user,
}))

vi.mock('@/features/reports/api', () => ({
  fetchReports: fixture.reports,
  recordGeneratedReport: fixture.record,
}))

// The report preview has its own tests; here it only has to be out of the way.
vi.mock('@/features/reports/components/report-preview', () => ({
  ReportPreview: () => null,
}))

const { DoctorReportsPage } = await import(
  '@/features/reports/pages/doctor-reports-page'
)

const REPORTS = [
  {
    report_id: 'rep-1',
    user_id: 'u-doctor',
    pat_id: 'p-1',
    report_type: 'patient_recovery',
    report_generated_at: '2026-09-12T10:00:00Z',
    report_file_path: null,
    patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
  },
  {
    report_id: 'rep-2',
    user_id: 'u-doctor',
    pat_id: 'p-2',
    report_type: 'patient_recovery',
    report_generated_at: '2026-09-10T08:30:00Z',
    report_file_path: null,
    patient: { pat_first_name: 'Bob', pat_last_name: 'Reyes' },
  },
]

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <DoctorReportsPage />
    </QueryClientProvider>,
  )
}

/** Whether an element sits inside something the print stylesheet drops. */
const leftOffPaper = (element: HTMLElement) =>
  element.closest('[class~="print:hidden"]') !== null

/** Whether an element is for paper only: hidden on screen, shown in print. */
const paperOnly = (element: HTMLElement) =>
  element.closest('[class~="hidden"][class~="print:block"]') !== null

/**
 * Whether a section's own heading gives way on paper: the section hides its
 * first child in print, and that first child holds the heading.
 */
const givesWayOnPaper = (heading: HTMLElement) => {
  const section = heading.closest('section')
  return (
    section !== null &&
    section.classList.contains('print:[&>:first-child]:hidden') &&
    section.firstElementChild?.contains(heading) === true
  )
}

const printListButton = () => screen.getByRole('button', { name: /print list/i })
const generateButton = () => screen.getByRole('button', { name: /generate report/i })

beforeEach(() => {
  fixture.user = DOCTOR_USER
  fixture.reports.mockResolvedValue(REPORTS)
  fixture.record.mockResolvedValue({ ...REPORTS[0], report_id: 'rep-3' })
  vi.spyOn(window, 'print').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fixture.reports.mockReset()
  fixture.record.mockReset()
})

describe('printing the list of generated reports', () => {
  it('offers the Generate form and Print list on screen', async () => {
    renderPage()
    await screen.findByText('Alice Santos')

    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Generate a recovery report' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeEnabled()
    expect(generateButton()).toBeInTheDocument()
    expect(printListButton()).toBeEnabled()
  })

  it('still prints the list, and generates a report, from those controls', async () => {
    renderPage()
    await screen.findByText('Alice Santos')

    fireEvent.click(printListButton())
    expect(window.print).toHaveBeenCalledTimes(1)

    // Opening the picker measures the room below it on the next animation
    // frame. That frame runs inside act, as it would before a person's next
    // click, rather than landing after the test has finished.
    await act(async () => {
      fireEvent.focus(screen.getByRole('combobox'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Alice Santos/ }))
    fireEvent.click(generateButton())

    // Waiting for what the page says once the report is recorded, not only
    // for the call, keeps the mutation's own updates inside the test.
    expect(await screen.findByRole('status')).toHaveTextContent(/report recorded/i)
    expect(fixture.record).toHaveBeenCalledWith({
      userId: 'u-doctor',
      type: 'patient_recovery',
      patientId: 'p-1',
    })

    // Recording a report refreshes the list, and React Query tells the page
    // with setTimeout(0). Let those updates land inside act too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it('keeps the page header, the Generate form and Print list off the paper', async () => {
    renderPage()
    await screen.findByText('Alice Santos')

    for (const [label, element] of [
      ['page title', screen.getByRole('heading', { level: 1, name: 'Reports' })],
      ['page description', screen.getByText('Recovery reports you have generated.')],
      ['form heading', screen.getByRole('heading', { name: 'Generate a recovery report' })],
      ['patient picker', screen.getByRole('combobox')],
      ['Generate report', generateButton()],
      ['Print list', printListButton()],
    ] as const) {
      expect(leftOffPaper(element), label).toBe(true)
    }
  })

  it('keeps the list itself on the paper', async () => {
    renderPage()
    await screen.findByText('Alice Santos')

    // Headed on paper by the report's letterhead, and on screen by the
    // section's own heading, which gives way to it in print.
    const [onScreen, onPaper] = screen.getAllByRole('heading', {
      name: 'Generated reports',
    })
    expect(givesWayOnPaper(onScreen!)).toBe(true)
    expect(paperOnly(onScreen!)).toBe(false)
    expect(paperOnly(onPaper!)).toBe(true)
    expect(leftOffPaper(onPaper!)).toBe(false)

    const list = screen.getByRole('list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows.map(leftOffPaper)).toEqual([false, false])

    const [alice, bob] = rows
    expect(within(alice!).getByText('Alice Santos')).toBeInTheDocument()
    expect(within(bob!).getByText('Bob Reyes')).toBeInTheDocument()
  })

  it('keeps an empty list’s message on the paper', async () => {
    fixture.reports.mockResolvedValue([])
    renderPage()

    expect(leftOffPaper(await screen.findByText('No reports yet'))).toBe(false)
  })

  it('prints no control at all', async () => {
    renderPage()
    await screen.findByText('Alice Santos')

    const onPaper = screen
      .getAllByRole('button')
      .filter((button) => !leftOffPaper(button))
      .map((button) => button.textContent)
    expect(onPaper).toEqual([])
    expect(screen.getAllByRole('combobox').filter((field) => !leftOffPaper(field))).toEqual([])
  })

  describe('under the report’s letterhead', () => {
    beforeEach(() => {
      // Only the clock: React Query's own timers keep running.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 8, 25, 9, 41))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('names the clinician and the time it was printed, on paper only', async () => {
      renderPage()
      await screen.findByText('Alice Santos')

      const clinician = screen.getByText('Dr. Alan Cruz')
      expect(clinician.parentElement).toHaveTextContent('Prepared by Dr. Alan Cruz')
      expect(paperOnly(clinician)).toBe(true)

      const printed = screen.getByText('25 Sep 2026, 09:41')
      expect(printed.parentElement).toHaveTextContent('Printed 25 Sep 2026, 09:41')
      expect(paperOnly(printed)).toBe(true)
    })

    it('names no clinician it does not know', async () => {
      fixture.user = { userId: 'u-doctor', profile: { kind: 'profile-missing', role: 'doctor' } }
      renderPage()
      await screen.findByText('Alice Santos')

      expect(screen.queryByText(/prepared by/i)).not.toBeInTheDocument()
      expect(screen.getByText('25 Sep 2026, 09:41')).toBeInTheDocument()
    })
  })
})
