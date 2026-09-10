import { format, isValid, parseISO } from 'date-fns'

/**
 * Dates on a printed report always carry the year.
 *
 * Elsewhere the app drops it within the current year ("12 March"), which is
 * right for a screen someone reads today and wrong for paper that is filed
 * and read next year. Like `src/lib/format.ts`, a missing or unparseable
 * value degrades to a dash rather than throwing during render.
 */

const UNKNOWN = '—'

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = parseISO(value)
  return isValid(date) ? date : null
}

/** e.g. "12 Mar 2026". */
export function reportDate(value: string | null | undefined): string {
  const date = toDate(value)
  return date ? format(date, 'd MMM yyyy') : UNKNOWN
}

/** 24-hour time, as the rest of the app shows dose and appointment times. */
export function reportTime(value: string | null | undefined): string {
  const date = toDate(value)
  return date ? format(date, 'HH:mm') : UNKNOWN
}

/** e.g. "12 Mar 2026, 14:30". */
export function reportDateTime(value: string | null | undefined): string {
  const date = toDate(value)
  return date ? format(date, 'd MMM yyyy, HH:mm') : UNKNOWN
}
