import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import { AuthError, requireCaller, serviceClient } from '../_shared/auth.ts'
import { corsHeaders, handlePreflight, jsonResponse } from '../_shared/cors.ts'
import {
  basicAuthHeader,
  isTestSecretKey,
  PAYMONGO_API,
  parseCheckoutSession,
} from '../_shared/paymongo.ts'
import { handleCheckout, type CheckoutProvider, type CheckoutStore } from './handler.ts'

/**
 * A Clinic Admin's PayMongo sandbox checkout for Basic or Premium
 * (migration 68). JWT verification stays ON: only a signed-in Clinic Admin
 * reaches the handler, and the database decides their clinic and the price.
 *
 * Secrets (names only; set with `supabase secrets set`, never in Vite):
 *   PAYMONGO_SECRET_KEY - a TEST secret key (sk_test_…). A live key is refused.
 *
 * Deploy (after migration 68, with approval):
 *   supabase functions deploy paymongo-checkout
 */

function refusalFromDatabase(error: { code?: string; message?: string }): Error {
  if (error.code === '42501') return new AuthError(error.message ?? 'Not allowed', 403)
  if (error.code === '23514') return new AuthError(error.message ?? 'Invalid request', 400)
  return new Error('database error')
}

function checkoutStore(db: SupabaseClient): CheckoutStore {
  return {
    async quote(userId, plan) {
      const { data, error } = await db.rpc('billing_checkout_quote', { p_user_id: userId, p_plan_code: plan })
      if (error) throw refusalFromDatabase(error)
      const row = Array.isArray(data) ? data[0] : null
      if (!row) throw new AuthError('That plan has no price', 400)
      return {
        clinicId: row.clinic_id,
        planCode: row.plan_code,
        planName: row.plan_name,
        amountCentavos: Number(row.amount_centavos),
        currency: row.currency,
      }
    },

    async record(userId, plan, checkoutId, paymentIntentId) {
      const { data, error } = await db.rpc('billing_record_checkout', {
        p_user_id: userId,
        p_plan_code: plan,
        p_checkout_id: checkoutId,
        p_payment_intent_id: paymentIntentId,
      })
      if (error) throw refusalFromDatabase(error)
      return { paymentId: data.payment_id, amountCentavos: Number(data.payment_amount_centavos) }
    },

    async ownPayment(userId, paymentId) {
      const { data: admin, error: adminError } = await db
        .from('admin')
        .select('clinic_id')
        .eq('user_id', userId)
        .maybeSingle()
      if (adminError) throw new Error('database error')
      if (!admin?.clinic_id) return null
      const { data, error } = await db
        .from('subscription_payment')
        .select('payment_id, provider_checkout_id, provider_payment_intent_id, payment_status, payment_amount_centavos')
        .eq('payment_id', paymentId)
        .eq('clinic_id', admin.clinic_id)
        .maybeSingle()
      if (error) throw new Error('database error')
      if (!data?.provider_checkout_id) return null
      return {
        paymentId: data.payment_id,
        checkoutId: data.provider_checkout_id,
        paymentIntentId: data.provider_payment_intent_id,
        status: data.payment_status,
        amountCentavos: Number(data.payment_amount_centavos),
      }
    },

    async applyPaid(checkoutId, paymentId, amount, currency, paidAt) {
      const { data, error } = await db.rpc('billing_apply_paid_checkout', {
        p_checkout_id: checkoutId,
        p_provider_payment_id: paymentId,
        p_amount_centavos: amount,
        p_currency: currency,
        p_paid_at: paidAt,
      })
      if (error) throw new Error('database error')
      return data as string
    },

    async markCancelled(checkoutId) {
      const { data, error } = await db.rpc('billing_mark_unpaid', {
        p_checkout_id: checkoutId,
        p_payment_intent_id: null,
        p_status: 'cancelled',
      })
      if (error) throw new Error('database error')
      return data as string
    },
  }
}

function paymongo(secretKey: string): CheckoutProvider {
  const headers = {
    Authorization: basicAuthHeader(secretKey),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const call = async (path: string, init: RequestInit) => {
    const response = await fetch(`${PAYMONGO_API}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    return response
  }
  const sessionFrom = async (response: Response) => {
    if (!response.ok) {
      // The status only: PayMongo's error body can echo request details.
      throw new Error(`PayMongo answered ${response.status}`)
    }
    const json = (await response.json()) as { data?: unknown }
    const session = parseCheckoutSession(json.data)
    if (session.livemode) throw new Error('PayMongo returned a live-mode session')
    return session
  }

  return {
    async create(body) {
      return sessionFrom(await call('/checkout_sessions', { method: 'POST', body: JSON.stringify(body) }))
    },
    async retrieve(checkoutId) {
      return sessionFrom(await call(`/checkout_sessions/${encodeURIComponent(checkoutId)}`, { method: 'GET' }))
    },
    async expire(checkoutId) {
      const response = await call(`/checkout_sessions/${encodeURIComponent(checkoutId)}/expire`, { method: 'POST' })
      await response.body?.cancel()
      return response.ok
    },
  }
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const origin = request.headers.get('origin')

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, origin)

  const secretKey = Deno.env.get('PAYMONGO_SECRET_KEY')
  if (!isTestSecretKey(secretKey)) {
    console.error('paymongo-checkout', { result: 'not_configured' })
    return jsonResponse({ error: 'Online payment is not set up yet' }, 503, origin)
  }

  try {
    const caller = await requireCaller(request)
    const body: unknown = await request.json().catch(() => null)
    const result = await handleCheckout(caller, body, {
      store: checkoutStore(serviceClient()),
      provider: paymongo(secretKey),
      returnOrigin: corsHeaders(origin)['Access-Control-Allow-Origin'] ?? null,
    })
    return jsonResponse(result.body, result.status, origin)
  } catch (error) {
    if (error instanceof AuthError) return jsonResponse({ error: error.message }, error.status, origin)
    console.error('paymongo-checkout', { result: 'failed' })
    return jsonResponse({ error: 'The payment could not be started' }, 500, origin)
  }
})
