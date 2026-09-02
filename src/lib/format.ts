import {
  format,
  formatDistanceToNowStrict,
  isThisYear,
  isToday,
  isTomorrow,
  isValid,
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

/** Shown in place of a date that cannot be rendered. */
const UNKNOWN_DATE = '—'

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = typeof value === 'string' ? parseISO(value) : value
  return isValid(date) ? date : null
}

/**
 * Every formatter below tolerates a missing or unparseable value.
 *
 * date-fns `format()` throws RangeError on an invalid date, and because these
 * are called during render that exception propagates to the error boundary
 * and blanks the whole screen. A clinician losing an entire patient record
 * because one timestamp was null is a far worse outcome than a dash where a
 * time should be — so a bad value degrades to `—` and the rest of the page
 * still renders.
 *
 * This was found by the browser suite, where a row arrived without its
 * server-assigned timestamp and took down the route.
 */
function formatOr(
  value: string | Date | null | undefined,
  formatter: (date: Date) => string,
): string {
  const date = toDate(value)
  return date === null ? UNKNOWN_DATE : formatter(date)
}

/** e.g. "12 March 2026", or "12 March" within the current year. */
export function formatDate(value: string | Date | null | undefined): string {
  return formatOr(value, (date) =>
    format(date, isThisYear(date) ? 'd MMMM' : 'd MMMM yyyy'),
  )
}

/** e.g. "Today", "Tomorrow", "Yesterday", otherwise "Thu 12 March". */
export function formatDateRelative(
  value: string | Date | null | undefined,
): string {
  return formatOr(value, (date) => {
    if (isToday(date)) return 'Today'
    if (isTomorrow(date)) return 'Tomorrow'
    if (isYesterday(date)) return 'Yesterday'
    return format(date, isThisYear(date) ? 'EEE d MMMM' : 'EEE d MMM yyyy')
  })
}

/** 24-hour time: unambiguous for dose schedules. */
export function formatTime(value: string | Date | null | undefined): string {
  return formatOr(value, (date) => format(date, 'HH:mm'))
}

/** e.g. "Tomorrow at 14:30". */
export function formatDateTime(
  value: string | Date | null | undefined,
): string {
  if (toDate(value) === null) return UNKNOWN_DATE
  return `${formatDateRelative(value)} at ${formatTime(value)}`
}

/** e.g. "3 days ago". Used where recency matters more than the exact date. */
export function formatRelative(
  value: string | Date | null | undefined,
): string {
  return formatOr(value, (date) =>
    formatDistanceToNowStrict(date, { addSuffix: true }),
  )
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
export function formatScheduleTime(value: string | null | undefined): string {
  return value ? value.slice(0, 5) : UNKNOWN_DATE
}

/**
 * Whole years, for a date of birth. Null when unknown or unparseable.
 *
 * `today` is injectable so the boundary — the day before a birthday versus
 * the day of it — can be tested deterministically instead of depending on
 * when the suite happens to run.
 */
export function calculateAge(
  birthDate: string | null | undefined,
  today: Date = new Date(),
): number | null {
  const birth = toDate(birthDate)
  if (birth === null) return null

  let age = today.getFullYear() - birth.getFullYear()
  const monthDelta = today.getMonth() - birth.getMonth()

  // Not yet had this year's birthday.
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) {
    age -= 1
  }

  return age
}
