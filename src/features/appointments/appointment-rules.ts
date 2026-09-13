import type { AppointmentStatus } from './api'

/**
 * Whether an appointment is still going to happen.
 *
 * 'scheduled' and 'confirmed' are open. 'cancelled', 'completed' and
 * 'no_show' settle an appointment, and the database keeps them settled
 * (migrations 17 and 21), so no screen offers an action on one.
 */
export function isActiveAppointment(status: AppointmentStatus): boolean {
  return status === 'scheduled' || status === 'confirmed'
}

const CLOSED_PHRASE = {
  cancelled: 'was cancelled',
  completed: 'has been completed',
  no_show: 'was marked as a no-show',
} as const

/**
 * How a closed appointment is described in a sentence — "This appointment
 * {phrase}, so …" — or null while it is still open (NA-03).
 */
export function closedAppointmentPhrase(status: AppointmentStatus): string | null {
  if (status === 'scheduled' || status === 'confirmed') return null
  return CLOSED_PHRASE[status]
}

/**
 * Why a chosen time cannot be booked or proposed, or null when it can (NA-05).
 *
 * The picker's `min` only shapes its calendar; a time typed into the field is
 * not held to it, so the check is made here, before anything is sent. `value`
 * is a `datetime-local` value: wall-clock time in the browser's zone. A time
 * must be after now, so the minute already under way is refused too. The
 * wording is the clinician's scheduling dialog's.
 */
export function appointmentTimeError(value: string, now: number = Date.now()): string | null {
  if (!value) return 'Choose a date and time.'
  const when = new Date(value).getTime()
  if (Number.isNaN(when)) return 'That date and time could not be read.'
  if (when <= now) return 'Choose a time in the future.'
  return null
}
