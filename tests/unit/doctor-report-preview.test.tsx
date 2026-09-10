import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The report preview on the doctor's Reports page.
 *
 * Generating a report still records it exactly as before; what is new is
 * that the document then opens below the form. These pin how it is reached
 * and what goes to paper: only the report while it is open, the list when
 * the list is asked for, and never a control or a stale patient.
 */

const fixture = vi.hoisted(() => {
  const ok = <T,>(data: T) => ({
    data,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve(),
  })

  const patient = (id: string, first: string, last: string) => ({
    pat_id: id,
    user_id: `u-${id}`,
    doc_id: 'd-1',
    pat_first_name: first,
    pat_last_name: last,
    pat_birth_date: '1991-04-02',
    pat_gender: null,
    pat_contact_no: null,
    pat_address: null,
    pat_consent_at: null,
    pat_created_at: '2026-01-01T00:00:00Z',
    pat_status: 'active',
    pat_reminder_preferred_time: null,
    pat_reminder_is_enabled: false,
  })

  return {
    ok,
    patients: [patient('p-1', 'Alice', 'Santos'), patient('p-2', 'Bob', 'Reyes')],
    doctor: {
      doc_id: 'd-1',
      user_id: 'u-doctor',
      doc_first_name: 'Alan',
      doc_last_name: 'Cruz',
      doc_specialization: null,
      doc_license_no: 'LIC-A-001',
      doc_contact_no: null,
      doc_is_active: true,
      doc_created_at: '2026-01-01T00:00:00Z',
    },
    record: vi.fn(),
    notes: vi.fn(),
  }
})

vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => fixture.ok(fixture.patients),
  usePatient: (id: string) =>
    fixture.ok(fixture.patients.find((candidate) => candidate.pat_id === id)),
}))
vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-doctor',
    profile: { kind: 'doctor', doctor: fixture.doctor },
  }),
}))
vi.mock('@/features/reports/api', () => ({
  fetchReports: () => Promise.resolve([]),
  recordGeneratedReport: fixture.record,
}))
vi.mock('@/features/recovery-logs/hooks', () => ({
  useRecoveryLogs: () =>
    fixture.ok([
      {
        recovery_log_id: 'l-1',
        pat_id: 'p-1',
        recovery_log_date: '2026-09-10',
        recovery_log_notes: 'Walked to the end of the road.',
        recovery_log_mood_rating: 4,
        recovery_log_created_at: '2026-09-10T09:00:00Z',
      },
    ]),
}))
vi.mock('@/features/treatment-plans/hooks', () => ({
  useTreatmentPlans: () => fixture.ok([]),
}))
vi.mock('@/features/medications/hooks', () => ({
  useMedicationSchedules: () => fixture.ok([]),
  useDoses: () => fixture.ok([]),
}))
vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => fixture.ok([]),
}))
vi.mock('@/features/doctor-notes/api', () => ({
  fetchDoctorNotes: fixture.notes,
}))

const { DoctorReportsPage } = await import(
  '@/features/reports/pages/doctor-reports-page'
)

const print = vi.fn()

beforeEach(() => {
  fixture.record.mockReset()
  fixture.record.mockImplementation((input: { patientId: string }) =>
    Promise.resolve({
      report_id: 'r-1',
      pat_id: input.patientId,
      user_id: 'u-doctor',
      report_type: 'patient_recovery',
      report_generated_at: '2026-09-11T01:00:00Z',
      report_file_path: null,
    }),
  )
  fixture.notes.mockReset()
  fixture.notes.mockResolvedValue([
    {
      doctor_note_id: 'n-1',
      pat_id: 'p-1',
      doc_id: 'd-1',
      doctor_note_text: 'Wound healing well.',
      doctor_note_created_at: '2026-09-09T03:00:00Z',
    },
  ])
  print.mockReset()
  window.print = print
})

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DoctorReportsPage />
    </QueryClientProvider>,
  )
}

function choose(name: RegExp) {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  fireEvent.mouseDown(screen.getByRole('option', { name }))
}

async function generateFor(name: RegExp) {
  choose(name)
  fireEvent.click(screen.getByRole('button', { name: /generate report/i }))
  return screen.findByRole('region', { name: 'Report preview' })
}

/** What would reach the paper: the page's own content, and the report. */
function printState() {
  const heading = screen.getByRole('heading', { level: 1, name: 'Reports' })
  const preview = document.querySelector('[data-report-preview]')
  return {
    pageHidden: heading.closest('.print\\:hidden') !== null,
    reportHidden: preview?.classList.contains('print:hidden') ?? null,
  }
}

describe('the report preview', () => {
  it('opens on the report just recorded, as the clinical copy', async () => {
    renderPage()
    const preview = await generateFor(/Alice Santos/)

    const sheet = await within(preview).findByRole('article', { name: 'Clinical copy' })
    expect(within(sheet).getByText('Alice Santos')).toBeInTheDocument()
    expect(within(sheet).getByText('Walked to the end of the road.')).toBeInTheDocument()
    expect(within(sheet).getByText('Wound healing well.')).toBeInTheDocument()
    expect(
      within(preview).getByRole('button', { name: 'Clinical copy' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches to the patient copy, which leaves the notes out', async () => {
    renderPage()
    const preview = await generateFor(/Alice Santos/)
    await within(preview).findByRole('article', { name: 'Clinical copy' })

    fireEvent.click(within(preview).getByRole('button', { name: 'Patient copy' }))

    const sheet = within(preview).getByRole('article', { name: 'Patient copy' })
    expect(within(sheet).queryByText('Wound healing well.')).not.toBeInTheDocument()
    expect(within(sheet).getByText('Walked to the end of the road.')).toBeInTheDocument()
  })

  it('keeps every control outside the document that is printed', async () => {
    renderPage()
    const preview = await generateFor(/Alice Santos/)
    const sheet = await within(preview).findByRole('article', { name: 'Clinical copy' })

    expect(within(sheet).queryAllByRole('button')).toHaveLength(0)
    const printButton = within(preview).getByRole('button', { name: /print or save as pdf/i })
    expect(sheet.contains(printButton)).toBe(false)
  })

  it('never puts the patient in the page title', async () => {
    renderPage()
    const preview = await generateFor(/Alice Santos/)
    await within(preview).findByRole('article', { name: 'Clinical copy' })

    expect(document.title).toContain('Reports')
    expect(document.title).not.toContain('Alice')
  })

  it('closes when another patient is chosen', async () => {
    renderPage()
    await generateFor(/Alice Santos/)

    choose(/Bob Reyes/)

    expect(screen.queryByRole('region', { name: 'Report preview' })).not.toBeInTheDocument()
  })

  it('closes on request', async () => {
    renderPage()
    const preview = await generateFor(/Alice Santos/)

    fireEvent.click(within(preview).getByRole('button', { name: /close preview/i }))

    // React Query tells its observers about a reset on the next tick.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Report preview' })).not.toBeInTheDocument(),
    )
  })
})

describe('what goes to paper', () => {
  it('is only the report while it is open', async () => {
    const snapshots: ReturnType<typeof printState>[] = []
    print.mockImplementation(() => snapshots.push(printState()))
    renderPage()
    const preview = await generateFor(/Alice Santos/)
    await within(preview).findByRole('article', { name: 'Clinical copy' })

    fireEvent.click(within(preview).getByRole('button', { name: /print or save as pdf/i }))

    expect(print).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual([{ pageHidden: true, reportHidden: false }])
  })

  it('is the list when the list is asked for, and the report again after', async () => {
    const snapshots: ReturnType<typeof printState>[] = []
    print.mockImplementation(() => snapshots.push(printState()))
    renderPage()
    const preview = await generateFor(/Alice Santos/)
    await within(preview).findByRole('article', { name: 'Clinical copy' })

    fireEvent.click(screen.getByRole('button', { name: /print list/i }))
    expect(snapshots).toEqual([{ pageHidden: false, reportHidden: true }])

    act(() => {
      window.dispatchEvent(new Event('afterprint'))
    })
    expect(printState()).toEqual({ pageHidden: true, reportHidden: false })
  })

  it('is the page as before when no report is open', () => {
    const snapshots: ReturnType<typeof printState>[] = []
    print.mockImplementation(() => snapshots.push(printState()))
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /print list/i }))

    expect(snapshots).toEqual([{ pageHidden: false, reportHidden: null }])
  })
})
