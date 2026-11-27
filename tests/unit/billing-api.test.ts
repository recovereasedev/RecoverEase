import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clinic Admin's billing read (fetchClinicBilling): which columns it asks
 * for, and how each payment's PayMongo mode (migration 69,
 * `payment_livemode`) reaches the page.
 */

const client = vi.hoisted(() => {
  const state = {
    selects: {} as Record<string, string>,
    payments: [] as Record<string, unknown>[],
  }
  const result = (table: string) => {
    if (table === 'subscription_plan') return { data: [], error: null }
    if (table === 'clinic_subscription') return { data: null, error: null }
    return { data: state.payments, error: null }
  }
  // Every builder step returns the builder; awaiting it gives the table's rows.
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const step of ['order', 'limit', 'eq']) b[step] = () => b
    b['maybeSingle'] = async () => result(table)
    b['then'] = (resolve: (value: unknown) => unknown) => resolve(result(table))
    return b
  }
  const supabase = {
    from: vi.fn((table: string) => ({
      select: (columns: string) => {
        state.selects[table] = columns
        return builder(table)
      },
    })),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

import { fetchClinicBilling } from '@/features/billing/api'

const row = (over: Record<string, unknown>) => ({
  payment_id: 'p',
  plan_name_snapshot: 'Basic',
  payment_amount_centavos: 99900,
  payment_status: 'paid',
  payment_created_at: '2026-11-27T00:00:00Z',
  payment_paid_at: '2026-11-27T00:00:00Z',
  ...over,
})

describe('fetchClinicBilling', () => {
  beforeEach(() => {
    client.state.selects = {}
    client.state.payments = []
  })

  it('asks for each payment’s PayMongo mode', async () => {
    await fetchClinicBilling()
    expect(client.state.selects['subscription_payment']!.split(',').map((c) => c.trim())).toContain('payment_livemode')
  })

  it('maps payment_livemode to livemode: false is sandbox, true is live', async () => {
    client.state.payments = [
      row({ payment_id: 'sandbox', payment_livemode: false }),
      row({ payment_id: 'live', payment_livemode: true }),
    ]
    const { payments } = await fetchClinicBilling()
    expect(payments.map((p) => [p.paymentId, p.livemode])).toEqual([
      ['sandbox', false],
      ['live', true],
    ])
  })

  it('treats a missing value as sandbox, never as live', async () => {
    client.state.payments = [row({ payment_id: 'unknown' })]
    const { payments } = await fetchClinicBilling()
    expect(payments[0]!.livemode).toBe(false)
  })
})
