import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F-03 — finding a patient on the Reports page.
 *
 * The scheduling dialog's picker became searchable in QA 09/06 #1; the
 * Reports page kept a native `<select>`, which is the same long scroll on a
 * phone once a caseload grows. It now reuses the same Combobox.
 *
 * What must not change is the part that is load-bearing: the options still
 * come from `useMyPatients()` — the list RLS has already scoped to this
 * clinician — and what reaches report generation is still a patient id.
 */

const mockPatients = vi.hoisted(() => ({ data: [] as unknown[] }))
const mockRecord = vi.hoisted(() => vi.fn())

vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => mockPatients,
}))

vi.mock('@/features/auth/auth-context', () => ({
  // With the doctor profile the signed-in clinician always has, which the
  // printed list's letterhead names.
  useCurrentUser: () => ({
    userId: 'u-doctor',
    profile: {
      kind: 'doctor',
      doctor: { doc_id: 'd-1', doc_first_name: 'Alan', doc_last_name: 'Cruz' },
    },
  }),
}))

vi.mock('@/features/reports/api', () => ({
  fetchReports: () => Promise.resolve([]),
  recordGeneratedReport: mockRecord,
}))

// The document itself is covered by `patient-report.test.tsx` and
// `doctor-report-preview.test.tsx`. Here it is only a witness that generating
// opens the report for the patient that was chosen.
const mockPreview = vi.hoisted(() => vi.fn((_props: { patientId: string }) => null))
vi.mock('@/features/reports/components/report-preview', () => ({
  ReportPreview: mockPreview,
}))

const { DoctorReportsPage } = await import(
  '@/features/reports/pages/doctor-reports-page'
)

/** This clinician's caseload. Nobody else's patient is in the hook's data. */
const MINE = [
  { pat_id: 'p-1', doc_id: 'd-1', pat_first_name: 'Alice', pat_last_name: 'Santos' },
  { pat_id: 'p-2', doc_id: 'd-1', pat_first_name: 'Bob', pat_last_name: 'Reyes' },
  { pat_id: 'p-3', doc_id: 'd-1', pat_first_name: 'Carla', pat_last_name: 'Dizon' },
]

beforeEach(() => {
  mockRecord.mockReset()
  mockRecord.mockResolvedValue({})
  mockPreview.mockClear()
  mockPatients.data = MINE
})

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <DoctorReportsPage />
    </QueryClientProvider>,
  )
  return { ...view, input: screen.getByRole('combobox') }
}

function open(input: HTMLElement) {
  fireEvent.focus(input)
  return screen.getByRole('listbox')
}

describe('the Reports patient picker', () => {
  it('is a searchable combobox, not a native select', () => {
    const { container, input } = renderPage()

    // A native <select> also carries the implicit combobox role, so check
    // the element itself, and that no select remains on the page.
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(container.querySelector('select')).toBeNull()
  })

  it('is labelled by its Field, so it can be named and reached by label', () => {
    renderPage()
    expect(screen.getByLabelText(/patient/i)).toHaveAttribute('role', 'combobox')
  })

  it('offers exactly the clinician’s own patients, from the existing hook', () => {
    const { input } = renderPage()
    const options = within(open(input)).getAllByRole('option')

    expect(options.map((option) => option.textContent)).toEqual([
      'Alice Santos',
      'Bob Reyes',
      'Carla Dizon',
    ])
  })

  it('narrows the list by first name', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.change(input, { target: { value: 'car' } })

    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Carla Dizon')
  })

  it('narrows the list by surname too', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.change(input, { target: { value: 'reyes' } })

    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Bob Reyes')
  })

  it('says so when nothing matches, rather than showing an empty box', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.change(input, { target: { value: 'zzzz' } })

    expect(screen.getByText('No patient of yours matches that name')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('never reaches a patient outside the caseload by typing their name', () => {
    // The combobox has no data source of its own. A name that is not in
    // `useMyPatients()` cannot be typed into existence.
    const { input } = renderPage()
    open(input)
    fireEvent.change(input, { target: { value: 'kirby' } })

    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('is operable by keyboard alone', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('Bob Reyes')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the chosen patient when Escape abandons a new search', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Alice Santos/ }))
    expect(input).toHaveValue('Alice Santos')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'carla' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue('Alice Santos')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('records nothing until a patient is chosen, and says so when Generate is pressed', () => {
    const { input } = renderPage()
    const generate = screen.getByRole('button', { name: /generate report/i })

    // Pressable, rather than disabled with no reason given (M7).
    expect(generate).toBeEnabled()
    fireEvent.click(generate)

    expect(mockRecord).not.toHaveBeenCalled()
    // Said beside the picker, which is marked and takes focus.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose which patient this report is for.',
    )
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()

    // Choosing someone clears it.
    fireEvent.change(input, { target: { value: 'bob' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bob Reyes/ }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('leaves the list closed when Generate sends focus here, so the message stays readable', () => {
    const { input } = renderPage()
    fireEvent.click(screen.getByRole('button', { name: /generate report/i }))

    // Focus arrives because the field is missing (M7) - not a request to
    // browse the list, which would open over the message.
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose which patient this report is for.',
    )

    // Still opened on purpose: by arrow key, by click, by typing.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.click(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })

    fireEvent.change(input, { target: { value: 'ali' } })
    expect(
      within(screen.getByRole('listbox')).getByRole('option', { name: /Alice Santos/ }),
    ).toBeInTheDocument()
  })

  it('still opens on focus when nothing is wrong', () => {
    const { input } = renderPage()
    fireEvent.focus(input)

    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('hands the chosen patient id to the existing report flow', async () => {
    // The load-bearing assertion: the label is what the doctor sees, the id
    // is what generation records.
    const { input } = renderPage()
    open(input)
    fireEvent.change(input, { target: { value: 'bob' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bob Reyes/ }))

    const generate = screen.getByRole('button', { name: /generate report/i })
    expect(generate).toBeEnabled()
    fireEvent.click(generate)

    await waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1))
    expect(mockRecord).toHaveBeenCalledWith({
      userId: 'u-doctor',
      type: 'patient_recovery',
      patientId: 'p-2',
    })

    // And the report that was just recorded opens, for that same patient.
    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    expect(mockPreview.mock.calls.at(-1)?.[0]).toMatchObject({ patientId: 'p-2' })
  })

  it('opens no report before one has been recorded', () => {
    const { input } = renderPage()
    open(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bob Reyes/ }))

    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('keeps a long caseload fully reachable', () => {
    // Every option is in the tree and the list scrolls itself; the height is
    // a window onto the list, never a truncation of it.
    mockPatients.data = Array.from({ length: 40 }, (_, index) => ({
      pat_id: `p-${index}`,
      doc_id: 'd-1',
      pat_first_name: 'Patient',
      pat_last_name: String(index).padStart(2, '0'),
    }))
    const { input } = renderPage()
    const list = open(input)

    expect(within(list).getAllByRole('option')).toHaveLength(40)
    expect(list.className).toContain('overflow-auto')

    // The deepest option, by mouse.
    fireEvent.mouseDown(within(list).getByText('Patient 39'))
    expect(input).toHaveValue('Patient 39')
  })
})
