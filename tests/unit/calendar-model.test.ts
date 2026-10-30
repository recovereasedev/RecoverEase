import { describe, expect, it } from 'vitest'

import type { AppointmentWithPatient } from '@/features/appointments/api'
import {
  addDays,
  appointmentEvents,
  daySummary,
  doseEvents,
  eventsByDay,
  longDay,
  monthTitle,
  monthWeeks,
  monthWindow,
  moodEvents,
  shiftMonth,
  todayIn,
  zonedDayAndTime,
} from '@/features/calendar/calendar-model'
import type { DoseWithSchedule } from '@/features/medications/api'
import type { RecoveryLog } from '@/features/recovery-logs/api'

/**
 * Module 6.2's calendar as data (`calendar-model.ts`): which days a month
 * shows, which day an instant falls on in the clinic's zone, and what each
 * record says on the calendar - only what the records hold.
 */

const MANILA = 'Asia/Manila'

function dose(overrides: Partial<DoseWithSchedule> = {}): DoseWithSchedule {
  return {
    medication_log_id: 'log-1',
    medication_schedule_id: 'ms-1',
    medication_log_scheduled_at: '2026-11-04T00:00:00Z', // 08:00 in Manila
    medication_log_taken_at: null,
    medication_log_status: 'pending',
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: null,
    medication_schedule: {
      medication_schedule_id: 'ms-1',
      medication_schedule_name: 'Amoxicillin',
      medication_schedule_dosage: '500 mg',
    },
    ...overrides,
  } as DoseWithSchedule
}

function appointment(overrides: Partial<AppointmentWithPatient> = {}): AppointmentWithPatient {
  return {
    appointment_id: 'appt-1',
    pat_id: 'p-alice',
    doc_id: 'd-alan',
    appointment_date: '2026-11-07T06:00:00Z', // 14:00 in Manila
    appointment_status: 'confirmed',
    appointment_created_at: '2026-10-01T00:00:00Z',
    appointment_reminder_sent_at: null,
    patient: { pat_id: 'p-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' },
    ...overrides,
  } as AppointmentWithPatient
}

function log(overrides: Partial<RecoveryLog> = {}): RecoveryLog {
  return {
    recovery_log_id: 'rl-1',
    pat_id: 'p-alice',
    recovery_log_date: '2026-11-04',
    recovery_log_notes: 'Walked to the corner shop.',
    recovery_log_mood_rating: 4,
    recovery_log_created_at: '2026-11-04T10:00:00Z',
    ...overrides,
  } as RecoveryLog
}

const DR_CRUZ = {
  doc_id: 'd-alan',
  doc_first_name: 'Alan',
  doc_last_name: 'Cruz',
  doc_specialization: null,
  doc_license_no: 'LIC-A-001',
  doc_contact_no: null,
}

describe('a month on the calendar', () => {
  it('runs from the Sunday on or before the 1st to the Saturday on or after the last day', () => {
    const weeks = monthWeeks({ year: 2026, month: 11 })
    expect(weeks).toHaveLength(5)
    expect(weeks[0]![0]).toBe('2026-11-01') // 1 November 2026 is a Sunday
    expect(weeks[4]![6]).toBe('2026-12-05')
    expect(weeks.every((week) => week.length === 7)).toBe(true)

    const february = monthWeeks({ year: 2026, month: 2 })
    expect(february[0]![0]).toBe('2026-02-01')
    expect(february).toHaveLength(4)
  })

  it('crosses the year in both directions', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('reads a day either side of the grid, so no zone offset loses an event', () => {
    const range = monthWindow({ year: 2026, month: 11 })
    expect(range.fromDay).toBe('2026-11-01')
    expect(range.toDay).toBe('2026-12-05')
    expect(range.from).toBe('2026-10-31T00:00:00.000Z')
    expect(range.to).toBe('2026-12-07T00:00:00.000Z')
  })

  it('is named and dated in words', () => {
    expect(monthTitle({ year: 2026, month: 11 })).toBe('November 2026')
    expect(longDay('2026-11-04')).toBe('Wednesday 4 November 2026')
  })
})

describe('the clinic’s day and time', () => {
  it('puts an instant on the day it is in the clinic, not in UTC', () => {
    // 23:30 UTC on the 3rd is 07:30 on the 4th in Manila.
    expect(zonedDayAndTime('2026-11-03T23:30:00Z', MANILA)).toEqual({ day: '2026-11-04', time: '07:30' })
    expect(zonedDayAndTime('2026-11-03T23:30:00Z', 'UTC')).toEqual({ day: '2026-11-03', time: '23:30' })
    expect(todayIn(MANILA, new Date('2026-11-03T16:00:00Z'))).toBe('2026-11-04')
  })

  it('says nothing for a time it cannot read', () => {
    expect(zonedDayAndTime('not a date', MANILA)).toBeNull()
    expect(doseEvents([dose({ medication_log_scheduled_at: 'garbage' })], MANILA, 0)).toEqual([])
  })
})

describe('a dose on the calendar', () => {
  const before = Date.parse('2026-11-03T00:00:00Z')
  const after = Date.parse('2026-11-05T00:00:00Z')

  it('is the slot when it is due, and says only that while it is still to come', () => {
    const [event] = doseEvents([dose()], MANILA, before)
    expect(event).toMatchObject({
      kind: 'dose',
      day: '2026-11-04',
      time: '08:00',
      title: 'Amoxicillin, 500 mg',
      detail: 'Scheduled',
    })
    expect(event!.status!.label).toBe('Due')
  })

  it('says when it was actually taken - a record, not the schedule', () => {
    const [event] = doseEvents(
      [dose({ medication_log_status: 'taken', medication_log_taken_at: '2026-11-04T00:12:00Z' })],
      MANILA,
      after,
    )
    expect(event!.time).toBe('08:00')
    expect(event!.detail).toBe('Taken at 08:12')
    expect(event!.status!.label).toBe('Taken')
  })

  it('tells a missed, a skipped and an unrecorded dose apart', () => {
    const details = doseEvents(
      [
        dose({ medication_log_id: 'a', medication_log_status: 'missed' }),
        dose({ medication_log_id: 'b', medication_log_status: 'skipped' }),
        dose({ medication_log_id: 'c', medication_log_status: 'pending' }),
      ],
      MANILA,
      after,
    ).map((event) => [event.detail, event.status!.label])
    expect(details).toEqual([
      ['Not taken', 'Missed'],
      ['Skipped', 'Skipped'],
      ['Not recorded yet', 'Overdue'],
    ])
  })
})

describe('an appointment on the calendar', () => {
  it('is at its time in the clinic, with its status in words', () => {
    const [event] = appointmentEvents([appointment()], MANILA, { doctor: DR_CRUZ })
    expect(event).toMatchObject({ kind: 'appointment', day: '2026-11-07', time: '14:00', title: 'Appointment' })
    expect(event!.status!.label).toBe('Confirmed')
  })

  it('names the patient’s doctor only when the appointment is that doctor’s', () => {
    expect(appointmentEvents([appointment()], MANILA, { doctor: DR_CRUZ })[0]!.detail).toBe(
      'With Dr. Alan Cruz',
    )
    // An earlier doctor's appointment: the patient may not read them.
    expect(
      appointmentEvents([appointment({ doc_id: 'd-earlier' })], MANILA, { doctor: DR_CRUZ })[0]!.detail,
    ).toBeNull()
    expect(appointmentEvents([appointment()], MANILA, { doctor: null })[0]!.detail).toBeNull()
  })

  it('names the patient, and links to them, on a doctor’s calendar', () => {
    const [event] = appointmentEvents([appointment()], MANILA, 'patient')
    expect(event!.detail).toBe('With Alice Santos')
    expect(event!.patientId).toBe('p-alice')
  })
})

describe('a mood check-in on the calendar', () => {
  it('is a check-in the patient recorded, on its day, with its rating in words', () => {
    expect(moodEvents([log()])).toEqual([
      expect.objectContaining({
        kind: 'mood',
        day: '2026-11-04',
        time: null,
        title: 'Mood check-in',
        detail: 'Good (4 of 5)',
      }),
    ])
  })

  it('says so when a check-in was recorded without a mood', () => {
    expect(moodEvents([log({ recovery_log_mood_rating: null })])[0]!.detail).toBe(
      'Recorded without a mood rating',
    )
  })

  it('never makes one up: no record, no check-in', () => {
    expect(moodEvents([])).toEqual([])
  })
})

describe('a day’s events', () => {
  it('are the grid’s own, the check-in first, then by time, appointment before dose', () => {
    const events = [
      ...doseEvents(
        [
          dose({ medication_log_id: 'evening', medication_log_scheduled_at: '2026-11-07T12:00:00Z' }),
          dose({ medication_log_id: 'two', medication_log_scheduled_at: '2026-11-07T06:00:00Z' }),
        ],
        MANILA,
        0,
      ),
      ...appointmentEvents([appointment()], MANILA, { doctor: DR_CRUZ }),
      ...moodEvents([log({ recovery_log_date: '2026-11-07' }), log({ recovery_log_id: 'off-grid', recovery_log_date: '2027-03-01' })]),
    ]
    const byDay = eventsByDay(events, monthWeeks({ year: 2026, month: 11 }).flat())

    expect(byDay.get('2026-11-07')!.map((event) => `${event.kind} ${event.time ?? ''}`.trim())).toEqual([
      'mood',
      'appointment 14:00',
      'dose 14:00',
      'dose 20:00',
    ])
    expect([...byDay.keys()]).toEqual(['2026-11-07'])
  })

  it('are summed up in words, so nothing rests on colour', () => {
    const events = [
      ...doseEvents([dose(), dose({ medication_log_id: 'b' })], MANILA, 0),
      ...appointmentEvents([appointment()], MANILA, { doctor: null }),
    ]
    expect(daySummary(events)).toBe('2 medicine doses, 1 appointment')
    expect(daySummary(moodEvents([log()]))).toBe('1 mood check-in')
    expect(daySummary([])).toBe('Nothing recorded')
  })
})
