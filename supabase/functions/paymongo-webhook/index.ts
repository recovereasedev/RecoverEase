import { serviceClient } from '../_shared/auth.ts'
import { handleWebhook } from './handler.ts'

/**
 * PayMongo's webhook endpoint (migration 68).
 *
 * Deployed with JWT verification OFF, because PayMongo cannot send a Supabase
 * user token. In its place every request must carry a valid PayMongo
 * test-mode signature (HMAC-SHA256 over `<t>.<raw body>` with the webhook's
 * secret); anything else is refused before the body is parsed. It is not a
 * browser endpoint, so it sends no CORS headers.
 *
 * Secrets (names only):
 *   PAYMONGO_WEBHOOK_SECRET - the `whsk_…` secret PayMongo returned when the
 *                             test-mode webhook was created.
 *
 * Deploy (after migration 68, with approval):
 *   supabase functions deploy paymongo-webhook --no-verify-jwt
 */

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const webhookSecret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET') ?? ''
  if (!/^whsk_[A-Za-z0-9]+$/.test(webhookSecret)) {
    console.error('paymongo-webhook', { result: 'not_configured' })
    return Response.json({ error: 'Not configured' }, { status: 503 })
  }

  // The raw text, exactly as signed: parsing first would change it.
  const rawBody = await request.text()
  const db = serviceClient()

  const result = await handleWebhook(rawBody, request.headers.get('paymongo-signature'), {
    webhookSecret,
    store: {
      async handle(event) {
        const { data, error } = await db.rpc('billing_handle_webhook_event', {
          p_event_id: event.eventId,
          p_event_type: event.type,
          p_livemode: event.livemode,
          p_checkout_id: event.checkoutId,
          p_payment_intent_id: event.paymentIntentId,
          p_provider_payment_id: event.paymentId,
          p_amount_centavos: event.amountCentavos,
          p_currency: event.currency,
          p_paid_at: event.paidAt,
        })
        if (error) throw new Error('database error')
        return data as string
      },
    },
  })

  return Response.json(result.body, { status: result.status })
})
