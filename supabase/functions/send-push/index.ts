import { serviceClient } from '../_shared/auth.ts'
import { sendPush, type PushResult } from '../_shared/web-push.ts'
import {
  dispatchPushes,
  missingConfig,
  secretMatches,
  type ClaimedDelivery,
  type PushStore,
} from './handler.ts'

/**
 * Sends the queued Web Push notifications (migration 53).
 *
 * Called once a minute by pg_cron through pg_net
 * (`app_private.request_push_dispatch()`), never by a browser: there is no
 * CORS, and a request without the shared secret in `x-push-dispatch-secret`
 * is refused before anything is read. It runs with the service role, claims
 * due deliveries, encrypts a fixed, generic message for each device and
 * records what the push service answered.
 *
 * Deploy (only with approval - see docs/deployment.md, "Web Push"):
 *   supabase functions deploy send-push --no-verify-jwt
 *   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
 *     VAPID_SUBJECT=mailto:... PUSH_DISPATCH_SECRET=...
 *
 * `--no-verify-jwt` because the caller is the database, which holds no user
 * token; the shared secret is the check instead.
 */

const config = {
  dispatchSecret: Deno.env.get('PUSH_DISPATCH_SECRET') ?? '',
  vapidPublicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
  vapidPrivateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
  vapidSubject: Deno.env.get('VAPID_SUBJECT') ?? '',
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function store(): PushStore {
  const admin = serviceClient()
  return {
    async claim(batchSize) {
      const { data, error } = await admin.rpc('claim_push_deliveries', { batch_size: batchSize })
      if (error) throw new Error(`claim_push_deliveries: ${error.message}`)
      return (data ?? []) as ClaimedDelivery[]
    },
    async complete(deliveryId, result: PushResult) {
      const { error } = await admin.rpc('complete_push_delivery', {
        target_delivery_id: deliveryId,
        outcome: result.outcome,
        status_code: result.status,
        error_text: 'error' in result ? result.error : null,
        retry_after_seconds: result.outcome === 'retry' ? result.retryAfterSeconds : null,
      })
      // Logged, not thrown: the row stays 'sending' and is reclaimed later.
      if (error) console.error(JSON.stringify({ event: 'push_complete_failed', deliveryId, error: error.message }))
    },
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const missing = missingConfig(config)
  if (missing.length > 0) {
    console.error(JSON.stringify({ event: 'push_not_configured', missing }))
    return json({ error: 'Push is not configured', missing }, 503)
  }

  if (!secretMatches(request.headers.get('x-push-dispatch-secret'), config.dispatchSecret)) {
    return json({ error: 'Forbidden' }, 403)
  }

  const vapid = {
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
    subject: config.vapidSubject,
  }

  try {
    const summary = await dispatchPushes({
      store: store(),
      send: (subscription, payload, options) => sendPush(subscription, payload, vapid, options),
    })
    // Counts only: no endpoint, user or message is logged.
    console.log(JSON.stringify({ event: 'push_dispatched', ...summary }))
    return json(summary, 200)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'push_dispatch_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: 'Dispatch failed' }, 500)
  }
})
