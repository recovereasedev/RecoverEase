/**
 * A day's dose times, worked out from how many doses, how far apart and when
 * the first one is (group QA 9/12/26, item 4: "3x a day nya every 4hrs then
 * start 8 .. so mo note nga mo inom 8am 12pm 4pm").
 *
 * The result is what is stored: `medication_schedule_times`, which dose
 * generation, the reminders, the patient's checklist, reports and printing
 * already read. Frequency and interval are only how the clinician arrives at
 * those times. Nothing else is saved, so there is one source of truth and no
 * stored interval that could disagree with the times.
 *
 * The rules:
 *
 *   - Doses a day: a whole number from 1 to 12, the range the database allows.
 *   - Hours between doses: a whole number from 1 to 23. Only asked for when
 *     there is more than one dose.
 *   - First dose: a time of day. Every dose keeps its minutes, so 08:30 every
 *     4 hours is 08:30, 12:30, 16:30.
 *   - Every dose falls on the same day, before midnight. The stored times are
 *     a daily set that dose generation repeats on each day of the course, so a
 *     dose "the next morning" would be scheduled on the first day before the
 *     first dose, and never after the last day. A regimen that would cross
 *     midnight is refused with the reason, never wrapped or cut short.
 *   - Clock arithmetic only. These are the clinic's times of day, as typed
 *     times always were; no Date is involved, so the browser's time zone
 *     cannot move them.
 *
 * Inputs are the raw field values, so the one function both drives the live
 * preview and validates the form on submit.
 */

/** The `medication_schedule_frequency_sane` check allows 1 to 12. */
export const MAX_DOSES_PER_DAY = 12
export const MAX_HOURS_BETWEEN_DOSES = 23

const MINUTES_PER_DAY = 24 * 60
const WHOLE_NUMBER = /^\d+$/
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/

export type DoseTimeField = 'frequency' | 'interval' | 'startTime'

export type DoseTimes =
  | { ok: true; times: string[] }
  | { ok: false; field: DoseTimeField; message: string }

export type DoseTimeInput = {
  /** Doses a day, as typed. */
  frequency: string
  /** Hours between doses, as typed. Ignored for a single daily dose. */
  intervalHours: string
  /** The first dose, `HH:MM`. */
  startTime: string
}

function wholeNumber(value: string): number | null {
  const text = value.trim()
  return WHOLE_NUMBER.test(text) ? Number(text) : null
}

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

const fail = (field: DoseTimeField, message: string): DoseTimes => ({
  ok: false,
  field,
  message,
})

/** Whether the interval matters: anything but exactly one dose a day. */
export function needsInterval(frequency: string): boolean {
  return wholeNumber(frequency) !== 1
}

export function calculateDoseTimes(input: DoseTimeInput): DoseTimes {
  if (input.frequency.trim() === '') {
    return fail('frequency', 'Say how many doses a day.')
  }
  const frequency = wholeNumber(input.frequency)
  if (frequency === null || frequency < 1 || frequency > MAX_DOSES_PER_DAY) {
    return fail(
      'frequency',
      `Doses a day must be a whole number from 1 to ${MAX_DOSES_PER_DAY}.`,
    )
  }

  let interval = 0
  if (frequency > 1) {
    if (input.intervalHours.trim() === '') {
      return fail('interval', 'Say how many hours apart the doses are.')
    }
    const hours = wholeNumber(input.intervalHours)
    if (hours === null || hours < 1 || hours > MAX_HOURS_BETWEEN_DOSES) {
      return fail(
        'interval',
        `Hours between doses must be a whole number from 1 to ${MAX_HOURS_BETWEEN_DOSES}.`,
      )
    }
    interval = hours
  }

  const match = TIME_OF_DAY.exec(input.startTime.trim())
  if (!match) {
    return fail('startTime', 'Choose the time of the first dose.')
  }
  const first = Number(match[1]) * 60 + Number(match[2])

  const last = first + (frequency - 1) * interval * 60
  if (last >= MINUTES_PER_DAY) {
    return fail(
      'startTime',
      `${frequency} doses ${interval} ${interval === 1 ? 'hour' : 'hours'} apart from ${clock(first)} would run past midnight. ` +
        'Choose an earlier first dose, fewer doses or fewer hours between them.',
    )
  }

  const times = Array.from({ length: frequency }, (_, dose) =>
    clock(first + dose * interval * 60),
  )

  // Unreachable while the rules above hold. Kept so that a change to them can
  // never quietly save fewer doses than the clinician set: the slot index
  // would fold two equal times into one dose.
  if (new Set(times).size !== times.length) {
    return fail('startTime', 'Each dose needs a different time.')
  }

  return { ok: true, times }
}
