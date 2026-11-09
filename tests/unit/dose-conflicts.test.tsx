import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Dose conflicts (migration 48) in the app: their states and wording, the
 * clock-time helper, the patient's notices and the treating doctor's
 * decision dialog. What the database allows is
 * tests/db/medication-dose-identity.test.ts.
 *
 * The wording tested here is PROVISIONAL until the clinical adviser approves
 * it (docs/medication-clock-change-decisions.md). What is not provisional:
 * nothing tells anyone to take or skip a dose, and nothing suggests a time.
 */

const resolveConflict = vi.hoisted(() => vi.fn())

vi.mock('@/features/medications/conflicts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/conflicts')>()),
  resolveConflict,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({ userId: 'doctor-user', role: 'doctor', profile: { kind: 'doctor' } }),
}))

const {
  CONFLICT_STATE_LABEL,
  conflictState,
  momentsFor,
  offsetAt,
  patientConflictText,
  summariseConflicts,
} = await import('@/features/medications/conflicts')
const { ConflictSummaryLines, PatientConflictNotices, ResolveConflictDialog } = await import(
  '@/features/medications/components/dose-conflicts'
)

type Conflict = import('@/features/medications/conflicts').MedicationConflict

const NOW = Date.parse('2030-03-01T00:00:00Z')

function conflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    medication_dose_conflict_id: 'conflict-1',
    medication_schedule_id: 'schedule-1',
    conflict_dose_date: '2030-03-10',
    conflict_dose_time: '02:30:00',
    conflict_reason: 'nonexistent_local_time',
    conflict_at: '2030-03-10T07:30:00Z',
    conflicting_log_id: null,
    conflict_detected_at: '2030-02-08T01:00:00Z',
    conflict_resolution: null,
    resolved_log_id: null,
    resolved_by_doc_id: null,
    conflict_resolved_at: null,
    conflict_resolution_note: null,
    conflict_doctor_alerted_at: null,
    conflict_doctor_final_alert_at: null,
    medication_schedule: {
      medication_schedule_id: 'schedule-1',
      medication_schedule_name: 'Medicine X',
      medication_schedule_dosage: '1 tablet',
    },
    ...overrides,
  }
}

const ALL_STATES: Conflict[] = [
  conflict({ medication_dose_conflict_id: 'a' }),
  conflict({ medication_dose_conflict_id: 'b', conflict_at: '2030-02-01T00:00:00Z' }),
  conflict({ medication_dose_conflict_id: 'c', conflict_resolution: 'rescheduled', resolved_log_id: 'dose-1' }),
  conflict({ medication_dose_conflict_id: 'd', conflict_resolution: 'not_given_separately' }),
  conflict({ medication_dose_conflict_id: 'e', conflict_resolution: 'course_ended' }),
  // Rescheduled, then the course was ended before that dose, which removed it.
  conflict({ medication_dose_conflict_id: 'f', conflict_resolution: 'rescheduled', resolved_log_id: null }),
]

describe('a conflict’s state', () => {
  it('is awaiting review until its moment, then not scheduled, or what was decided', () => {
    expect(ALL_STATES.map((c) => conflictState(c, NOW))).toEqual([
      'awaiting_review',
      'not_scheduled_unresolved',
      'rescheduled',
      'not_given_separately',
      'course_ended',
      'rescheduled_course_ended',
    ])
    expect(summariseConflicts(ALL_STATES, NOW)).toEqual({
      awaiting_review: 1,
      not_scheduled_unresolved: 1,
      rescheduled: 1,
      rescheduled_course_ended: 1,
      not_given_separately: 1,
      course_ended: 1,
      total: 6,
    })
  })

  it('never tells the patient a removed dose is listed with their doses', () => {
    const removed = patientConflictText(ALL_STATES[5]!, NOW)
    expect(removed).toContain('the course ended before that time')
    expect(removed).not.toContain('listed with your doses')
    expect(patientConflictText(ALL_STATES[2]!, NOW)).toContain('It is listed with your doses.')
    expect(CONFLICT_STATE_LABEL[conflictState(ALL_STATES[5]!, NOW)]).toBe('Rescheduled, then the course ended before it')
  })

  it('is described to the patient without any instruction to take or skip a dose', () => {
    for (const c of ALL_STATES) {
      const text = patientConflictText(c, NOW)
      expect(text).toContain('Medicine X (1 tablet)')
      expect(text).not.toMatch(/\b(take|skip|double|extra)\b/i)
    }
    expect(patientConflictText(ALL_STATES[0]!, NOW)).toContain("awaiting your doctor's review")
  })
})

describe('the moments a clock time names', () => {
  it('finds none for a time the clocks jump over', () => {
    expect(momentsFor('2030-03-10', '02:30', 'America/New_York')).toEqual([])
    expect(momentsFor('2030-10-06', '02:15', 'Australia/Lord_Howe')).toEqual([])
  })

  it('finds both for a time the clocks pass twice, earliest first', () => {
    expect(momentsFor('2030-11-03', '01:30', 'America/New_York')).toEqual([
      Date.parse('2030-11-03T05:30:00Z'),
      Date.parse('2030-11-03T06:30:00Z'),
    ])
    expect(offsetAt(Date.parse('2030-11-03T05:30:00Z'), 'America/New_York')).toBe('GMT-04:00')
    expect(offsetAt(Date.parse('2030-11-03T06:30:00Z'), 'America/New_York')).toBe('GMT-05:00')
  })

  it('finds exactly one on an ordinary day', () => {
    expect(momentsFor('2030-03-10', '03:30', 'America/New_York')).toEqual([Date.parse('2030-03-10T07:30:00Z')])
    expect(momentsFor('2030-03-10', '02:30', 'Asia/Manila')).toEqual([Date.parse('2030-03-09T18:30:00Z')])
  })
})

describe('what the patient sees', () => {
  it('is one neutral notice per conflict, with no action to take', () => {
    render(<PatientConflictNotices conflicts={ALL_STATES} now={NOW} />)
    const list = screen.getByRole('list', { name: 'Dose times reviewed because of a clock change' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(ALL_STATES.length)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(list).toHaveTextContent(CONFLICT_STATE_LABEL.awaiting_review)
  })

  it('keeps conflicts out of the adherence figure, as separate lines', () => {
    render(<ConflictSummaryLines summary={summariseConflicts(ALL_STATES, NOW)} />)
    const lines = screen.getByRole('list', { name: 'Clock-change dose reviews' })
    expect(lines).toHaveTextContent('Awaiting doctor review1')
    expect(lines).toHaveTextContent('Not scheduled: unresolved clock-change review1')
    expect(lines).toHaveTextContent('Doctor decided: not given separately1')
    expect(lines).toHaveTextContent('Rescheduled, then the course ended before it1')
    expect(lines).toHaveTextContent('Not counted in the adherence figure above.')
  })

  it('shows nothing at all when there are no conflicts', () => {
    const { container } = render(<ConflictSummaryLines summary={summariseConflicts([], NOW)} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the treating doctor’s decision', () => {
  beforeAll(() => {
    // jsdom has no modal dialogs; the app's Dialog only needs open to follow.
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function () {
      this.open = false
    }
  })

  beforeEach(() => {
    resolveConflict.mockReset()
    resolveConflict.mockResolvedValue(undefined)
  })

  function renderDialog(c: Conflict, onClose = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
    render(wrap(<ResolveConflictDialog patientId="patient-1" conflict={c} zone="America/New_York" onClose={onClose} />))
    return { onClose, dialog: screen.getByRole('dialog', { name: 'Review a dose time' }) }
  }

  it('starts with nothing chosen and no time suggested, and requires a choice and a reason', async () => {
    const user = userEvent.setup()
    const { dialog } = renderDialog(conflict())
    for (const radio of within(dialog).getAllByRole('radio')) expect(radio).not.toBeChecked()
    expect(within(dialog).queryByLabelText(/Time on/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a time for this dose or no separate dose.')

    await user.click(within(dialog).getByRole('radio', { name: /No separate dose/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the reason for this decision.')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('records no separate dose with the reason, and no time', async () => {
    const user = userEvent.setup()
    const { dialog, onClose } = renderDialog(conflict())
    await user.click(within(dialog).getByRole('radio', { name: /No separate dose/ }))
    await user.type(within(dialog).getByLabelText(/Reason for this decision/), 'One dose that night')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith({
        conflictId: 'conflict-1',
        resolution: 'not_given_separately',
        scheduledAt: null,
        note: 'One dose that night',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('refuses a time that does not exist that day, before sending anything', async () => {
    const user = userEvent.setup()
    const { dialog } = renderDialog(conflict())
    await user.click(within(dialog).getByRole('radio', { name: /Set a time for this dose/ }))
    const time = within(dialog).getByLabelText(/Time on/)
    expect(time).toHaveValue('')
    await user.type(time, '02:45')
    await user.type(within(dialog).getByLabelText(/Reason for this decision/), 'Reason')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('02:45 does not exist on')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('asks which of a repeated time is meant, and sends that moment', async () => {
    const user = userEvent.setup()
    const { dialog } = renderDialog(
      conflict({
        conflict_dose_date: '2030-11-03',
        conflict_dose_time: '01:30:00',
        conflict_reason: 'ambiguous_local_time',
        conflict_at: '2030-11-03T06:30:00Z',
      }),
    )
    await user.click(within(dialog).getByRole('radio', { name: /Set a time for this dose/ }))
    await user.type(within(dialog).getByLabelText(/Time on/), '01:30')
    await user.type(within(dialog).getByLabelText(/Reason for this decision/), 'After the change')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('happens twice')

    const before = within(dialog).getByRole('radio', { name: /Before the clocks go back \(GMT-04:00\)/ })
    const after = within(dialog).getByRole('radio', { name: /After the clocks go back \(GMT-05:00\)/ })
    expect(before).not.toBeChecked()
    expect(after).not.toBeChecked()
    await user.click(after)
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith({
        conflictId: 'conflict-1',
        resolution: 'rescheduled',
        scheduledAt: '2030-11-03T06:30:00.000Z',
        note: 'After the change',
      }),
    )
  })

  it('shows the database’s refusal and keeps the dialog open', async () => {
    resolveConflict.mockRejectedValue(new Error('Another dose of this medicine is already due at that moment'))
    const user = userEvent.setup()
    const { dialog, onClose } = renderDialog(conflict())
    await user.click(within(dialog).getByRole('radio', { name: /Set a time for this dose/ }))
    await user.type(within(dialog).getByLabelText(/Time on/), '03:30')
    await user.type(within(dialog).getByLabelText(/Reason for this decision/), 'Reason')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(await within(dialog).findByText('Another dose of this medicine is already due at that moment')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
