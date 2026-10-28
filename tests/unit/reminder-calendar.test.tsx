import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const api = vi.hoisted(() => ({ doses: vi.fn() }))
vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: api.doses,
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

describe('reminders on the patient’s phone', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    api.doses.mockReset().mockResolvedValue(DOSES)
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
