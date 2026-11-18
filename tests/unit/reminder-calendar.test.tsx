import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DoseWithSchedule } from '@/features/medications/api'
import {
  buildReminderCalendar,
  foldLine,
  icsText,
  upcomingDoseTimes,
} from '@/features/medications/reminder-calendar'

import { captureDownloads } from './support/capture-download'

/**
 * Offline medication reminders as a calendar file (`reminder-calendar.ts`):
 * the doses still to come, each time with its alarms, in a file every
 * calendar app reads - and the patient's section that makes it.
 */

const api = vi.hoisted(() => ({ doses: vi.fn(), plans: vi.fn() }))
vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: api.doses,
}))

vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: api.plans,
}))

const { PhoneReminders } = await import('@/features/medications/components/phone-reminders')

const NOW = new Date('2026-11-04T02:00:00Z')
const ALICE = { pat_id: 'p-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' }

function dose(id: string, at: string, name = 'Amoxicillin', status = 'pending'): DoseWithSchedule {
  return {
    medication_log_id: id,
    medication_schedule_id: `ms-${name}`,
    medication_log_scheduled_at: at,
    medication_log_taken_at: null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: null,
    medication_schedule: {
      medication_schedule_id: `ms-${name}`,
      medication_schedule_name: name,
      medication_schedule_dosage: '500 mg',
    },
  } as DoseWithSchedule
}

const DOSES = [
  dose('past', '2026-11-04T00:00:00Z'), // before now
  dose('taken', '2026-11-04T12:00:00Z', 'Paracetamol', 'taken'),
  dose('evening-a', '2026-11-04T12:00:00Z'),
  dose('evening-b', '2026-11-04T12:00:00Z', 'Paracetamol'),
  dose('tomorrow', '2026-11-05T00:00:00Z'),
]

/** A dose whose schedule carries the doctor's reminder setting (migration 59). */
function doseWithSetting(id: string, at: string, name: string, remindersOn: boolean): DoseWithSchedule {
  const base = dose(id, at, name)
  return {
    ...base,
    medication_schedule: {
      ...base.medication_schedule!,
      medication_schedule_reminders_is_enabled: remindersOn,
    },
  }
}

const build = (overrides: Partial<Parameters<typeof buildReminderCalendar>[0]> = {}) =>
  buildReminderCalendar({
    patient: ALICE,
    doses: DOSES,
    leadMinutes: 10,
    includeNames: true,
    generatedAt: NOW,
    ...overrides,
  })

const text = (file: { bytes: Uint8Array }) => new TextDecoder().decode(file.bytes)
/** The file's content lines, unfolded. */
const unfolded = (file: { bytes: Uint8Array }) => text(file).replace(/\r\n /g, '').split('\r\n')

describe('the reminders’ calendar file', () => {
  it('holds the doses still to come, one event per dose time', () => {
    const file = build()
    expect(file.mimeType).toBe('text/calendar')
    expect(file.fileName).toBe('recoverease-medicine-reminders-alice-santos-2026-11-04.ics')
    expect(file.count).toBe(2)

    const lines = unfolded(file)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(2)
    // Two medicines due together are one reminder, not two alarms at once.
    expect(lines).toContain('DTSTART:20261104T120000Z')
    expect(lines).toContain('SUMMARY:Take Amoxicillin 500 mg\\, Paracetamol 500 mg')
    expect(lines).toContain('DTSTART:20261105T000000Z')
    // Neither the dose already taken nor the one already past.
    expect(text(file)).not.toContain('20261104T000000Z')
  })

  it('rings before each dose time and at it, as the patient chose', () => {
    const lines = unfolded(build({ leadMinutes: 15 }))
    expect(lines.filter((line) => line === 'TRIGGER:-PT15M')).toHaveLength(2)
    expect(lines.filter((line) => line === 'TRIGGER:PT0M')).toHaveLength(2)
    expect(lines).toContain('DESCRIPTION:Take Amoxicillin 500 mg in 15 minutes')

    const atTheTime = unfolded(build({ leadMinutes: 0 }))
    expect(atTheTime.some((line) => line.startsWith('TRIGGER:-'))).toBe(false)
    expect(atTheTime.filter((line) => line === 'TRIGGER:PT0M')).toHaveLength(2)
  })

  it('leaves medicine names out when the patient asks', () => {
    const file = build({ includeNames: false })
    expect(text(file)).not.toMatch(/Amoxicillin|Paracetamol/)
    expect(unfolded(file)).toContain('SUMMARY:Medicine due (RecoverEase)')
  })

  it('names each dose time the same way every time, so a calendar can update it', () => {
    const uids = (file: { bytes: Uint8Array }) => unfolded(file).filter((line) => line.startsWith('UID:'))
    expect(uids(build())).toEqual(uids(build({ generatedAt: new Date('2026-11-04T03:00:00Z') })))
    expect(uids(build())).toEqual(['UID:dose-evening-a@recoverease', 'UID:dose-tomorrow@recoverease'])
  })

  it('is written as RFC 5545 asks: CRLF lines, none over 75 octets, text escaped', () => {
    const raw = text(build())
    expect(raw.endsWith('\r\n')).toBe(true)
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n')
    for (const line of raw.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(icsText('a, b; c\\d\ne')).toBe('a\\, b\\; c\\\\d\\ne')
  })

  it('folds a long line without splitting a character', () => {
    const line = `SUMMARY:${'Café '.repeat(30)}`
    const folded = foldLine(line)
    expect(folded.split('\r\n').every((piece) => new TextEncoder().encode(piece).length <= 75)).toBe(true)
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('has nothing to hold when no dose is still to come', () => {
    expect(upcomingDoseTimes([dose('done', '2026-11-03T00:00:00Z')], NOW)).toEqual([])
    expect(build({ doses: [] }).count).toBe(0)
  })
})

describe('the calendar file and the doctor’s reminder switch', () => {
  const EVENING = '2026-11-04T12:00:00Z'
  const TOMORROW = '2026-11-05T00:00:00Z'

  it('holds a medicine whose reminders are on', () => {
    const file = build({ doses: [doseWithSetting('a', EVENING, 'Amoxicillin', true)] })
    expect(file.count).toBe(1)
    expect(file.withheld).toBe(0)
    expect(unfolded(file)).toContain('SUMMARY:Take Amoxicillin 500 mg')
  })

  it('leaves out a medicine whose reminders the doctor turned off', () => {
    const file = build({
      doses: [
        doseWithSetting('a', EVENING, 'Amoxicillin', false),
        doseWithSetting('b', TOMORROW, 'Amoxicillin', false),
      ],
    })
    expect(file.count).toBe(0)
    expect(file.withheld).toBe(2)
    expect(text(file)).not.toContain('BEGIN:VEVENT')
    expect(text(file)).not.toContain('Amoxicillin')
  })

  it('with some on and some off, holds only the medicines that are on', () => {
    const file = build({
      doses: [
        // Due together: the event names only the medicine that is on.
        doseWithSetting('a-evening', EVENING, 'Amoxicillin', false),
        doseWithSetting('b-evening', EVENING, 'Paracetamol', true),
        // A time at which only the medicine switched off is due: no event.
        doseWithSetting('a-tomorrow', TOMORROW, 'Amoxicillin', false),
      ],
    })
    expect(file.count).toBe(1)
    expect(file.withheld).toBe(2)

    const lines = unfolded(file)
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1)
    expect(lines).toContain('SUMMARY:Take Paracetamol 500 mg')
    expect(lines).toContain('UID:dose-b-evening@recoverease')
    expect(text(file)).not.toContain('Amoxicillin')
    expect(text(file)).not.toContain('20261105T000000Z')
  })

  it('leaves out a medicine that is off with names hidden too', () => {
    const file = build({
      includeNames: false,
      doses: [
        doseWithSetting('a', EVENING, 'Amoxicillin', false),
        doseWithSetting('b', TOMORROW, 'Paracetamol', true),
      ],
    })
    expect(unfolded(file).filter((line) => line.startsWith('DTSTART:'))).toEqual([
      'DTSTART:20261105T000000Z',
    ])
  })

  it('reads a dose that carries no setting as on', () => {
    const file = build({ doses: [dose('a', EVENING)] })
    expect(file.count).toBe(1)
    expect(file.withheld).toBe(0)
  })

  it('writes an event exactly as before: same lines, same two alarms', () => {
    const file = build({ doses: [doseWithSetting('a', EVENING, 'Amoxicillin', true)] })
    expect(unfolded(file)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//RecoverEase//Medication reminders//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:RecoverEase medicine reminders',
      'BEGIN:VEVENT',
      'UID:dose-a@recoverease',
      'DTSTAMP:20261104T020000Z',
      'DTSTART:20261104T120000Z',
      'DTEND:20261104T121500Z',
      'SUMMARY:Take Amoxicillin 500 mg',
      'DESCRIPTION:A dose your doctor scheduled in RecoverEase. Record it in RecoverEase once you have taken it.',
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Take Amoxicillin 500 mg in 10 minutes',
      'TRIGGER:-PT10M',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Take Amoxicillin 500 mg now',
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ])
  })
})

describe('reminders on the patient’s phone', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    api.doses.mockReset().mockResolvedValue(DOSES)
    api.plans.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the patient’s own next 30 days of doses and saves them as a calendar file', async () => {
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: '30' } })
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))

      await waitFor(() => expect(capture.files).toHaveLength(1))
      expect(api.doses).toHaveBeenCalledWith({
        patientId: 'p-alice',
        from: NOW.toISOString(),
        to: '2026-12-05T02:00:00.000Z',
        withReminderSetting: true,
      })
      const file = capture.files[0]!
      expect(file.type).toBe('text/calendar')
      expect(new TextDecoder().decode(await file.bytes())).toContain('TRIGGER:-PT30M')
      expect(
        await screen.findByText(
          'Saved 2 dose times for the next 30 days. Open the file to add them to your calendar.',
        ),
      ).toBeInTheDocument()
    } finally {
      capture.release()
    }
  })

  it('saves no file, and says so, when there is nothing to remind', async () => {
    api.doses.mockResolvedValue([])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      expect(await screen.findByText('There are no upcoming doses to add yet.')).toBeInTheDocument()
      expect(capture.files).toHaveLength(0)
    } finally {
      capture.release()
    }
  })

  it('downloads only the medicines whose reminders are on, and says some were left out', async () => {
    api.doses.mockResolvedValue([
      doseWithSetting('off', '2026-11-04T12:00:00Z', 'Amoxicillin', false),
      doseWithSetting('on', '2026-11-05T00:00:00Z', 'Paracetamol', true),
    ])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))

      await waitFor(() => expect(capture.files).toHaveLength(1))
      const calendar = new TextDecoder().decode(await capture.files[0]!.bytes())
      expect(calendar).toContain('Paracetamol')
      expect(calendar).not.toContain('Amoxicillin')
      expect(
        await screen.findByText(
          'Saved 1 dose time for the next 30 days. Open the file to add them to your calendar. Medicines with reminders turned off by your doctor were left out.',
        ),
      ).toBeInTheDocument()
    } finally {
      capture.release()
    }
  })

  it('saves no file when the doctor has turned reminders off for every dose to come', async () => {
    api.doses.mockResolvedValue([doseWithSetting('off', '2026-11-04T12:00:00Z', 'Amoxicillin', false)])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      expect(
        await screen.findByText(
          'There is nothing to add: your doctor has turned off reminders for your upcoming doses.',
        ),
      ).toBeInTheDocument()
      expect(capture.files).toHaveLength(0)
    } finally {
      capture.release()
    }
  })

  it('saves no file once the doctor has discharged the patient (migration 60)', async () => {
    api.doses.mockResolvedValue(DOSES)
    api.plans.mockResolvedValue([{ treatment_plan_status: 'discharged' }])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      expect(
        await screen.findByText('Your care plan has ended. Book a follow-up if you need more care.'),
      ).toBeInTheDocument()
      expect(capture.files).toHaveLength(0)
    } finally {
      capture.release()
    }
  })

  it('leaves out a discharged plan’s medicines and keeps an active plan’s', async () => {
    const onPlan = (id: string, name: string, planId: string) => {
      const row = doseWithSetting(id, '2026-11-04T12:00:00Z', name, true) as unknown as {
        medication_schedule: Record<string, unknown>
      }
      row.medication_schedule['prescription'] = { pat_id: 'p-alice', treatment_plan_id: planId }
      return row
    }
    api.doses.mockResolvedValue([onPlan('a', 'Amoxicillin', 'plan-a'), onPlan('b', 'Ibuprofen', 'plan-b')])
    api.plans.mockResolvedValue([
      { treatment_plan_id: 'plan-a', treatment_plan_status: 'discharged' },
      { treatment_plan_id: 'plan-b', treatment_plan_status: 'active' },
    ])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      expect(await screen.findByText(/care plan your doctor has ended, or not yet placed on a care plan, were left out/)).toBeInTheDocument()
      const text = new TextDecoder().decode(await capture.files[0]!.bytes())
      expect(text).toContain('Ibuprofen')
      expect(text).not.toContain('Amoxicillin')
    } finally {
      capture.release()
    }
  })

  it('leaves out a medicine on no care plan once the patient has a plan, and keeps it when they have none', async () => {
    const unplaced = doseWithSetting('u', '2026-11-04T12:00:00Z', 'Amoxicillin', true) as unknown as {
      medication_schedule: Record<string, unknown>
    }
    unplaced.medication_schedule['prescription'] = { pat_id: 'p-alice', treatment_plan_id: null }
    const placed = doseWithSetting('b', '2026-11-04T12:00:00Z', 'Ibuprofen', true) as unknown as {
      medication_schedule: Record<string, unknown>
    }
    placed.medication_schedule['prescription'] = { pat_id: 'p-alice', treatment_plan_id: 'plan-b' }
    api.doses.mockResolvedValue([unplaced, placed])
    api.plans.mockResolvedValue([
      { treatment_plan_id: 'plan-a', treatment_plan_status: 'discharged' },
      { treatment_plan_id: 'plan-b', treatment_plan_status: 'active' },
    ])
    const capture = captureDownloads()
    try {
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      expect(await screen.findByText(/not yet placed on a care plan, were left out/)).toBeInTheDocument()
      const text = new TextDecoder().decode(await capture.files[0]!.bytes())
      expect(text).toContain('Ibuprofen')
      expect(text).not.toContain('Amoxicillin')
    } finally {
      capture.release()
    }

    // A patient with no care plan at all keeps reminders for it, as before 60.
    api.doses.mockResolvedValue([unplaced])
    api.plans.mockResolvedValue([])
    const again = captureDownloads()
    try {
      cleanup()
      render(<PhoneReminders patient={ALICE} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
      await waitFor(() => expect(again.files).toHaveLength(1))
      expect(new TextDecoder().decode(await again.files[0]!.bytes())).toContain('Amoxicillin')
    } finally {
      again.release()
    }
  })

  it('says a file downloaded earlier is its own copy, to be removed by hand', () => {
    render(<PhoneReminders patient={ALICE} />)
    expect(
      screen.getByText(/A medicine your doctor has turned reminders off for is left out of a new file/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/A file you downloaded before is a separate copy.*delete them from your calendar yourself/),
    ).toBeInTheDocument()
  })

  it('says so when the doses could not be read - offline, as no connection', async () => {
    api.doses.mockRejectedValueOnce(new Error('Failed to fetch'))
    render(<PhoneReminders patient={ALICE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
    expect(await screen.findByText('No connection')).toBeInTheDocument()

    api.doses.mockRejectedValueOnce(new Error('Something broke'))
    fireEvent.click(screen.getByRole('button', { name: 'Download reminders (.ics)' }))
    expect(await screen.findByText('The reminders were not downloaded')).toBeInTheDocument()
  })

  it('says what the file does not do, and offers no pretend switch', () => {
    render(<PhoneReminders patient={ALICE} />)
    expect(
      screen.getByText(/do not change by themselves/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Mark each dose as taken here/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^Show medicine names/ })).toBeChecked()
  })
})
