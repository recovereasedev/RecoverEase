/**
 * PayMongo, as RecoverEase uses it: one-time Checkout Sessions in TEST mode,
 * and the signed webhook that confirms them. No Deno or Supabase dependency,
 * so every rule here is unit tested in Node.
 *
 * From PayMongo's documentation (docs.paymongo.com, read 2026-11-27):
 *   - POST /v1/checkout_sessions, GET /v1/checkout_sessions/{id} and
 *     POST /v1/checkout_sessions/{id}/expire, with HTTP Basic auth: the
 *     secret key as the username and an empty password.
 *   - Amounts are integer centavos; PHP is the only currency.
 *   - A session's payments are `pending`, `failed` or `paid`; at most one is
 *     paid. A session does not expire by itself, and PayMongo sends no event
 *     when it is expired.
 *   - Webhook header `Paymongo-Signature: t=<unix>,te=<test sig>,li=<live sig>`.
 *     The signature is HMAC-SHA256, keyed with the webhook's secret, over
 *     `<t>.<raw body>`; `te` is compared for test-mode events, `li` for live.
 *   - Event envelope: data.id `evt_…`, data.attributes.type,
 *     data.attributes.livemode, data.attributes.data (the resource).
 */

export const PAYMONGO_API = 'https://api.paymongo.com/v1'

/** The events the webhook is registered for. Anything else is recorded and ignored. */
export const HANDLED_EVENTS = ['checkout_session.payment.paid', 'payment.failed'] as const

/** Only test keys are accepted: this integration never runs in live mode. */
export function isTestSecretKey(key: string | undefined): key is string {
  return typeof key === 'string' && /^sk_test_[A-Za-z0-9]+$/.test(key)
}

export function basicAuthHeader(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`
}

// --- Money -----------------------------------------------------------------

/** Whole centavos, the only unit stored or sent. Refuses anything else. */
export function assertCentavos(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('An amount must be a positive whole number of centavos')
  }
  return value
}

// --- Checkout ----------------------------------------------------------------

export type CheckoutPlan = 'basic' | 'premium'

export function parsePlanCode(value: unknown): CheckoutPlan | null {
  return value === 'basic' || value === 'premium' ? value : null
}

/** The Checkout Session body, priced only from what the database quoted. */
export function buildCheckoutBody(input: {
  planName: string
  amountCentavos: number
  currency: string
  successUrl: string
  cancelUrl: string
}): Record<string, unknown> {
  return {
    data: {
      attributes: {
        line_items: [
          {
            name: `RecoverEase ${input.planName} plan - 1 month`,
            amount: assertCentavos(input.amountCentavos),
            currency: input.currency,
            quantity: 1,
          },
        ],
        payment_method_types: ['card'],
        description: `RecoverEase ${input.planName} plan, one month`,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        send_email_receipt: false,
        show_line_items: true,
      },
    },
  }
}

export type SessionPayment = {
  id: string
  status: 'pending' | 'failed' | 'paid' | string
  amount: number | null
  currency: string | null
  paidAt: string | null
}

export type CheckoutSession = {
  id: string
  checkoutUrl: string | null
  status: string
  paymentIntentId: string | null
  livemode: boolean
  payments: SessionPayment[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function unixToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}

function parsePayment(value: unknown): SessionPayment | null {
  if (!isRecord(value) || !isRecord(value['attributes'])) return null
  const id = str(value['id'])
  const a = value['attributes']
  if (!id || !id.startsWith('pay_')) return null
  return {
    id,
    status: str(a['status']) ?? 'unknown',
    amount: typeof a['amount'] === 'number' && Number.isSafeInteger(a['amount']) ? a['amount'] : null,
    currency: str(a['currency']),
    paidAt: unixToIso(a['paid_at']),
  }
}

/** A Checkout Session resource (`cs_…`), as PayMongo returns or sends it. */
export function parseCheckoutSession(resource: unknown): CheckoutSession {
  if (!isRecord(resource) || !isRecord(resource['attributes'])) {
    throw new Error('Not a checkout session')
  }
  const id = str(resource['id'])
  if (!id || !/^cs_[A-Za-z0-9]+$/.test(id)) throw new Error('Not a checkout session')
  const a = resource['attributes']
  const intent = a['payment_intent']
  return {
    id,
    checkoutUrl: str(a['checkout_url']),
    status: str(a['status']) ?? 'unknown',
    paymentIntentId: isRecord(intent) ? str(intent['id']) : null,
    livemode: a['livemode'] === true,
    payments: Array.isArray(a['payments'])
      ? a['payments'].map(parsePayment).filter((p): p is SessionPayment => p !== null)
      : [],
  }
}

/** The one payment PayMongo marked paid on a session, if any. */
export function paidPaymentOf(session: CheckoutSession): SessionPayment | null {
  return session.payments.find((payment) => payment.status === 'paid') ?? null
}

/**
 * What the Clinic Admin sees for a checkout. Only PayMongo's own status moves
 * it: a browser arriving at the success page proves nothing by itself.
 */
export type PaymentState = 'pending' | 'paid' | 'failed' | 'cancelled'

export function paymentStateOf(session: CheckoutSession): PaymentState {
  if (paidPaymentOf(session)) return 'paid'
  if (session.status === 'expired') return 'cancelled'
  const last = session.payments.at(-1)
  return last?.status === 'failed' ? 'failed' : 'pending'
}

// --- Webhook -----------------------------------------------------------------

export type SignatureParts = { t: string; te: string; li: string }

export function parseSignatureHeader(header: string | null): SignatureParts | null {
  if (!header) return null
  const parts: Record<string, string> = {}
  for (const piece of header.split(',')) {
    const at = piece.indexOf('=')
    if (at <= 0) continue
    parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim()
  }
  if (!parts['t'] || !/^\d+$/.test(parts['t'])) return null
  return { t: parts['t'], te: parts['te'] ?? '', li: parts['li'] ?? '' }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Compares every character, so the time taken says nothing about where they differ. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/**
 * Whether PayMongo signed exactly this body. Test mode only: the `te`
 * signature is the one checked, and a header carrying only a live signature
 * is refused.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  webhookSecret: string,
): Promise<boolean> {
  const parts = parseSignatureHeader(header)
  if (!parts || !parts.te || !webhookSecret) return false
  const expected = await hmacHex(webhookSecret, `${parts.t}.${rawBody}`)
  return constantTimeEqual(expected, parts.te.toLowerCase())
}

/** One PayMongo event, reduced to what the database needs. */
export type WebhookEvent = {
  eventId: string
  type: string
  livemode: boolean
  checkoutId: string | null
  paymentIntentId: string | null
  paymentId: string | null
  amountCentavos: number | null
  currency: string | null
  paidAt: string | null
}

export function parseWebhookEvent(body: unknown): WebhookEvent {
  const data = isRecord(body) ? body['data'] : null
  if (!isRecord(data) || !isRecord(data['attributes'])) throw new Error('Not a PayMongo event')
  const eventId = str(data['id'])
  if (!eventId || !/^evt_[A-Za-z0-9]+$/.test(eventId)) throw new Error('Not a PayMongo event')
  const a = data['attributes']
  const type = str(a['type'])
  if (!type) throw new Error('Not a PayMongo event')

  const event: WebhookEvent = {
    eventId,
    type,
    livemode: a['livemode'] === true,
    checkoutId: null,
    paymentIntentId: null,
    paymentId: null,
    amountCentavos: null,
    currency: null,
    paidAt: null,
  }

  if (type === 'checkout_session.payment.paid') {
    const session = parseCheckoutSession(a['data'])
    const paid = paidPaymentOf(session)
    event.checkoutId = session.id
    event.paymentIntentId = session.paymentIntentId
    if (paid) {
      event.paymentId = paid.id
      event.amountCentavos = paid.amount
      event.currency = paid.currency
      event.paidAt = paid.paidAt
    }
  } else if (type === 'payment.failed') {
    const resource = a['data']
    const payment = parsePayment(resource)
    if (payment && isRecord(resource) && isRecord(resource['attributes'])) {
      event.paymentId = payment.id
      event.paymentIntentId = str(resource['attributes']['payment_intent_id'])
    }
  }
  return event
}
