import { createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { Caller } from '../../supabase/functions/_shared/caller'
import {
  assertCentavos,
  basicAuthHeader,
  buildCheckoutBody,
  isTestSecretKey,
  parseCheckoutSession,
  parseSignatureHeader,
  parseWebhookEvent,
  paymentStateOf,
  verifyWebhookSignature,
  type CheckoutSession,
} from '../../supabase/functions/_shared/paymongo'
import {
  handleCheckout,
  validateRequest,
  type CheckoutProvider,
  type CheckoutStore,
} from '../../supabase/functions/paymongo-checkout/handler'
import { handleWebhook } from '../../supabase/functions/paymongo-webhook/handler'

/**
 * The PayMongo sandbox integration with PayMongo and the database replaced:
 * signatures, event parsing, status mapping, and both Edge Functions' rules.
 * Every value here is made up; no request leaves the test.
 */

const SECRET = 'whsk_testsecret123'
const sign = (body: string, t = '1700000000', secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')

const sessionResource = (over: { status?: string; payments?: unknown[]; livemode?: boolean } = {}) => ({
  id: 'cs_abc123',
  type: 'checkout_session',
  attributes: {
    checkout_url: 'https://checkout.paymongo.com/cs_abc123_client#x',
    status: over.status ?? 'active',
    livemode: over.livemode ?? false,
    payment_intent: { id: 'pi_abc123' },
    payments: over.payments ?? [],
  },
})

const payment = (status: string, amount = 99900) => ({
  id: 'pay_xyz789',
  attributes: { status, amount, currency: 'PHP', paid_at: 1_764_000_000, payment_intent_id: 'pi_abc123' },
})

const eventBody = (type: string, data: unknown, livemode = false) =>
  JSON.stringify({ data: { id: 'evt_123abc', type: 'event', attributes: { type, livemode, data } } })

describe('money and keys', () => {
  it('only whole positive centavos', () => {
    expect(assertCentavos(99900)).toBe(99900)
    for (const bad of [0, -1, 999.5, '99900', Number.NaN, 2 ** 60]) {
      expect(() => assertCentavos(bad)).toThrow()
    }
  })

  it('accepts test secret keys only', () => {
    expect(isTestSecretKey('sk_test_abc123')).toBe(true)
    expect(isTestSecretKey('sk_live_abc123')).toBe(false)
    expect(isTestSecretKey(undefined)).toBe(false)
    expect(basicAuthHeader('sk_test_abc')).toBe(`Basic ${btoa('sk_test_abc:')}`)
  })

  it('builds a one-month checkout priced only from the quote', () => {
    const body = buildCheckoutBody({
      planName: 'Premium',
      amountCentavos: 249900,
      currency: 'PHP',
      successUrl: 'https://app.test/admin/settings?billing=success',
      cancelUrl: 'https://app.test/admin/settings?billing=cancelled',
    }) as { data: { attributes: Record<string, unknown> } }
    expect(body.data.attributes['line_items']).toEqual([
      { name: 'RecoverEase Premium plan - 1 month', amount: 249900, currency: 'PHP', quantity: 1 },
    ])
    expect(body.data.attributes['payment_method_types']).toEqual(['card'])
    expect(() => buildCheckoutBody({ planName: 'x', amountCentavos: 9.99, currency: 'PHP', successUrl: '', cancelUrl: '' })).toThrow()
  })
})

describe('payment status mapping', () => {
  const state = (over: Parameters<typeof sessionResource>[0]) => paymentStateOf(parseCheckoutSession(sessionResource(over)))
  it('paid only when PayMongo lists a paid payment', () => {
    expect(state({ payments: [payment('failed'), payment('paid')] })).toBe('paid')
    expect(state({ payments: [payment('failed')] })).toBe('failed')
    expect(state({ payments: [payment('pending')] })).toBe('pending')
    expect(state({})).toBe('pending')
    expect(state({ status: 'expired' })).toBe('cancelled')
  })

  it('refuses anything that is not a checkout session', () => {
    expect(() => parseCheckoutSession({ id: 'pay_1', attributes: {} })).toThrow()
    expect(() => parseCheckoutSession(null)).toThrow()
  })
})

describe('webhook signature', () => {
  const body = eventBody('checkout_session.payment.paid', sessionResource({ payments: [payment('paid')] }))

  it('accepts PayMongo’s test signature over the raw body', async () => {
    expect(await verifyWebhookSignature(body, `t=1700000000,te=${sign(body)},li=`, SECRET)).toBe(true)
  })

  it('rejects a wrong secret, a changed body, a live-only header and garbage', async () => {
    expect(await verifyWebhookSignature(body, `t=1700000000,te=${sign(body, '1700000000', 'whsk_other')},li=`, SECRET)).toBe(false)
    expect(await verifyWebhookSignature(`${body} `, `t=1700000000,te=${sign(body)},li=`, SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, `t=1700000001,te=${sign(body)},li=`, SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, `t=1700000000,te=,li=${sign(body)}`, SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, null, SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, 'nonsense', SECRET)).toBe(false)
    expect(await verifyWebhookSignature(body, `t=1700000000,te=${sign(body)}`, '')).toBe(false)
  })

  it('parses the header parts', () => {
    expect(parseSignatureHeader('t=1,te=aa,li=bb')).toEqual({ t: '1', te: 'aa', li: 'bb' })
    expect(parseSignatureHeader('te=aa')).toBeNull()
  })
})

describe('webhook event parsing', () => {
  it('reads the paid payment from a checkout event', () => {
    const event = parseWebhookEvent(JSON.parse(eventBody('checkout_session.payment.paid', sessionResource({ payments: [payment('paid')] }))))
    expect(event).toEqual({
      eventId: 'evt_123abc',
      type: 'checkout_session.payment.paid',
      livemode: false,
      checkoutId: 'cs_abc123',
      paymentIntentId: 'pi_abc123',
      paymentId: 'pay_xyz789',
      amountCentavos: 99900,
      currency: 'PHP',
      paidAt: new Date(1_764_000_000 * 1000).toISOString(),
    })
  })

  it('reads the payment intent from a failed payment', () => {
    const event = parseWebhookEvent(JSON.parse(eventBody('payment.failed', payment('failed'))))
    expect(event).toMatchObject({ type: 'payment.failed', paymentId: 'pay_xyz789', paymentIntentId: 'pi_abc123', checkoutId: null })
  })

  it('keeps livemode and refuses a malformed event', () => {
    expect(parseWebhookEvent(JSON.parse(eventBody('payment.paid', {}, true))).livemode).toBe(true)
    expect(() => parseWebhookEvent({ data: { id: 'not-an-event', attributes: { type: 'x' } } })).toThrow()
    expect(() => parseWebhookEvent([])).toThrow()
  })
})

describe('paymongo-webhook', () => {
  const body = eventBody('checkout_session.payment.paid', sessionResource({ payments: [payment('paid')] }))

  it('refuses an invalid signature without touching the database', async () => {
    const handle = vi.fn()
    const result = await handleWebhook(body, 't=1700000000,te=deadbeef,li=', { webhookSecret: SECRET, store: { handle } })
    expect(result.status).toBe(401)
    expect(handle).not.toHaveBeenCalled()
  })

  it('applies a signed event, and a repeat is answered 200 without doing it twice', async () => {
    const outcomes = ['activated', 'duplicate']
    const handle = vi.fn(async () => outcomes.shift()!)
    const header = `t=1700000000,te=${sign(body)},li=`
    expect((await handleWebhook(body, header, { webhookSecret: SECRET, store: { handle } })).status).toBe(200)
    expect((await handleWebhook(body, header, { webhookSecret: SECRET, store: { handle } })).status).toBe(200)
    expect(handle).toHaveBeenCalledTimes(2)
    expect(outcomes).toEqual([])
  })

  it('answers 400 to a signed but malformed body and 500 to a database failure', async () => {
    const bad = '{"data":{}}'
    expect((await handleWebhook(bad, `t=1,te=${sign(bad, '1')},li=`, { webhookSecret: SECRET, store: { handle: vi.fn() } })).status).toBe(400)
    const failing = { handle: vi.fn(async () => { throw new Error('down') }) }
    expect((await handleWebhook(body, `t=1700000000,te=${sign(body)},li=`, { webhookSecret: SECRET, store: failing })).status).toBe(500)
  })

  it('never echoes the event back', async () => {
    const result = await handleWebhook(body, `t=1700000000,te=${sign(body)},li=`, {
      webhookSecret: SECRET,
      store: { handle: async () => 'activated' },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/cs_|pay_|evt_|99900/)
  })
})

describe('paymongo-checkout', () => {
  const admin: Caller = { userId: 'u-admin', email: 'admin@clinic.test', role: 'admin' }
  const PAYMENT_ID = '0b4b4c1e-1111-4222-8333-444455556666'

  function fakes(session: CheckoutSession = parseCheckoutSession(sessionResource())) {
    const store: CheckoutStore = {
      quote: vi.fn(async () => ({ clinicId: 'c1', planCode: 'basic', planName: 'Basic', amountCentavos: 99900, currency: 'PHP' })),
      record: vi.fn(async () => ({ paymentId: PAYMENT_ID, amountCentavos: 99900 })),
      ownPayment: vi.fn(async () => ({ paymentId: PAYMENT_ID, checkoutId: 'cs_abc123', paymentIntentId: 'pi_abc123', status: 'pending' as const, amountCentavos: 99900 })),
      applyPaid: vi.fn(async () => 'activated'),
      markCancelled: vi.fn(async () => 'marked_cancelled'),
    }
    const provider: CheckoutProvider = {
      create: vi.fn(async () => session),
      retrieve: vi.fn(async () => session),
      expire: vi.fn(async () => true),
    }
    return { store, provider, returnOrigin: 'https://recoverease-web.vercel.app' }
  }

  it('validates the request: a plan name, or a payment id', () => {
    expect(validateRequest({ action: 'create', plan: 'premium' })).toEqual({ action: 'create', plan: 'premium' })
    expect(() => validateRequest({ action: 'create', plan: 'enterprise' })).toThrow()
    expect(() => validateRequest({ action: 'check', paymentId: 'x' })).toThrow()
    expect(() => validateRequest(null)).toThrow()
  })

  it('refuses doctors, patients and Super Admins', async () => {
    for (const role of ['doctor', 'patient', 'super_admin'] as const) {
      const deps = fakes()
      const result = await handleCheckout({ ...admin, role }, { action: 'create', plan: 'basic' }, deps)
      expect(result.status).toBe(403)
      expect(deps.store.quote).not.toHaveBeenCalled()
      expect(deps.provider.create).not.toHaveBeenCalled()
    }
  })

  it('creates a checkout at the database’s price and returns only the URL and payment id', async () => {
    const deps = fakes()
    const result = await handleCheckout(admin, { action: 'create', plan: 'basic', amount: 1, clinicId: 'other' }, deps)
    expect(result).toEqual({
      status: 200,
      body: { checkoutUrl: 'https://checkout.paymongo.com/cs_abc123_client#x', paymentId: PAYMENT_ID },
    })
    expect(deps.store.quote).toHaveBeenCalledWith('u-admin', 'basic')
    const sent = vi.mocked(deps.provider.create).mock.calls[0]![0] as { data: { attributes: { line_items: { amount: number }[]; success_url: string } } }
    expect(sent.data.attributes.line_items[0]!.amount).toBe(99900)
    expect(sent.data.attributes.success_url).toBe('https://recoverease-web.vercel.app/admin/settings?billing=success')
  })

  it('expires the session when the price changed before it was recorded', async () => {
    const deps = fakes()
    vi.mocked(deps.store.record).mockResolvedValueOnce({ paymentId: PAYMENT_ID, amountCentavos: 129900 })
    const result = await handleCheckout(admin, { action: 'create', plan: 'basic' }, deps)
    expect(result.status).toBe(409)
    expect(deps.provider.expire).toHaveBeenCalledWith('cs_abc123')
    expect(deps.store.markCancelled).toHaveBeenCalledWith('cs_abc123')
  })

  it('refuses a checkout from a website not on the allow-list', async () => {
    const deps = { ...fakes(), returnOrigin: null }
    expect((await handleCheckout(admin, { action: 'create', plan: 'basic' }, deps)).status).toBe(403)
    expect(deps.provider.create).not.toHaveBeenCalled()
  })

  it('check: applies only what PayMongo confirms paid', async () => {
    const paid = fakes(parseCheckoutSession(sessionResource({ payments: [payment('paid')] })))
    expect((await handleCheckout(admin, { action: 'check', paymentId: PAYMENT_ID }, paid)).body).toEqual({ status: 'paid' })
    expect(paid.store.applyPaid).toHaveBeenCalledWith('cs_abc123', 'pay_xyz789', 99900, 'PHP', expect.any(String))

    const unpaid = fakes()
    expect((await handleCheckout(admin, { action: 'check', paymentId: PAYMENT_ID }, unpaid)).body).toEqual({ status: 'pending' })
    expect(unpaid.store.applyPaid).not.toHaveBeenCalled()
  })

  it('check: shows a failed payment as failed', async () => {
    const deps = fakes(parseCheckoutSession(sessionResource({ payments: [payment('failed')] })))
    expect((await handleCheckout(admin, { action: 'check', paymentId: PAYMENT_ID }, deps)).body).toEqual({ status: 'failed' })
    expect(deps.store.applyPaid).not.toHaveBeenCalled()
  })

  it('cancel: expires the unpaid session at PayMongo and records it cancelled', async () => {
    const deps = fakes()
    expect((await handleCheckout(admin, { action: 'cancel', paymentId: PAYMENT_ID }, deps)).body).toEqual({ status: 'cancelled' })
    expect(deps.provider.expire).toHaveBeenCalledWith('cs_abc123')
    expect(deps.store.markCancelled).toHaveBeenCalledWith('cs_abc123')
    expect(deps.store.applyPaid).not.toHaveBeenCalled()
  })

  it('cancel: a session PayMongo says was paid is applied, not cancelled', async () => {
    const deps = fakes(parseCheckoutSession(sessionResource({ payments: [payment('paid')] })))
    expect((await handleCheckout(admin, { action: 'cancel', paymentId: PAYMENT_ID }, deps)).body).toEqual({ status: 'paid' })
    expect(deps.provider.expire).not.toHaveBeenCalled()
    expect(deps.store.markCancelled).not.toHaveBeenCalled()
  })

  it('another clinic’s payment is not found', async () => {
    const deps = fakes()
    vi.mocked(deps.store.ownPayment).mockResolvedValueOnce(null)
    expect((await handleCheckout(admin, { action: 'cancel', paymentId: PAYMENT_ID }, deps)).status).toBe(404)
    expect(deps.provider.retrieve).not.toHaveBeenCalled()
  })

  it('a PayMongo outage charges nothing and says so', async () => {
    const deps = fakes()
    vi.mocked(deps.provider.create).mockRejectedValueOnce(new Error('PayMongo answered 500'))
    const result = await handleCheckout(admin, { action: 'create', plan: 'basic' }, deps)
    expect(result).toEqual({ status: 500, body: { error: 'The payment service could not be reached. Nothing was charged.' } })
    expect(deps.store.record).not.toHaveBeenCalled()
  })
})
