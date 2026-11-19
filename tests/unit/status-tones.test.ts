import { describe, expect, it } from 'vitest'

import {
  appointmentStatus,
  doctorAccountStatus,
  medicationLogStatus,
  patientDoseStatus,
  patientStatus,
  rescheduleRequestStatus,
  treatmentGoalStatus,
  treatmentPlanStatus,
  type StatusDescriptor,
} from '@/lib/status'

/**
 * Phase 2B: red means an emergency. None of the shared statuses is one -
 * they are records of what happened - so none of them is red. Amber asks
 * for attention, neutral states a fact, teal says it went well.
 */
const ALL: Record<string, Record<string, StatusDescriptor>> = {
  appointmentStatus,
  rescheduleRequestStatus,
  treatmentPlanStatus,
  treatmentGoalStatus,
  medicationLogStatus,
  patientDoseStatus,
  patientStatus,
  doctorAccountStatus,
}

describe('the shared statuses', () => {
  it('are never red', () => {
    const red = Object.entries(ALL).flatMap(([set, statuses]) =>
      Object.entries(statuses)
        .filter(([, status]) => status.tone === 'danger')
        .map(([key]) => `${set}.${key}`),
    )
    expect(red).toEqual([])
  })

  it('state a cancellation, a declined request and a deactivated account as facts', () => {
    expect(appointmentStatus.cancelled.tone).toBe('neutral')
    expect(rescheduleRequestStatus.declined.tone).toBe('neutral')
    expect(doctorAccountStatus.inactive.tone).toBe('neutral')
  })

  it('ask for attention on a missed dose, and keep it apart from an overdue one', () => {
    expect(patientDoseStatus.missed.tone).toBe('warning')
    expect(patientDoseStatus.missed.label).not.toBe(patientDoseStatus.overdue.label)
    expect(patientDoseStatus.missed.icon).not.toBe(patientDoseStatus.overdue.icon)
  })
})
