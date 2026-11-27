import { describe, expect, it } from 'vitest'

import {
  assertStagingRef,
  paidEvent,
  PRODUCTION_REF,
  signatureHeader,
} from '../../scripts/staging/paymongo-webhook-checks'
import { parseWebhookEvent, verifyWebhookSignature } from '../../supabase/functions/_shared/paymongo'

/**
 * The staging webhook checker (docs/paymongo-staging.md) must sign exactly
 * the way PayMongo does, so its results mean what they say, and must never
 * point at production.
 */

const SECRET = 'whsk_stagingunittest0001'

describe('the staging webhook checker', () => {
  it('refuses the production project and anything that is not a project ref', () => {
    expect(() => assertStagingRef(PRODUCTION_REF)).toThrow(/PRODUCTION/)
    expect(() => assertStagingRef(undefined)).toThrow()
    expect(() => assertStagingRef('https://abc.supabase.co')).toThrow()
    expect(assertStagingRef('abcdefghijklmnopqrst')).toBe('abcdefghijklmnopqrst')
  })

  it('signs a test-mode event the way the webhook verifies it', async () => {
    const body = paidEvent({ eventId: 'evt_check1', checkoutId: 'cs_check1', paymentId: 'pay_check1', amount: 99900 })
    expect(await verifyWebhookSignature(body, signatureHeader(SECRET, body, 1_800_000_000), SECRET)).toBe(true)
  })

  it('a live-only signature, another secret or a changed body is refused', async () => {
    const body = paidEvent({ eventId: 'evt_check2', checkoutId: 'cs_check2', paymentId: 'pay_check2', amount: 99900 })
    const t = 1_800_000_000
    expect(await verifyWebhookSignature(body, signatureHeader(SECRET, body, t, 'live'), SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, signatureHeader('whsk_other', body, t), SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body.replace('99900', '99901'), signatureHeader(SECRET, body, t), SECRET)).toBe(false)
  })

  it('builds the paid event PayMongo sends, which the webhook reads correctly', () => {
    const event = parseWebhookEvent(
      JSON.parse(paidEvent({ eventId: 'evt_check3', checkoutId: 'cs_check3', paymentId: 'pay_check3', amount: 249900, livemode: true })),
    )
    expect(event).toMatchObject({
      eventId: 'evt_check3',
      type: 'checkout_session.payment.paid',
      livemode: true,
      checkoutId: 'cs_check3',
      paymentId: 'pay_check3',
      amountCentavos: 249900,
      currency: 'PHP',
    })
    expect(event.paidAt).not.toBeNull()
  })
})
