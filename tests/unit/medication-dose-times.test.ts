import { afterEach, describe, expect, it } from 'vitest'

import {
  calculateDoseTimes,
  MAX_DOSES_PER_DAY,
  MAX_HOURS_BETWEEN_DOSES,
  needsInterval,
} from '@/features/medications/dose-times'
import { formatScheduleTime } from '@/lib/format'

/**
 * Group QA 9/12/26, item 4: "Add frequency (kapila mo inom). Add interval.
 * Automatic calculation. Sample 3x a day nya every 4hrs then start 8 .. so mo
 * note nga mo inom 8am 12pm 4pm".
 *
 * The clinician gives doses a day, hours between them and the first dose; the
 * day's dose times are worked out, and those times are what is stored.
 */

const work = (frequency: string, intervalHours: string, startTime: string) =>
  calculateDoseTimes({ frequency, intervalHours, startTime })

describe('working out a day of dose times', () => {
  it('3 a day, every 4 hours, from 08:00 is 08:00, 12:00 and 16:00', () => {
    const result = work('3', '4', '08:00')

    expect(result).toEqual({ ok: true, times: ['08:00', '12:00', '16:00'] })
    // Three doses, not a fourth at 20:00.
    expect(result.ok && result.times).not.toContain('20:00')
  })

  it('1 a day is the first dose alone, and needs no interval', () => {
    expect(work('1', '', '08:00')).toEqual({ ok: true, times: ['08:00'] })
    expect(work('1', '99', '21:30')).toEqual({ ok: true, times: ['21:30'] })
    expect(needsInterval('1')).toBe(false)
  })

  it('asks for an interval whenever there is, or may be, more than one dose', () => {
    expect(needsInterval('2')).toBe(true)
    expect(needsInterval('12')).toBe(true)
    // Blank or not yet a number: keep the field available.
    expect(needsInterval('')).toBe(true)
    expect(needsInterval('abc')).toBe(true)
  })

  it('2 a day, every 12 hours, from 08:00 is 08:00 and 20:00', () => {
    expect(work('2', '12', '08:00')).toEqual({ ok: true, times: ['08:00', '20:00'] })
  })

  it('4 a day, every 6 hours, from midnight is 00:00, 06:00, 12:00 and 18:00', () => {
    expect(work('4', '6', '00:00')).toEqual({
      ok: true,
      times: ['00:00', '06:00', '12:00', '18:00'],
    })
  })

  it('follows a different first dose', () => {
    expect(work('3', '4', '06:00')).toEqual({ ok: true, times: ['06:00', '10:00', '14:00'] })
    expect(work('4', '5', '05:00')).toEqual({
      ok: true,
      times: ['05:00', '10:00', '15:00', '20:00'],
    })
  })

  it('keeps the minutes of the first dose', () => {
    expect(work('3', '4', '08:30')).toEqual({ ok: true, times: ['08:30', '12:30', '16:30'] })
    expect(work('2', '5', '06:45')).toEqual({ ok: true, times: ['06:45', '11:45'] })
  })

  it('reads a time that carries seconds, as the database returns it', () => {
    expect(work('3', '4', '08:00:00')).toEqual({ ok: true, times: ['08:00', '12:00', '16:00'] })
  })
})

describe('midnight', () => {
  it('allows a last dose just before midnight', () => {
    expect(work('2', '1', '22:59')).toEqual({ ok: true, times: ['22:59', '23:59'] })
    expect(work(String(MAX_DOSES_PER_DAY), '2', '00:00')).toEqual({
      ok: true,
      times: [
        '00:00', '02:00', '04:00', '06:00', '08:00', '10:00',
        '12:00', '14:00', '16:00', '18:00', '20:00', '22:00',
      ],
    })
  })

  it('refuses a last dose at midnight: 4 a day every 6 hours from 06:00', () => {
    const result = work('4', '6', '06:00')

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ field: 'startTime' })
    expect(!result.ok && result.message).toMatch(/would run past midnight/)
  })

  it('refuses rather than wrapping into the next day or dropping doses', () => {
    // 20:00, 04:00, 12:00 wrapped, or 20:00 alone truncated, would each be a
    // schedule other than the one set.
    const result = work('3', '8', '20:00')

    expect(result).toEqual({
      ok: false,
      field: 'startTime',
      message:
        '3 doses 8 hours apart from 20:00 would run past midnight. ' +
        'Choose an earlier first dose, fewer doses or fewer hours between them.',
    })
  })

  it('refuses a single hour past the limit with the singular', () => {
    expect(work('3', '1', '23:00')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^3 doses 1 hour apart from 23:00/),
    })
  })
})

describe('what is refused', () => {
  it.each(['', '0', '13', '2.5', '-1', 'three', ' '])(
    'doses a day of %j',
    (frequency) => {
      expect(work(frequency, '4', '08:00')).toMatchObject({ ok: false, field: 'frequency' })
    },
  )

  it.each(['', '0', String(MAX_HOURS_BETWEEN_DOSES + 1), '1.5', 'four', '-4'])(
    'hours between doses of %j when there are several doses',
    (interval) => {
      expect(work('3', interval, '08:00')).toMatchObject({ ok: false, field: 'interval' })
    },
  )

  it.each(['', '24:00', '8am', '08:60', '8:00'])('a first dose of %j', (start) => {
    expect(work('3', '4', start)).toMatchObject({ ok: false, field: 'startTime' })
  })

  it('says what is missing in words a clinician can act on', () => {
    expect(work('', '4', '08:00')).toMatchObject({ message: 'Say how many doses a day.' })
    expect(work('3', '', '08:00')).toMatchObject({
      message: 'Say how many hours apart the doses are.',
    })
    expect(work('3', '4', '')).toMatchObject({ message: 'Choose the time of the first dose.' })
  })
})

describe('every regimen it accepts', () => {
  it('has as many different times as doses, in order, the interval apart, before midnight', () => {
    let accepted = 0

    for (let frequency = 1; frequency <= MAX_DOSES_PER_DAY; frequency += 1) {
      for (let interval = 1; interval <= MAX_HOURS_BETWEEN_DOSES; interval += 1) {
        for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
          const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
          const result = work(String(frequency), String(interval), start)
          if (!result.ok) continue
          accepted += 1

          const asMinutes = result.times.map((time) => {
            const [hours, mins] = time.split(':').map(Number)
            return hours! * 60 + mins!
          })
          expect(result.times).toHaveLength(frequency)
          expect(new Set(result.times).size).toBe(frequency)
          expect(asMinutes[0]).toBe(minutes)
          for (let dose = 1; dose < asMinutes.length; dose += 1) {
            expect(asMinutes[dose]! - asMinutes[dose - 1]!).toBe(interval * 60)
          }
          expect(asMinutes.at(-1)!).toBeLessThan(24 * 60)
        }
      }
    }

    expect(accepted).toBeGreaterThan(0)
  })
})

describe('time zones and existing schedules', () => {
  const originalZone = process.env.TZ

  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ
    else process.env.TZ = originalZone
  })

  it('does not depend on the time zone of the device doing the working out', () => {
    const results = ['Asia/Manila', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC'].map(
      (zone) => {
        process.env.TZ = zone
        return work('3', '4', '08:00')
      },
    )

    for (const result of results) {
      expect(result).toEqual({ ok: true, times: ['08:00', '12:00', '16:00'] })
    }
  })

  it('produces the same shape as a schedule saved before this change', () => {
    // An existing row, as the database returns it: frequency 2 at 08:00 and
    // 20:00. Every reader shows it through formatScheduleTime.
    const existing = { frequency: 2, times: ['08:00:00', '20:00:00'] }
    const worked = work('2', '12', '08:00')

    expect(worked.ok && worked.times).toEqual(existing.times.map(formatScheduleTime))
    expect(worked.ok && worked.times.length).toBe(existing.frequency)
  })
})
