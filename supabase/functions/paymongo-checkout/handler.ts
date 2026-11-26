import { AuthError, failure, type Caller, type HandlerResult } from '../_shared/caller.ts'
import {
  buildCheckoutBody,
  paidPaymentOf,
  parsePlanCode,
  paymentStateOf,
  type CheckoutSession,
} from '../_shared/paymongo.ts'

/**
 * A Clinic Admin's sandbox checkout, with the database and PayMongo behind
 * interfaces so every rule is unit tested. `index.ts` is the HTTP shell.
 *
 *   create - the clinic is the caller's, read from the database; the amount
 *            is the plan's price, read from the database. The browser sends
 *            only a plan name and gets back only PayMongo's checkout URL.
 *   check  - after the success page: reads the session back from PayMongo
 *            with the secret key and applies it only if PayMongo says paid.
 *   cancel - after the cancel page: reads it back the same way; unpaid, it
 *            is expired at PayMongo and recorded as cancelled. If PayMongo
 *            says it was paid after all, it is applied instead.
 *
 * The webhook remains the primary confirmation; `check` is the same PayMongo
 * confirmation fetched on demand, so a clinic is not left waiting on a
 * delivery. Both go through the one database function that applies a
 * payment once.
 */

export type CheckoutRequest =
  | { action: 'create'; plan: string }
  | { action: 'check' | 'cancel'; paymentId: string }

export type Quote = {
  clinicId: string
  planCode: string
  planName: string
  amountCentavos: number
  currency: string
}

export type OwnPayment = {
  paymentId: string
  checkoutId: string
  paymentIntentId: string | null
  status: 'pending' | 'paid' | 'failed' | 'cancelled'
  amountCentavos: number
}

export type CheckoutStore = {
  /** Refuses (AuthError 403) anyone but a Clinic Admin of an active clinic. */
  quote(userId: string, plan: string): Promise<Quote>
  record(userId: string, plan: string, checkoutId: string, paymentIntentId: string | null): Promise<{ paymentId: string; amountCentavos: number }>
  /** A payment of the caller's own clinic, or null. */
  ownPayment(userId: string, paymentId: string): Promise<OwnPayment | null>
  applyPaid(checkoutId: string, paymentId: string, amountCentavos: number | null, currency: string | null, paidAt: string | null): Promise<string>
  markCancelled(checkoutId: string): Promise<string>
}

export type CheckoutProvider = {
  create(body: Record<string, unknown>): Promise<CheckoutSession>
  retrieve(checkoutId: string): Promise<CheckoutSession>
  /** Expires an unpaid session. Resolves false when PayMongo refuses (already paid, expired or in progress). */
  expire(checkoutId: string): Promise<boolean>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateRequest(body: unknown): CheckoutRequest {
  if (typeof body !== 'object' || body === null) throw new AuthError('Invalid request', 400)
  const { action, plan, paymentId } = body as Record<string, unknown>
  if (action === 'create') {
    const code = parsePlanCode(plan)
    if (!code) throw new AuthError('Choose Basic or Premium', 400)
    return { action, plan: code }
  }
  if ((action === 'check' || action === 'cancel') && typeof paymentId === 'string' && UUID.test(paymentId)) {
    return { action, paymentId }
  }
  throw new AuthError('Invalid request', 400)
}

export async function handleCheckout(
  caller: Caller,
  body: unknown,
  deps: { store: CheckoutStore; provider: CheckoutProvider; returnOrigin: string | null },
): Promise<HandlerResult> {
  if (caller.role !== 'admin') {
    return { status: 403, body: { error: 'Only a Clinic Admin can manage the clinic’s subscription' } }
  }

  let request: CheckoutRequest
  try {
    request = validateRequest(body)
  } catch (error) {
    return failure(error, 'Invalid request')
  }

  const { store, provider } = deps
  try {
    if (request.action === 'create') {
      if (!deps.returnOrigin) throw new AuthError('This website is not allowed to start a checkout', 403)
      const quote = await store.quote(caller.userId, request.plan)
      const back = `${deps.returnOrigin}/admin/settings`
      const session = await provider.create(
        buildCheckoutBody({
          planName: quote.planName,
          amountCentavos: quote.amountCentavos,
          currency: quote.currency,
          successUrl: `${back}?billing=success`,
          cancelUrl: `${back}?billing=cancelled`,
        }),
      )
      if (!session.checkoutUrl) throw new Error('PayMongo returned no checkout URL')

      let recorded: { paymentId: string; amountCentavos: number }
      try {
        recorded = await store.record(caller.userId, request.plan, session.id, session.paymentIntentId)
      } catch (error) {
        await provider.expire(session.id).catch(() => false)
        throw error
      }
      // The price changed between quoting and recording: charge neither.
      if (recorded.amountCentavos !== quote.amountCentavos) {
        await provider.expire(session.id).catch(() => false)
        await store.markCancelled(session.id)
        throw new AuthError('The plan’s price just changed. Please try again.', 409)
      }

      console.info('paymongo-checkout', { action: 'create', result: 'created', plan: request.plan })
      return {
        status: 200,
        body: { checkoutUrl: session.checkoutUrl, paymentId: recorded.paymentId },
      }
    }

    const own = await store.ownPayment(caller.userId, request.paymentId)
    if (!own) throw new AuthError('That payment was not found', 404)
    if (own.status === 'paid') return { status: 200, body: { status: 'paid' } }

    let session = await provider.retrieve(own.checkoutId)
    const paid = paidPaymentOf(session)
    if (paid) {
      const result = await store.applyPaid(session.id, paid.id, paid.amount, paid.currency, paid.paidAt)
      console.info('paymongo-checkout', { action: request.action, provider_status: 'paid', result })
      const ok = result === 'activated' || result === 'duplicate'
      return { status: 200, body: { status: ok ? 'paid' : 'pending' } }
    }

    if (request.action === 'cancel' && session.status !== 'expired') {
      const expired = await provider.expire(session.id)
      if (!expired) {
        // PayMongo refused: most likely a payment in progress. Read it again.
        session = await provider.retrieve(own.checkoutId)
        const late = paidPaymentOf(session)
        if (late) {
          await store.applyPaid(session.id, late.id, late.amount, late.currency, late.paidAt)
          return { status: 200, body: { status: 'paid' } }
        }
        if (session.status !== 'expired') {
          return { status: 200, body: { status: paymentStateOf(session) } }
        }
      }
      session = { ...session, status: 'expired' }
    }

    const state = paymentStateOf(session)
    if (state === 'cancelled') await store.markCancelled(session.id)
    console.info('paymongo-checkout', { action: request.action, provider_status: state })
    return { status: 200, body: { status: state === 'pending' ? own.status : state } }
  } catch (error) {
    if (!(error instanceof AuthError)) {
      console.error('paymongo-checkout failed', { action: request.action, category: error instanceof Error ? error.name : 'unknown' })
    }
    return failure(error, 'The payment service could not be reached. Nothing was charged.')
  }
}
