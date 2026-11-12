import type { PushResult, PushSubscriptionKeys } from '../_shared/web-push.ts'
import { buildPushPayload } from './payload.ts'

/**
 * send-push's rules, free of Deno and Supabase so the unit tests run them
 * (tests/unit/send-push-handler.test.ts). `index.ts` is the HTTP shell.
 */

export type ClaimedDelivery = {
  delivery_id: string
  notification_id: string
  push_kind: string
  attempt_count: number
  push_endpoint: string
  push_p256dh: string
  push_auth: string
}

export type PushStore = {
  claim(batchSize: number): Promise<ClaimedDelivery[]>
  complete(deliveryId: string, result: PushResult): Promise<void>
}

export type Sender = (
  subscription: PushSubscriptionKeys,
  payload: string,
  options: { topic: string },
) => Promise<PushResult>

export type DispatchSummary = { sent: number; retry: number; failed: number; gone: number; batches: number }

/**
 * Claims due deliveries and sends them until the queue is empty or the time
 * budget is spent, whichever is first.
 *
 * Time: a new batch is claimed only before `budgetMs` (40 s). Every request
 * in a batch is cut off at 10 s (`sendPush`) and they run side by side, so a
 * batch ends at most about 10 s after it starts - a run by about 50 s, inside
 * pg_net's 55 s and well inside the queue's two-minute lease (migration 53).
 * One endpoint that never answers costs its own delivery a retry and nothing
 * else.
 *
 * Each delivery's outcome is recorded on its own; one that throws, or fails
 * to record, is left 'sending' and reclaimed after its lease.
 *
 * What is and is not guaranteed. The queue holds one row per notification
 * and device, and a row is claimed by one run at a time, so there is one
 * logical delivery. The transport is "at least once": the push service can
 * accept a message whose reply never reaches us (a timeout, a dropped
 * connection, a run that dies before recording), and that delivery is then
 * sent again. Every attempt carries the same Topic (the delivery's id) and
 * the same notification tag (the notification's id), which suppress most
 * repeats - a message still waiting at the push service is replaced, and a
 * notification still on screen is replaced. They cannot undo one the
 * patient has already seen and dismissed: that one can appear a second
 * time. Retries are bounded (five attempts, six hours).
 */
export async function dispatchPushes({
  store,
  send,
  batchSize = 25,
  budgetMs = 40_000,
  now = () => Date.now(),
}: {
  store: PushStore
  send: Sender
  batchSize?: number
  budgetMs?: number
  now?: () => number
}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, retry: 0, failed: 0, gone: 0, batches: 0 }
  const deadline = now() + budgetMs

  while (now() < deadline) {
    const batch = await store.claim(batchSize)
    if (batch.length === 0) break
    summary.batches++

    await Promise.all(
      batch.map(async (delivery) => {
        try {
          const payload = buildPushPayload(delivery.push_kind, delivery.notification_id)
          const result: PushResult = payload
            ? await send(
                {
                  endpoint: delivery.push_endpoint,
                  p256dh: delivery.push_p256dh,
                  auth: delivery.push_auth,
                },
                JSON.stringify(payload),
                // 32 characters, the Topic header's maximum.
                { topic: delivery.delivery_id.replace(/-/g, '') },
              )
            : // A kind this version does not know is never guessed at.
              { outcome: 'failed', status: null, errorCode: 'provider_4xx' }
          summary[result.outcome]++
          await store.complete(delivery.delivery_id, result)
        } catch {
          // Left 'sending'; the lease returns it. Nothing about it is logged
          // here: an error's text could name the endpoint.
        }
      }),
    )

    if (batch.length < batchSize) break
  }

  return summary
}

/** Constant-time comparison, so the secret cannot be guessed by timing. */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let difference = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return difference === 0
}

export type SendPushConfig = {
  dispatchSecret: string
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject: string
}

/** Names the missing secrets - never their values. */
export function missingConfig(config: SendPushConfig): string[] {
  const missing: string[] = []
  // Shorter than this could be guessed; the documented one is 43 characters.
  if (config.dispatchSecret.length < 32) missing.push('PUSH_DISPATCH_SECRET')
  if (!config.vapidPublicKey) missing.push('VAPID_PUBLIC_KEY')
  if (!config.vapidPrivateKey) missing.push('VAPID_PRIVATE_KEY')
  if (!/^(mailto:|https:\/\/)/.test(config.vapidSubject)) missing.push('VAPID_SUBJECT')
  return missing
}
