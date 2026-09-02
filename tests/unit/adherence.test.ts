import { describe, expect, it } from 'vitest'

import { summariseAdherence } from '@/features/medications/api'
import type { MedicationLog } from '@/features/medications/api'

/**
 * Modules 4.8 (patient weekly adherence) and 5.3 (doctor adherence tracking).
 *
 * The rule that matters clinically: doses that have not yet come due are not
 * failures. A percentage that counts them would fall as a prescription gets
 * longer, telling a patient who has taken every dose that they are doing
 * badly, and telling their doctor the same thing.
 */
function dose(
  status: MedicationLog['medication_log_status'],
): MedicationLog {
  return {
    medication_log_id: crypto.randomUUID(),
    medication_schedule_id: 'schedule',
    medication_log_scheduled_at: '2026-09-02T08:00:00Z',
    medication_log_taken_at: status === 'taken' ? '2026-09-02T08:05:00Z' : null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
  }
}

describe('summariseAdherence', () => {
  it('reports no rate when there are no doses at all', () => {
    const result = summariseAdherence([])
    expect(result.rate).toBeNull()
    expect(result.resolved).toBe(0)
  })

  it('reports no rate when every dose is still upcoming', () => {
    // Four doses scheduled, none due yet. Returning 0% here would read as
    // total non-adherence from someone who has done nothing wrong.
    const result = summariseAdherence([
      dose('pending'),
      dose('pending'),
      dose('pending'),
      dose('pending'),
    ])
    expect(result.rate).toBeNull()
    expect(result.pending).toBe(4)
    expect(result.resolved).toBe(0)
  })

  it('excludes pending doses from the denominator', () => {
    // 3 taken, 1 missed, 6 still upcoming. The rate is 3/4, not 3/10.
    const result = summariseAdherence([
      dose('taken'),
      dose('taken'),
      dose('taken'),
      dose('missed'),
      ...Array.from({ length: 6 }, () => dose('pending')),
    ])
    expect(result.resolved).toBe(4)
    expect(result.rate).toBe(75)
  })

  it('counts a skipped dose against adherence', () => {
    // Skipped is a deliberate non-dose, but it is still a dose not taken, so
    // it belongs in the denominator.
    const result = summariseAdherence([dose('taken'), dose('skipped')])
    expect(result.resolved).toBe(2)
    expect(result.rate).toBe(50)
  })

  it('reports 100 percent when every due dose was taken', () => {
    const result = summariseAdherence([dose('taken'), dose('taken')])
    expect(result.rate).toBe(100)
  })

  it('reports zero percent when every due dose was missed', () => {
    // Distinct from the null case above: these came due and were not taken.
    const result = summariseAdherence([dose('missed'), dose('missed')])
    expect(result.rate).toBe(0)
  })

  it('rounds to a whole percentage', () => {
    const result = summariseAdherence([
      dose('taken'),
      dose('taken'),
      dose('missed'),
    ])
    expect(result.rate).toBe(67)
  })

  it('counts each status separately', () => {
    const result = summariseAdherence([
      dose('taken'),
      dose('missed'),
      dose('skipped'),
      dose('pending'),
    ])
    expect(result).toMatchObject({
      taken: 1,
      missed: 1,
      skipped: 1,
      pending: 1,
      resolved: 3,
    })
  })
})
