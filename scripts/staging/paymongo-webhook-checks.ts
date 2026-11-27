/**
 * STAGING ONLY. Sends signed, synthetic PayMongo test-mode events to the
 * staging `paymongo-webhook` and checks how it answers (docs/paymongo-staging.md).
 *
 * It covers what a real PayMongo checkout cannot easily produce: a missing,
 * wrong or live-only signature, a malformed body, a live-mode event, a
 * tampered amount, and (with --activate) a duplicate delivery. Real success,
 * failure and cancellation use PayMongo's own test checkout and cards.
 *
 *   $env:STAGING_PROJECT_REF = '<staging ref>'
 *   $env:PAYMONGO_WEBHOOK_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
 *     [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'whsk_ secret' -AsSecureString)))
 *   node --experimental-strip-types scripts/staging/paymongo-webhook-checks.ts --checkout cs_... --amount 99900
 *
 * --checkout / --amount: a PENDING staging checkout and its recorded amount
 * (from verify-billing.sql or the Clinic Admin's Subscription page).
 * --activate: also sends a correctly signed paid event twice for that
 * checkout. That ACTIVATES the plan on staging without PayMongo charging the
 * card, so use it only on the synthetic staging clinic.
 *
 * It refuses the production project, never prints the secret or a body,
 * and reads nothing from the database: check the outcome there with
 * supabase/staging/verify-billing.sql.
 */
import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const PRODUCTION_REF = 'kwsezszstdagzllbyjuk'

/** A Supabase project ref that is not production, or an error. */
export function assertStagingRef(ref: string | undefined): string {
  if (!ref || !/^[a-z]{20}$/.test(ref)) throw new Error('STAGING_PROJECT_REF must be a 20-letter Supabase project ref')
  if (ref === PRODUCTION_REF) throw new Error('Refusing: that is the PRODUCTION project')
  return ref
}

/** PayMongo's `Paymongo-Signature` header: HMAC-SHA256 of `<t>.<raw body>`. */
export function signatureHeader(secret: string, rawBody: string, t: number, mode: 'test' | 'live' = 'test'): string {
  const signature = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return mode === 'test' ? `t=${t},te=${signature},li=` : `t=${t},te=,li=${signature}`
}

/** A `checkout_session.payment.paid` event, shaped as PayMongo sends it. */
export function paidEvent(fields: {
  eventId: string
  checkoutId: string
  paymentId: string
  amount: number
  livemode?: boolean
}): string {
  const livemode = fields.livemode ?? false
  const paidAt = Math.floor(Date.now() / 1000)
  return JSON.stringify({
    data: {
      id: fields.eventId,
      type: 'event',
      attributes: {
        type: 'checkout_session.payment.paid',
        livemode,
        data: {
          id: fields.checkoutId,
          type: 'checkout_session',
          attributes: {
            status: 'active',
            livemode,
            payment_intent: { id: `pi_${fields.checkoutId.slice(3)}` },
            payments: [
              {
                id: fields.paymentId,
                type: 'payment',
                attributes: { status: 'paid', amount: fields.amount, currency: 'PHP', paid_at: paidAt },
              },
            ],
          },
        },
      },
    },
  })
}

type Check = { name: string; expect: number; db: string; send: () => Promise<number> }

async function main(): Promise<void> {
  const ref = assertStagingRef(process.env['STAGING_PROJECT_REF'])
  const secret = process.env['PAYMONGO_WEBHOOK_SECRET'] ?? ''
  if (!/^whsk_[A-Za-z0-9]+$/.test(secret)) throw new Error('PAYMONGO_WEBHOOK_SECRET is missing or not a whsk_ secret')

  const args = process.argv.slice(2)
  const arg = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const checkoutId = arg('--checkout') ?? ''
  const amount = Number(arg('--amount'))
  if (!/^cs_[A-Za-z0-9]+$/.test(checkoutId) || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Pass --checkout cs_... and --amount <centavos> for a pending staging checkout')
  }

  const url = `https://${ref}.supabase.co/functions/v1/paymongo-webhook`
  const stamp = Date.now().toString()
  const post = async (body: string, signature: string | null) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (signature) headers['paymongo-signature'] = signature
    const response = await fetch(url, { method: 'POST', headers, body })
    return response.status
  }
  const now = () => Math.floor(Date.now() / 1000)
  const event = (suffix: string, over: { amount?: number; livemode?: boolean } = {}) =>
    paidEvent({
      eventId: `evt_stagingcheck${stamp}${suffix}`,
      checkoutId,
      paymentId: `pay_stagingcheck${stamp}${suffix}`,
      amount: over.amount ?? amount,
      ...(over.livemode === undefined ? {} : { livemode: over.livemode }),
    })

  const checks: Check[] = [
    { name: 'no signature', expect: 401, db: 'nothing recorded', send: () => post(event('a'), null) },
    { name: 'wrong signature', expect: 401, db: 'nothing recorded', send: () => post(event('b'), signatureHeader('whsk_wrong', event('b'), now())) },
    { name: 'live-mode signature only', expect: 401, db: 'nothing recorded', send: () => { const b = event('c'); return post(b, signatureHeader(secret, b, now(), 'live')) } },
    { name: 'body changed after signing', expect: 401, db: 'nothing recorded', send: () => { const b = event('d'); return post(b.replace(String(amount), String(amount + 1)), signatureHeader(secret, b, now())) } },
    { name: 'malformed body, signed', expect: 400, db: 'nothing recorded', send: () => { const b = '{"data":{}}'; return post(b, signatureHeader(secret, b, now())) } },
    { name: 'live-mode event, signed', expect: 200, db: 'event rejected: livemode_not_accepted; plan unchanged', send: () => { const b = event('e', { livemode: true }); return post(b, signatureHeader(secret, b, now())) } },
    { name: 'tampered amount, signed', expect: 200, db: 'event ignored: amount_mismatch; plan unchanged', send: () => { const b = event('f', { amount: 100 }); return post(b, signatureHeader(secret, b, now())) } },
  ]
  if (args.includes('--activate')) {
    const b = event('g')
    checks.push(
      { name: 'paid event (activates the plan)', expect: 200, db: 'event processed: activated', send: () => post(b, signatureHeader(secret, b, now())) },
      { name: 'same event again (duplicate)', expect: 200, db: 'no second row, no second activation', send: () => post(b, signatureHeader(secret, b, now())) },
    )
  }

  let failed = 0
  for (const check of checks) {
    const status = await check.send()
    const ok = status === check.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}: HTTP ${status} (expected ${check.expect}); in the database: ${check.db}`)
  }
  console.log('Now run supabase/staging/verify-billing.sql on the staging project: live_revenue_centavos must be 0.')
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'failed')
    process.exitCode = 1
  })
}
