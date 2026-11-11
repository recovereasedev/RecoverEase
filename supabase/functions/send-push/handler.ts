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
 * budget is spent, whichever is first. Each delivery's outcome is recorded
 * before the next batch is claimed; one that fails to record is left
 * 'sending' and reclaimed after its two-minute lock (migration 53), where
 * the Topic header and the notification tag keep the phone from showing it
 * twice.
 */
export async function dispatchPushes({
  store,
  send,
  batchSize = 50,
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
        const payload = buildPushPayload(delivery.push_kind, delivery.notification_id)
        const result = await send(
          {
            endpoint: delivery.push_endpoint,
            p256dh: delivery.push_p256dh,
            auth: delivery.push_auth,
          },
          JSON.stringify(payload),
          // 32 characters, the Topic header's maximum.
          { topic: delivery.delivery_id.replace(/-/g, '') },
        )
        summary[result.outcome]++
        await store.complete(delivery.delivery_id, result)
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
  if (!config.dispatchSecret) missing.push('PUSH_DISPATCH_SECRET')
  if (!config.vapidPublicKey) missing.push('VAPID_PUBLIC_KEY')
  if (!config.vapidPrivateKey) missing.push('VAPID_PRIVATE_KEY')
  if (!/^(mailto:|https:\/\/)/.test(config.vapidSubject)) missing.push('VAPID_SUBJECT')
  return missing
}
