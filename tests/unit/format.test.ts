import { describe, expect, it } from 'vitest'

import {
  calculateAge,
  formatDate,
  formatDateRelative,
  formatDateTime,
  formatRelative,
  formatScheduleTime,
  formatTime,
  toDateKey,
} from '@/lib/format'

/**
 * These formatters are called during render on nearly every screen.
 *
 * date-fns `format()` throws RangeError on an invalid date, so before this
 * was hardened a single missing timestamp propagated to the error boundary
 * and blanked the entire route. A clinician losing a whole patient record
 * because one value was null is a much worse outcome than a dash where a
 * time should be.
 *
 * The browser suite found it: a row arrived without its server-assigned
 * timestamp and took the page down.
 */
describe('resilience to bad input', () => {
  const formatters = {
    formatDate,
    formatDateRelative,
    formatTime,
    formatDateTime,
    formatRelative,
  }

  const badValues = [null, undefined, '', 'not-a-date', '2026-13-45'] as const

  for (const [name, formatter] of Object.entries(formatters)) {
    it(`${name} degrades to a dash instead of throwing`, () => {
      for (const value of badValues) {
        expect(() => formatter(value)).not.toThrow()
        expect(formatter(value)).toBe('—')
      }
    })
  }

  it('formatScheduleTime handles a missing time', () => {
    expect(formatScheduleTime(null)).toBe('—')
    expect(formatScheduleTime(undefined)).toBe('—')
    expect(formatScheduleTime('08:00:00')).toBe('08:00')
  })

  it('calculateAge returns null rather than NaN for bad input', () => {
    expect(calculateAge(null)).toBeNull()
    expect(calculateAge(undefined)).toBeNull()
    expect(calculateAge('not-a-date')).toBeNull()
  })
})

describe('formatting', () => {
  it('renders dates in an unambiguous long form', () => {
    // Never 03/04/2026, which reads as two different days depending on the
    // reader's country — a real hazard on a dose or an appointment.
    const result = formatDate('2020-03-04T00:00:00Z')
    expect(result).toMatch(/March/)
    expect(result).toMatch(/2020/)
    expect(result).not.toMatch(/\d{2}\/\d{2}/)
  })

  it('uses 24-hour time, which cannot be misread', () => {
    expect(formatTime('2026-03-04T14:30:00Z')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('says Today rather than a date when it applies', () => {
    expect(formatDateRelative(new Date())).toBe('Today')
  })

  it('says Tomorrow and Yesterday', () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(formatDateRelative(tomorrow)).toBe('Tomorrow')

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    expect(formatDateRelative(yesterday)).toBe('Yesterday')
  })

  it('builds a date key from local parts, not UTC', () => {
    // A patient in UTC+8 at 07:00 is still on the previous UTC day; an ISO
    // key would write the log against the wrong date.
    const early = new Date(2026, 8, 2, 7, 0, 0)
    expect(toDateKey(early)).toBe('2026-09-02')
  })

  it('computes age without counting an unreached birthday', () => {
    const today = new Date()
    const birthday = new Date(today)
    birthday.setFullYear(today.getFullYear() - 30)
    birthday.setDate(birthday.getDate() + 1)

    expect(calculateAge(birthday.toISOString().slice(0, 10))).toBe(29)
  })
})
