import { describe, expect, it } from 'vitest'

import {
  appointmentTimeError,
  closedAppointmentPhrase,
  isActiveAppointment,
} from '@/features/appointments/appointment-rules'

/**
 * The rules the appointment screens share: which appointments are still
 * going to happen, how a closed one is described, and which times can be
 * booked or proposed (NA-03, NA-05).
 */

function localValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe('which appointments are still going to happen', () => {
  it.each([
    ['scheduled', true],
    ['confirmed', true],
    ['completed', false],
    ['cancelled', false],
    ['no_show', false],
  ] as const)('%s → %s', (status, active) => {
    expect(isActiveAppointment(status)).toBe(active)
  })

  it.each([
    ['cancelled', 'was cancelled'],
    ['completed', 'has been completed'],
    ['no_show', 'was marked as a no-show'],
  ] as const)('describes a %s appointment as one that %s', (status, phrase) => {
    expect(closedAppointmentPhrase(status)).toBe(phrase)
  })

  it.each(['scheduled', 'confirmed'] as const)('does not describe a %s appointment as closed', (status) => {
    expect(closedAppointmentPhrase(status)).toBeNull()
  })
})

describe('which times can be booked or proposed (NA-05)', () => {
  // A fixed "now" on a minute boundary, so the boundary is exact.
  const now = new Date(2030, 0, 15, 10, 0, 0, 0)
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000)

  it('asks for a time when none was given', () => {
    expect(appointmentTimeError('', now.getTime())).toBe('Choose a date and time.')
  })

  it('refuses a value that is not a time', () => {
    expect(appointmentTimeError('not a time', now.getTime())).toBe(
      'That date and time could not be read.',
    )
  })

  it.each([
    ['a date long past', '2024-01-15T09:00'],
    ['earlier the same day', localValue(minutes(-120))],
    ['the minute before', localValue(minutes(-1))],
    ['this very minute', localValue(now)],
  ])('refuses %s', (_label, value) => {
    expect(appointmentTimeError(value, now.getTime())).toBe('Choose a time in the future.')
  })

  it.each([
    ['the next minute', localValue(minutes(1))],
    ['next week', localValue(minutes(7 * 24 * 60))],
  ])('accepts %s', (_label, value) => {
    expect(appointmentTimeError(value, now.getTime())).toBeNull()
  })

  it('judges against the real clock when no time is given', () => {
    expect(appointmentTimeError('2024-01-15T09:00')).toBe('Choose a time in the future.')
    expect(appointmentTimeError(localValue(new Date(Date.now() + 86_400_000)))).toBeNull()
  })
})
