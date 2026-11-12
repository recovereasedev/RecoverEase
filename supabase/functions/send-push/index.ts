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
 * is refused before anything is read.
 *
 * It runs with the service role, which can do exactly two things here: call
 * `claim_push_deliveries` and `complete_push_delivery` (the tables
 * themselves are closed to it). The database hands over only deliveries
 * that are still true - not a cancelled appointment's reminder, not a dose
 * already recorded. Each is sent to an allow-listed FCM endpoint only,
 * without following redirects, within ten seconds; what is recorded and
 * logged is a category and a status - never an endpoint, a reply body or a
 * message.
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
      if (error) throw new Error(`claim_push_deliveries failed (${error.code ?? 'unknown'})`)
      return (data ?? []) as ClaimedDelivery[]
    },
    async complete(deliveryId, result: PushResult) {
      const { error } = await admin.rpc('complete_push_delivery', {
        target_delivery_id: deliveryId,
        outcome: result.outcome,
        status_code: result.status,
        error_code: 'errorCode' in result ? result.errorCode : null,
        retry_after_seconds: result.outcome === 'retry' ? result.retryAfterSeconds : null,
      })
      // Logged, not thrown: the row stays 'sending' and is reclaimed later.
      if (error) {
        console.error(JSON.stringify({ event: 'push_complete_failed', deliveryId, code: error.code ?? null }))
      }
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
    // Only this function's own messages reach here (the claim's), which
    // carry a Postgres error code and nothing else.
    console.error(
      JSON.stringify({
        event: 'push_dispatch_failed',
        error: error instanceof Error ? error.message : 'unknown',
      }),
    )
    return json({ error: 'Dispatch failed' }, 500)
  }
})
