import { format } from 'date-fns'

import type { AppointmentWithPatient } from '@/features/appointments/api'
import type { DoseWithSchedule } from '@/features/medications/api'
import { patientDoseState } from '@/features/medications/dose-status'
import { prescriberName, type PrescriberDetails } from '@/features/medications/prescriber'
import type { RecoveryLog } from '@/features/recovery-logs/api'
import { MOOD_OPTIONS } from '@/features/recovery-logs/components/mood-scale'
import { appointmentStatus, patientDoseStatus, type StatusDescriptor } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * Module 6.2 "View Appointment Calendar" - the patient's medicines,
 * appointments and mood check-ins, by day - as plain data, so the screen
 * draws it and the tests can pin it without a browser.
 *
 * Every event is a record the database holds:
 *
 * - **dose** - a dose slot from `medication_log`. Its time is when it is
 *   due; what was recorded against it - taken at a time, missed, skipped -
 *   is said beside it, so a dose that is only scheduled never reads as one
 *   that was taken. Slots exist only as far ahead as the scheduled job has
 *   made them, so nothing is projected past them.
 * - **appointment** - an appointment, with its status in words.
 * - **mood** - a check-in the patient recorded (`recovery_log`). Only those:
 *   no check-in is ever shown for a day the patient did not record one.
 *
 * Days and times are the clinic's (`clinic.clinic_timezone`), the zone its
 * schedules and reminders are kept in.
 */

export type CalendarEventKind = 'dose' | 'appointment' | 'mood'

export type CalendarEvent = {
  id: string
  kind: CalendarEventKind
  /** `YYYY-MM-DD`, in the clinic's zone. */
  day: string
  /** `HH:mm` in the clinic's zone, or null for a check-in, which has a day but no time. */
  time: string | null
  title: string
  /** What was recorded, or who it is with, where there is something to say. */
  detail: string | null
  status: StatusDescriptor | null
  /** For a doctor's appointment: whose it is, so the day can link to their record. */
  patientId?: string
}

/** The zone this device is set to, for when the clinic's cannot be read. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const zonedFormats = new Map<string, Intl.DateTimeFormat>()

function zonedFormat(zone: string): Intl.DateTimeFormat {
  let formatter = zonedFormats.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    zonedFormats.set(zone, formatter)
  }
  return formatter
}

/** The day (`YYYY-MM-DD`) and time (`HH:mm`) an instant falls on in `zone`. Null when unreadable. */
export function zonedDayAndTime(value: string | Date, zone: string): { day: string; time: string } | null {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(
    zonedFormat(zone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

/** Today's day key in `zone`. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return zonedDayAndTime(now, zone)!.day
}

/** A day key moved by whole days (calendar arithmetic, in UTC, so no daylight saving shifts it). */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10)
}

/** Sunday = 0 ... Saturday = 6. */
export function weekday(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay()
}

export type MonthKey = { year: number; month: number } // month: 1-12

export function monthOf(day: string): MonthKey {
  const [year, month] = day.split('-').map(Number) as [number, number]
  return { year, month }
}

export function shiftMonth({ year, month }: MonthKey, by: number): MonthKey {
  const index = year * 12 + (month - 1) + by
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

export function firstOfMonth({ year, month }: MonthKey): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/**
 * The month's weeks, Sunday first, as day keys: from the Sunday on or before
 * the 1st to the Saturday on or after the last day. Four to six weeks.
 */
export function monthWeeks(month: MonthKey): string[][] {
  const first = firstOfMonth(month)
  const last = addDays(firstOfMonth(shiftMonth(month, 1)), -1)
  let day = addDays(first, -weekday(first))
  const end = addDays(last, 6 - weekday(last))
  const weeks: string[][] = []
  while (day <= end) {
    const week: string[] = []
    for (let i = 0; i < 7; i += 1) {
      week.push(day)
      day = addDays(day, 1)
    }
    weeks.push(week)
  }
  return weeks
}

/**
 * The window to read for a month's grid, as instants: a day either side of
 * its first and last cells, so every event that falls on one of them in the
 * clinic's zone is read whatever the zone's offset. Events outside the grid
 * are dropped when the days are grouped.
 */
export function monthWindow(month: MonthKey): { from: string; to: string; fromDay: string; toDay: string } {
  const weeks = monthWeeks(month)
  const fromDay = weeks[0]![0]!
  const toDay = weeks[weeks.length - 1]![6]!
  return {
    from: `${addDays(fromDay, -1)}T00:00:00.000Z`,
    to: `${addDays(toDay, 2)}T00:00:00.000Z`,
    fromDay,
    toDay,
  }
}

const RECORDED: Partial<Record<string, (dose: DoseWithSchedule, zone: string) => string>> = {
  taken: (dose, zone) => {
    const at = dose.medication_log_taken_at
      ? zonedDayAndTime(dose.medication_log_taken_at, zone)
      : null
    return at ? `Taken at ${at.time}` : 'Taken'
  },
  missed: () => 'Not taken',
  skipped: () => 'Skipped',
  overdue: () => 'Not recorded yet',
  due: () => 'Scheduled',
}

/** A dose slot: when it is due, and what was recorded against it. */
export function doseEvents(doses: readonly DoseWithSchedule[], zone: string, now: number): CalendarEvent[] {
  return doses.flatMap((dose) => {
    const due = zonedDayAndTime(dose.medication_log_scheduled_at, zone)
    if (!due) return []
    const state = patientDoseState(dose, now)
    const schedule = dose.medication_schedule
    const title = schedule
      ? `${schedule.medication_schedule_name}, ${schedule.medication_schedule_dosage}`
      : 'Medicine'
    return [
      {
        id: `dose-${dose.medication_log_id}`,
        kind: 'dose' as const,
        day: due.day,
        time: due.time,
        title,
        detail: RECORDED[state]?.(dose, zone) ?? null,
        status: patientDoseStatus[state],
      },
    ]
  })
}

/**
 * Appointments. For a patient, "with" their doctor where the appointment is
 * that doctor's - the only doctor a patient may read; for a doctor, "with"
 * the patient.
 */
export function appointmentEvents(
  appointments: readonly AppointmentWithPatient[],
  zone: string,
  withWhom: { doctor: PrescriberDetails | null | undefined } | 'patient',
): CalendarEvent[] {
  return appointments.flatMap((appointment) => {
    const at = zonedDayAndTime(appointment.appointment_date, zone)
    if (!at) return []
    let detail: string | null = null
    if (withWhom === 'patient') {
      detail = appointment.patient
        ? `With ${fullName(appointment.patient.pat_first_name, appointment.patient.pat_last_name)}`
        : null
    } else if (withWhom.doctor && withWhom.doctor.doc_id === appointment.doc_id) {
      detail = `With ${prescriberName(withWhom.doctor)}`
    }
    return [
      {
        id: `appointment-${appointment.appointment_id}`,
        kind: 'appointment' as const,
        day: at.day,
        time: at.time,
        title: 'Appointment',
        detail,
        status: appointmentStatus[appointment.appointment_status],
        ...(withWhom === 'patient' ? { patientId: appointment.pat_id } : {}),
      },
    ]
  })
}

/** The check-ins the patient recorded, on the day they recorded them for. */
export function moodEvents(logs: readonly RecoveryLog[]): CalendarEvent[] {
  return logs.map((log) => {
    const rating = log.recovery_log_mood_rating
    const word = MOOD_OPTIONS.find((option) => option.value === rating)?.label
    return {
      id: `mood-${log.recovery_log_id}`,
      kind: 'mood' as const,
      day: log.recovery_log_date,
      time: null,
      title: 'Mood check-in',
      detail: word ? `${word} (${rating} of 5)` : 'Recorded without a mood rating',
      status: null,
    }
  })
}

const KIND_ORDER: Record<CalendarEventKind, number> = { mood: 0, appointment: 1, dose: 2 }

/**
 * The events on each day of `days`, each day's in order: the check-in (which
 * has no time) first, then by time, an appointment before a dose at the same
 * minute. Days with nothing are left out.
 */
export function eventsByDay(events: readonly CalendarEvent[], days: readonly string[]): Map<string, CalendarEvent[]> {
  const wanted = new Set(days)
  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    if (!wanted.has(event.day)) continue
    const list = byDay.get(event.day) ?? []
    list.push(event)
    byDay.set(event.day, list)
  }
  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        (a.time ?? '').localeCompare(b.time ?? '') ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.title.localeCompare(b.title),
    )
  }
  return byDay
}

// A day key's own date, at noon on this device: formatting it then names
// that date whatever the device's zone, and no daylight saving moves it.
function localNoon(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date, 12)
}

/** "Wednesday 4 November 2026", for a day key - in the app's own date style (`@/lib/format`). */
export function longDay(day: string): string {
  return format(localNoon(day), 'EEEE d MMMM yyyy')
}

/** "November 2026". */
export function monthTitle(month: MonthKey): string {
  return format(localNoon(firstOfMonth(month)), 'MMMM yyyy')
}

/** "3 medicine doses, 1 appointment, 1 mood check-in" - what a day holds, in words. */
export function daySummary(events: readonly CalendarEvent[]): string {
  const count = (kind: CalendarEventKind) => events.filter((event) => event.kind === kind).length
  const parts = [
    [count('dose'), 'medicine dose', 'medicine doses'],
    [count('appointment'), 'appointment', 'appointments'],
    [count('mood'), 'mood check-in', 'mood check-ins'],
  ] as const
  const said = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  return said.length > 0 ? said.join(', ') : 'Nothing recorded'
}
