import { describe, expect, it } from 'vitest'

import { summariseAdherence, type MedicationLog } from '@/features/medications/api'
import { patientDoseState } from '@/features/medications/dose-status'
import { medicationLogStatus, patientDoseStatus } from '@/lib/status'

/**
 * QA 9/13 — the reminder hierarchy on the patient's screens: Due, then
 * Overdue once the time has passed, then Missed once the system has written
 * the dose off after the grace period.
 *
 * Timing only. Overdue is how an open dose reads, not a database status, and
 * nothing here says how serious a late dose is.
 */

const SCHEDULED = '2026-09-13T00:00:00Z'
const AT = Date.parse(SCHEDULED)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function dose(
  status: MedicationLog['medication_log_status'],
  scheduledAt: string = SCHEDULED,
): MedicationLog {
  return {
    medication_log_id: crypto.randomUUID(),
    medication_schedule_id: 'schedule',
    medication_log_scheduled_at: scheduledAt,
    medication_log_taken_at: status === 'taken' ? SCHEDULED : null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
  }
}

describe('an open dose, by its time', () => {
  it.each([
    ['an hour before', AT - HOUR],
    ['a minute before', AT - MINUTE],
    ['a millisecond before', AT - 1],
  ])('is Due %s its time', (_label, now) => {
    expect(patientDoseState(dose('pending'), now)).toBe('due')
  })

  it('is still Due at the scheduled instant itself', () => {
    // The boundary: a time has passed only once it is earlier than now, as on
    // the appointment screens and in the overdue job's own comparison.
    expect(patientDoseState(dose('pending'), AT)).toBe('due')
  })

  it.each([
    ['a millisecond after', AT + 1],
    ['a minute after', AT + MINUTE],
    ['30 minutes after, once the reminder has gone out,', AT + 30 * MINUTE],
    ['a minute inside the six-hour grace period', AT + 6 * HOUR - MINUTE],
  ])('is Overdue %s its time', (_label, now) => {
    expect(patientDoseState(dose('pending'), now)).toBe('overdue')
  })

  it('stays Overdue past the grace period until the system writes it off', () => {
    // The overdue job runs hourly. Until it has, the dose is still pending and
    // can still be recorded, so the screen does not second-guess the grace
    // period by applying it itself.
    expect(patientDoseState(dose('pending'), AT + 7 * HOUR)).toBe('overdue')
  })

  it('is Due, not Overdue, when its time cannot be read', () => {
    expect(patientDoseState(dose('pending', 'not a time'), AT)).toBe('due')
  })
})

describe('a dose the database has already settled', () => {
  it.each([
    ['before its time', AT - HOUR],
    ['after its time', AT + HOUR],
    ['past the grace period', AT + 7 * HOUR],
  ])('is Missed when recorded missed, looked at %s', (_label, now) => {
    expect(patientDoseState(dose('missed'), now)).toBe('missed')
  })

  it.each(['taken', 'skipped'] as const)('reads %s whatever the time', (status) => {
    for (const now of [AT - HOUR, AT, AT + HOUR, AT + 7 * HOUR]) {
      expect(patientDoseState(dose(status), now)).toBe(status)
    }
  })
})

describe('how each state reads to the patient', () => {
  it('keeps Due, Taken and Skipped exactly as they were', () => {
    expect(patientDoseStatus.due).toBe(medicationLogStatus.pending)
    expect(patientDoseStatus.taken).toBe(medicationLogStatus.taken)
    expect(patientDoseStatus.skipped).toBe(medicationLogStatus.skipped)
  })

  it('shows Overdue as a warning, and Missed more strongly than that', () => {
    expect(patientDoseStatus.due.tone).toBe('info')
    expect(patientDoseStatus.overdue).toMatchObject({ label: 'Overdue', tone: 'warning' })
    expect(patientDoseStatus.missed).toMatchObject({ label: 'Missed', tone: 'danger' })
  })

  it('tells Due, Overdue and Missed apart without relying on colour', () => {
    const steps = [patientDoseStatus.due, patientDoseStatus.overdue, patientDoseStatus.missed]
    expect(new Set(steps.map((step) => step.label)).size).toBe(3)
    expect(new Set(steps.map((step) => step.icon)).size).toBe(3)
  })
})

describe('what the clinician and the adherence figures see', () => {
  it('leaves the shared medication statuses unchanged', () => {
    expect(
      Object.fromEntries(
        Object.entries(medicationLogStatus).map(([key, status]) => [
          key,
          [status.label, status.tone],
        ]),
      ),
    ).toEqual({
      pending: ['Due', 'info'],
      taken: ['Taken', 'success'],
      missed: ['Missed', 'warning'],
      skipped: ['Skipped', 'neutral'],
    })
  })

  it('still counts an overdue dose as pending in adherence', () => {
    // Overdue is presentation only. The row is still pending, so the
    // patient's week and the doctor's adherence view count it as before.
    const result = summariseAdherence([dose('pending'), dose('taken')])
    expect(result).toMatchObject({ pending: 1, taken: 1, missed: 0, resolved: 1, rate: 100 })
  })
})
