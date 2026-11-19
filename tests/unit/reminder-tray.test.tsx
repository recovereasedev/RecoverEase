import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appointmentReminders,
  doseReminders,
  type ReminderState,
} from '@/features/reminders/reminder-items'

/**
 * The 2nd-half plan, section 6: the in-app reminder of a dose or an
 * appointment that is nearly due.
 *
 * A dose is shown once the server has sent its reminder before it - so the
 * clinic's lead time, the patient's opt-out and their preferred time all
 * apply unchanged - until it is recorded, dismissed, or the follow-up takes
 * over 30 minutes after it was due. An appointment is shown from ten minutes
 * before it starts. Every case runs on a fixed clock.
 */

const NOW = new Date(2026, 9, 20, 7, 50).getTime()
const MIN = 60_000
const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * MIN).toISOString()
const EMPTY: ReminderState = { dismissed: new Set(), snoozedUntil: {} }

function dose(overrides: Record<string, unknown> = {}) {
  return {
    medication_log_id: 'log-1',
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: at(10),
    medication_log_status: 'pending',
    medication_log_taken_at: null,
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: at(0),
    medication_schedule: {
      medication_schedule_id: 'ms-1',
      medication_schedule_name: 'Amoxicillin',
      medication_schedule_dosage: '500 mg',
    },
    ...overrides,
  } as never
}

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    appointment_id: 'ap-1',
    pat_id: 'p-alice',
    doc_id: 'd-alan',
    appointment_date: at(8),
    appointment_status: 'confirmed',
    appointment_created_at: at(-600),
    appointment_reminder_sent_at: null,
    patient: { pat_id: 'p-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' },
    ...overrides,
  } as never
}

describe('which doses to remind of', () => {
  it('reminds of a pending dose the server has reminded, with how long is left and what it is', () => {
    expect(doseReminders([dose()], NOW, EMPTY)).toEqual([
      expect.objectContaining({
        kind: 'dose',
        title: 'Medication due in 10 minutes',
        detail: 'Amoxicillin 500 mg at 08:00',
        doseId: 'log-1',
      }),
    ])
    expect(doseReminders([dose({ medication_log_scheduled_at: at(1) })], NOW, EMPTY)[0]).toMatchObject({
      title: 'Medication due in 1 minute',
    })
  })

  it('says it is due now once the time has come, until the follow-up takes over half an hour later', () => {
    const due = dose({ medication_log_scheduled_at: at(0) })
    expect(doseReminders([due], NOW, EMPTY)[0]).toMatchObject({ title: 'Medication due now' })
    expect(doseReminders([due], NOW + 29 * MIN, EMPTY)).toHaveLength(1)
    expect(doseReminders([due], NOW + 30 * MIN, EMPTY)).toEqual([])
  })

  it('says nothing the server has not: no reminder sent, no reminder shown', () => {
    // Reminders off, before the preferred time, or not yet in the lead time.
    expect(doseReminders([dose({ medication_log_pre_dose_sent_at: null })], NOW, EMPTY)).toEqual([])
  })

  it.each(['taken', 'missed', 'skipped'])('says nothing of a dose already %s', (status) => {
    expect(doseReminders([dose({ medication_log_status: status })], NOW, EMPTY)).toEqual([])
  })

  it('keeps a dismissed dose hidden, and a snoozed one until its five minutes are up', () => {
    expect(doseReminders([dose()], NOW, { dismissed: new Set(['dose:log-1']), snoozedUntil: {} })).toEqual([])
    const snoozed = { dismissed: new Set<string>(), snoozedUntil: { 'dose:log-1': NOW + 5 * MIN } }
    expect(doseReminders([dose()], NOW + 4 * MIN, snoozed)).toEqual([])
    expect(doseReminders([dose()], NOW + 5 * MIN, snoozed)).toHaveLength(1)
  })

  it('offers a snooze only while the card would still come back after it, with a minute to spare', () => {
    // The card goes 30 minutes after the dose. Five minutes of snooze, plus
    // a minute for the card's 30-second clock, must still fit before then.
    const due = dose({ medication_log_scheduled_at: at(0) })
    expect(doseReminders([due], NOW, EMPTY)[0]).toMatchObject({ canSnooze: true })
    expect(doseReminders([due], NOW + 24 * MIN - 1, EMPTY)[0]).toMatchObject({ canSnooze: true })
    expect(doseReminders([due], NOW + 24 * MIN, EMPTY)[0]).toMatchObject({ canSnooze: false })
    expect(doseReminders([due], NOW + 29 * MIN, EMPTY)[0]).toMatchObject({ canSnooze: false })
  })

  it('lists the soonest first', () => {
    const items = doseReminders(
      [dose({ medication_log_id: 'late', medication_log_scheduled_at: at(9) }), dose({ medication_log_id: 'soon', medication_log_scheduled_at: at(3) })],
      NOW,
      EMPTY,
    )
    expect(items.map((item) => item.doseId)).toEqual(['soon', 'late'])
  })
})

describe('which appointments to remind of', () => {
  const patientView = { role: 'patient' as const, doctorName: 'Dr. Alan Cruz' }

  it('reminds a patient from ten minutes before, naming their doctor, with a way to the appointment', () => {
    expect(appointmentReminders([appointment()], NOW, EMPTY, patientView)).toEqual([
      expect.objectContaining({
        title: 'Appointment in 8 minutes',
        detail: 'Dr. Alan Cruz · 07:58',
        href: '/patient/appointments',
        actionLabel: 'View appointment',
      }),
    ])
  })

  it('reminds the doctor, naming the patient, with a way to their record', () => {
    expect(appointmentReminders([appointment()], NOW, EMPTY, { role: 'doctor' })).toEqual([
      expect.objectContaining({
        detail: 'Alice Santos · 07:58',
        href: '/doctor/patients/p-alice',
        actionLabel: 'Open record',
      }),
    ])
  })

  it('says nothing more than ten minutes ahead, or once it has started', () => {
    expect(appointmentReminders([appointment({ appointment_date: at(11) })], NOW, EMPTY, patientView)).toEqual([])
    expect(appointmentReminders([appointment({ appointment_date: at(0) })], NOW, EMPTY, patientView)).toEqual([])
  })

  it.each(['cancelled', 'completed', 'no_show'])('says nothing of an appointment that is %s', (status) => {
    expect(appointmentReminders([appointment({ appointment_status: status })], NOW, EMPTY, patientView)).toEqual([])
  })
})

// --- The card on screen ----------------------------------------------------------

const hooks = vi.hoisted(() => ({
  user: null as unknown,
  doses: [] as unknown[],
  appointments: [] as unknown[],
  mutate: vi.fn(),
  saveFailed: false,
}))

vi.mock('@/features/auth/auth-context', () => ({ useCurrentUser: () => hooks.user }))
vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchDoses: async () => hooks.doses,
}))
vi.mock('@/features/medications/hooks', () => ({
  useSetDoseStatus: () => ({
    mutate: hooks.mutate,
    isPending: false,
    isError: hooks.saveFailed,
    variables: hooks.saveFailed ? { doseId: 'log-1', status: 'taken' } : undefined,
  }),
}))
vi.mock('@/features/appointments/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/appointments/api')>()),
  fetchAppointments: async () => hooks.appointments,
}))
vi.mock('@/features/patients/hooks', () => ({
  useMyDoctor: () => ({ data: { doc_first_name: 'Alan', doc_last_name: 'Cruz' } }),
}))

const { ReminderTray } = await import('@/features/reminders/components/reminder-tray')

const PATIENT = {
  userId: 'u-alice',
  role: 'patient',
  profile: { kind: 'patient', patient: { pat_id: 'p-alice', doc_id: 'd-alan' } },
}

let client: QueryClient

function renderTray() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <main id="main-content" tabIndex={-1}>
          <button type="button">Something on the page</button>
        </main>
        <ReminderTray />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Lets queries settle on the faked clock. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

const tray = () => screen.queryByRole('region', { name: 'Reminders' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  sessionStorage.clear()
  hooks.user = PATIENT
  hooks.doses = [dose()]
  hooks.appointments = []
  hooks.mutate.mockReset()
  hooks.saveFailed = false
})

afterEach(() => {
  vi.useRealTimers()
  delete document.documentElement.dataset['reminderTray']
})

describe('the reminder card', () => {
  it('shows the dose, announces it politely, and leaves focus where it was', async () => {
    renderTray()
    const pageButton = screen.getByRole('button', { name: 'Something on the page' })
    pageButton.focus()
    await settle()

    const card = within(tray()!)
    expect(card.getByText('Medication due in 10 minutes')).toBeInTheDocument()
    expect(card.getByText('Amoxicillin 500 mg at 08:00')).toBeInTheDocument()
    const announcer = document.querySelector('[data-reminder-announcer]')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toHaveTextContent('Medication due in 10 minutes. Amoxicillin 500 mg at 08:00.')
    // Not a second status on the page: the page's own messages keep that role.
    expect(screen.queryAllByRole('status')).toEqual([])
    expect(document.activeElement).toBe(pageButton)
    // The page is told to keep the card's space clear.
    expect(document.documentElement.dataset['reminderTray']).toBe('')
  })

  it('marks the dose taken from the card', async () => {
    renderTray()
    await settle()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Mark taken: Amoxicillin' }))
    expect(hooks.mutate).toHaveBeenCalledWith({ doseId: 'log-1', status: 'taken' })
  })

  it('snoozes for five minutes, then reminds again', async () => {
    renderTray()
    await settle()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' }))
    expect(tray()).toBeNull()
    expect(document.documentElement.dataset['reminderTray']).toBeUndefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * MIN)
    })
    expect(tray()).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN + 30_000)
    })
    expect(within(tray()!).getByText('Medication due in 5 minutes')).toBeInTheDocument()
  })

  it('stays dismissed for the session, even when the page is opened again', async () => {
    const { unmount } = renderTray()
    await settle()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Dismiss reminder: Amoxicillin' }))
    expect(tray()).toBeNull()
    unmount()

    renderTray()
    await settle()
    expect(tray()).toBeNull()
  })

  it('dismisses with Escape from inside it, and hands focus back to the page', async () => {
    renderTray()
    await settle()
    const snooze = within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' })
    snooze.focus()
    fireEvent.keyDown(snooze, { key: 'Escape' })

    expect(tray()).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('main-content'))
  })

  it('shows nothing when nothing is due, and leaves the page’s space alone', async () => {
    hooks.doses = [dose({ medication_log_pre_dose_sent_at: null })]
    renderTray()
    await settle()
    expect(tray()).toBeNull()
    expect(document.documentElement.dataset['reminderTray']).toBeUndefined()
  })

  it('reminds a doctor of their next appointment, with the patient’s record a step away', async () => {
    hooks.user = { userId: 'u-alan', role: 'doctor', profile: { kind: 'doctor', doctor: { doc_id: 'd-alan' } } }
    hooks.appointments = [appointment()]
    renderTray()
    await settle()

    const card = within(tray()!)
    expect(card.getByText('Appointment in 8 minutes')).toBeInTheDocument()
    expect(card.getByText('Alice Santos · 07:58')).toBeInTheDocument()
    expect(card.getByRole('link', { name: 'Open record' })).toHaveAttribute('href', '/doctor/patients/p-alice')
    expect(card.queryByRole('button', { name: /mark taken/i })).toBeNull()
  })

  it('drops an appointment cancelled while the page stays open, within a minute', async () => {
    hooks.doses = []
    hooks.appointments = [appointment()]
    renderTray()
    await settle()
    expect(within(tray()!).getByText('Appointment in 8 minutes')).toBeInTheDocument()

    hooks.appointments = [appointment({ appointment_status: 'cancelled' })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(tray()).toBeNull()
  })

  it('keeps its own copy of the appointments, so its refetch cannot fail a page’s list', async () => {
    renderTray()
    await settle()
    const keys = client.getQueryCache().getAll().map((query) => JSON.stringify(query.queryKey))
    // Filed under the signed-in account, like every key (queryKeysFor).
    expect(keys).toContain(JSON.stringify(['u-alice', 'appointments', 'reminders', 'patient', 'p-alice']))
    expect(keys).not.toContain(JSON.stringify(['u-alice', 'appointments', 'patient', 'p-alice']))
  })

  it('does not offer a snooze it cannot keep, in the last minutes before the follow-up', async () => {
    // Due 26 minutes ago: the card goes at 30, before five more minutes.
    hooks.doses = [dose({ medication_log_scheduled_at: at(-26) })]
    renderTray()
    await settle()
    const card = within(tray()!)
    expect(card.getByText('Medication due now')).toBeInTheDocument()
    const snooze = card.getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' })
    expect(snooze).toHaveAttribute('aria-disabled', 'true')
    expect(snooze).toHaveAccessibleDescription(/not available/i)

    fireEvent.click(snooze)
    expect(within(tray()!).getByText('Medication due now')).toBeInTheDocument()
  })

  it('keeps focus on the snooze button when it stops being available', async () => {
    // Seven minutes to spare: available now, not a minute later.
    hooks.doses = [dose({ medication_log_scheduled_at: at(-23) })]
    renderTray()
    await settle()
    const snooze = within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' })
    expect(snooze).not.toHaveAttribute('aria-disabled')
    snooze.focus()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(snooze).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(snooze)
  })

  it('leaves focus where the patient moved it, when a dose marked taken leaves later', async () => {
    renderTray()
    await settle()
    const markTaken = within(tray()!).getByRole('button', { name: 'Mark taken: Amoxicillin' })
    markTaken.focus()
    fireEvent.click(markTaken)
    expect(hooks.mutate).toHaveBeenCalledWith({ doseId: 'log-1', status: 'taken' })

    // While the save is on its way, the patient goes back to the page.
    const pageButton = screen.getByRole('button', { name: 'Something on the page' })
    pageButton.focus()
    // The saved dose drops out at the next refetch.
    hooks.doses = []
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })

    expect(tray()).toBeNull()
    expect(document.activeElement).toBe(pageButton)
  })

  it('hands focus on when a dose marked taken leaves, even if other reminders came meanwhile', async () => {
    renderTray()
    await settle()
    const markTaken = within(tray()!).getByRole('button', { name: 'Mark taken: Amoxicillin' })
    markTaken.focus()
    fireEvent.click(markTaken)

    // Another dose comes while the save is out; focus is still on the card.
    hooks.doses = [dose(), dose({ medication_log_id: 'log-2', medication_log_scheduled_at: at(12) })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(document.activeElement).toBe(markTaken)

    // Then the saved one drops out, and focus goes to the card that is left.
    hooks.doses = [dose({ medication_log_id: 'log-2', medication_log_scheduled_at: at(12) })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(within(tray()!).queryByText(/Amoxicillin 500 mg at 08:00/)).toBeNull()
    expect(tray()!.contains(document.activeElement)).toBe(true)
  })

  it('keeps the card, with its message, when marking it taken fails, and later changes take no focus', async () => {
    renderTray()
    await settle()
    const markTaken = within(tray()!).getByRole('button', { name: 'Mark taken: Amoxicillin' })
    markTaken.focus()
    fireEvent.click(markTaken)
    hooks.saveFailed = true
    // The card's next tick shows the failure.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(within(tray()!).getByRole('alert')).toHaveTextContent('That was not saved.')

    // Focus then leaves the page, and a reminder comes: nothing takes it.
    markTaken.blur()
    expect(document.activeElement).toBe(document.body)
    hooks.doses = [dose(), dose({ medication_log_id: 'log-2', medication_log_scheduled_at: at(12) })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(within(tray()!).getAllByRole('listitem')).toHaveLength(2)
    expect(document.activeElement).toBe(document.body)
  })

  it('takes at most half the screen, and scrolls only once the cards need more', async () => {
    renderTray()
    await settle()
    // jsdom lays nothing out: the cards fit, so the list does not scroll.
    const list = () => tray()!.querySelector('ul')!
    expect(list()).toHaveClass('max-h-[50dvh]')
    expect(list()).not.toHaveClass('overflow-y-auto')

    // Taller than it may be: now it scrolls.
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    hooks.doses = [dose(), dose({ medication_log_id: 'log-2', medication_log_scheduled_at: at(12) })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(list()).toHaveClass('overflow-y-auto')
    scrollHeight.mockRestore()
    clientHeight.mockRestore()
  })

  it('shows an administrator nothing', async () => {
    hooks.user = { userId: 'u-admin', role: 'admin', profile: { kind: 'admin', admin: { admin_id: 'a-1' } } }
    hooks.appointments = [appointment()]
    renderTray()
    await settle()
    expect(tray()).toBeNull()
  })
})

/**
 * What a screen reader is told. The announcer is a live region: it speaks
 * when its text changes, so these record each change rather than only the
 * text it ends with.
 */
describe('reading reminders out', () => {
  const PARACETAMOL = {
    medication_log_id: 'log-2',
    medication_schedule_id: 'ms-2',
    medication_log_scheduled_at: at(12),
    medication_schedule: {
      medication_schedule_id: 'ms-2',
      medication_schedule_name: 'Paracetamol',
      medication_schedule_dosage: '1 tablet',
    },
  }

  /** Every change of the announcer's text from now on, in order. */
  function listenToAnnouncer() {
    const announcer = document.querySelector('[data-reminder-announcer]')!
    const said: string[] = []
    const observer = new MutationObserver(() => said.push(announcer.textContent ?? ''))
    observer.observe(announcer, { childList: true, characterData: true, subtree: true })
    return { said, spoken: () => said.filter(Boolean), stop: () => observer.disconnect() }
  }

  async function wait(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('reads a snoozed reminder out again when it comes back, and only once', async () => {
    renderTray()
    await settle()
    const announcer = document.querySelector('[data-reminder-announcer]')
    expect(announcer).toHaveTextContent('Medication due in 10 minutes. Amoxicillin 500 mg at 08:00.')

    const listener = listenToAnnouncer()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' }))
    await wait(4 * MIN)
    expect(tray()).toBeNull()
    expect(listener.spoken()).toEqual([])

    await wait(MIN + 30_000)
    expect(within(tray()!).getByText('Medication due in 5 minutes')).toBeInTheDocument()
    expect(announcer).toHaveTextContent('Medication due in 5 minutes. Amoxicillin 500 mg at 08:00.')
    expect(listener.spoken()).toEqual(['Medication due in 5 minutes. Amoxicillin 500 mg at 08:00.'])

    // While it stays on screen, the minutes count down on the card but
    // nothing is read out again.
    await wait(2 * MIN)
    expect(within(tray()!).getByText('Medication due in 3 minutes')).toBeInTheDocument()
    expect(listener.spoken()).toHaveLength(1)
    listener.stop()
  })

  it('reads it out again even when its words have not changed', async () => {
    // Due now before the snooze and still due now after it.
    hooks.doses = [dose({ medication_log_scheduled_at: at(0) })]
    renderTray()
    await settle()
    const announcer = document.querySelector('[data-reminder-announcer]')
    expect(announcer).toHaveTextContent('Medication due now. Amoxicillin 500 mg at 07:50.')

    const listener = listenToAnnouncer()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' }))
    await wait(5 * MIN + 30_000)

    expect(within(tray()!).getByText('Medication due now')).toBeInTheDocument()
    expect(listener.spoken()).toEqual(['Medication due now. Amoxicillin 500 mg at 07:50.'])
    listener.stop()
  })

  it('reads out only the reminder that comes back, not one still on screen', async () => {
    hooks.doses = [dose(), dose(PARACETAMOL)]
    renderTray()
    await settle()
    expect(document.querySelector('[data-reminder-announcer]')).toHaveTextContent(
      'Medication due in 10 minutes. Amoxicillin 500 mg at 08:00. ' +
        'Medication due in 12 minutes. Paracetamol 1 tablet at 08:02.',
    )

    const listener = listenToAnnouncer()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Remind me in 5 min: Amoxicillin' }))
    await wait(5 * MIN + 30_000)

    const card = within(tray()!)
    expect(card.getByText('Medication due in 5 minutes')).toBeInTheDocument()
    expect(card.getByText('Medication due in 7 minutes')).toBeInTheDocument()
    expect(listener.spoken()).toEqual(['Medication due in 5 minutes. Amoxicillin 500 mg at 08:00.'])
    listener.stop()
  })

  it('reads nothing out when a reminder is dismissed, and it does not come back', async () => {
    hooks.doses = [dose(), dose(PARACETAMOL)]
    renderTray()
    await settle()

    const listener = listenToAnnouncer()
    fireEvent.click(within(tray()!).getByRole('button', { name: 'Dismiss reminder: Paracetamol' }))
    await wait(10 * MIN)

    const card = within(tray()!)
    expect(card.queryByText(/Paracetamol/)).toBeNull()
    expect(card.getByText('Medication due now')).toBeInTheDocument()
    expect(listener.spoken()).toEqual([])
    listener.stop()
  })
})
