import { parseWebhookEvent, verifyWebhookSignature, type WebhookEvent } from '../_shared/paymongo.ts'

/**
 * PayMongo's webhook, with the database behind an interface so every rule is
 * unit tested. `index.ts` is the HTTP shell.
 *
 * The order matters:
 *   1. The signature is checked over the raw body, before anything is parsed.
 *      No valid test-mode signature: 401, nothing read, nothing written.
 *   2. The event is parsed. Malformed: 400.
 *   3. The database records the event id and applies it in one transaction
 *      (`billing_handle_webhook_event`). The same event delivered again is a
 *      no-op ('duplicate'); a live-mode event is recorded and never applied.
 *      A database failure answers 500 so PayMongo retries.
 *
 * The response never echoes the event, and the log line carries the event
 * type and outcome only: no ids, amounts, names or payment details.
 */

export type WebhookStore = {
  handle(event: WebhookEvent): Promise<string>
}

export type WebhookResult = { status: number; body: Record<string, unknown> }

export async function handleWebhook(
  rawBody: string,
  signatureHeader: string | null,
  deps: { webhookSecret: string; store: WebhookStore },
): Promise<WebhookResult> {
  if (!(await verifyWebhookSignature(rawBody, signatureHeader, deps.webhookSecret))) {
    console.warn('paymongo-webhook', { result: 'invalid_signature' })
    return { status: 401, body: { error: 'Invalid signature' } }
  }

  let event: WebhookEvent
  try {
    event = parseWebhookEvent(JSON.parse(rawBody))
  } catch {
    console.warn('paymongo-webhook', { result: 'malformed_event' })
    return { status: 400, body: { error: 'Malformed event' } }
  }

  try {
    const result = await deps.store.handle(event)
    console.info('paymongo-webhook', { event_type: event.type, result })
    return { status: 200, body: { received: true } }
  } catch {
    console.error('paymongo-webhook', { event_type: event.type, result: 'database_error' })
    return { status: 500, body: { error: 'Not processed' } }
  }
}
