import {
  format,
  formatDistanceToNowStrict,
  isThisYear,
  isToday,
  isTomorrow,
  isYesterday,
  parseISO,
} from 'date-fns'

/**
 * Date and time formatting, in one place.
 *
 * Two conventions run through all of it. Dates are never rendered
 * numerically as 03/04/2026, which reads as two different days depending on
 * the reader's country — a genuine hazard on an appointment or a dose. And
 * "Today" or "Tomorrow" is used wherever it applies, because that is how
 * someone actually thinks about their medication.
 */

function toDate(value: string | Date): Date {
  return typeof value === 'string' ? parseISO(value) : value
}

/** e.g. "12 March 2026", or "12 March" within the current year. */
export function formatDate(value: string | Date): string {
  const date = toDate(value)
  return format(date, isThisYear(date) ? 'd MMMM' : 'd MMMM yyyy')
}

/** e.g. "Today", "Tomorrow", "Yesterday", otherwise "Thu 12 March". */
export function formatDateRelative(value: string | Date): string {
  const date = toDate(value)
  if (isToday(date)) return 'Today'
  if (isTomorrow(date)) return 'Tomorrow'
  if (isYesterday(date)) return 'Yesterday'
  return format(date, isThisYear(date) ? 'EEE d MMMM' : 'EEE d MMM yyyy')
}

/** 24-hour time: unambiguous for dose schedules. */
export function formatTime(value: string | Date): string {
  return format(toDate(value), 'HH:mm')
}

/** e.g. "Tomorrow at 14:30". */
export function formatDateTime(value: string | Date): string {
  return `${formatDateRelative(value)} at ${formatTime(value)}`
}

/** e.g. "3 days ago". Used where recency matters more than the exact date. */
export function formatRelative(value: string | Date): string {
  return formatDistanceToNowStrict(toDate(value), { addSuffix: true })
}

/** The `YYYY-MM-DD` key a PostgreSQL `date` column expects, in local time. */
export function toDateKey(value: Date = new Date()): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * A PostgreSQL `time` value ("08:00:00") shown as "08:00".
 * Times come back with seconds that carry no information for a dose.
 */
export function formatScheduleTime(value: string): string {
  return value.slice(0, 5)
}

/** Whole years, for a date of birth. Null when unknown. */
export function calculateAge(birthDate: string | null): number | null {
  if (!birthDate) return null

  const birth = parseISO(birthDate)
  const today = new Date()

  let age = today.getFullYear() - birth.getFullYear()
  const monthDelta = today.getMonth() - birth.getMonth()

  // Not yet had this year's birthday.
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) {
    age -= 1
  }

  return age
}
