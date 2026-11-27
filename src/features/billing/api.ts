import { supabase } from '@/lib/supabase/client'

/**
 * A Clinic Admin's view of their clinic's plan (migration 68).
 *
 * Reads go straight to the tables: Row Level Security returns this Clinic
 * Admin's own clinic's rows and no one else's. Nothing here sends a clinic id
 * or an amount. Paying runs through the `paymongo-checkout` Edge Function,
 * which takes the clinic from the signed-in account and the price from the
 * database; moving to Free is a database function that does the same.
 */

export type PlanCode = 'free' | 'basic' | 'premium' | 'enterprise'
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled'
/** Where a payment came from: PayMongo, or the internal demo simulator (migration 70). */
export type PaymentSource = 'paymongo' | 'demo_simulator'

export type Plan = {
  code: PlanCode
  name: string
  priceCentavos: number | null
  billingInterval: 'forever' | 'month' | 'custom'
}

export type CurrentSubscription = {
  planCode: PlanCode
  status: string
  periodStart: string
  periodEnd: string | null
  agreedPriceCentavos: number | null
}

export type ClinicPayment = {
  paymentId: string
  planName: string
  amountCentavos: number
  status: PaymentStatus
  createdAt: string
  paidAt: string | null
  /** PayMongo live mode (migration 69). False is a sandbox (test-mode) payment. */
  livemode: boolean
  /** A demo simulator row is never PayMongo, sandbox or live: it is shown as Demo / Simulated. */
  source: PaymentSource
}

export type ClinicBilling = {
  plans: Plan[]
  current: CurrentSubscription | null
  payments: ClinicPayment[]
}

export async function fetchClinicBilling(): Promise<ClinicBilling> {
  const [plans, current, payments] = await Promise.all([
    supabase
      .from('subscription_plan')
      .select('plan_code, plan_name, plan_price_centavos, plan_billing_interval')
      .order('plan_sort_order'),
    supabase
      .from('clinic_subscription')
      .select('plan_code, subscription_status, subscription_period_start, subscription_period_end, subscription_agreed_price_centavos')
      .eq('subscription_status', 'active')
      .maybeSingle(),
    supabase
      .from('subscription_payment')
      .select('payment_id, plan_name_snapshot, payment_amount_centavos, payment_status, payment_created_at, payment_paid_at, payment_livemode, payment_provider')
      .order('payment_created_at', { ascending: false })
      .limit(5),
  ])
  if (plans.error) throw plans.error
  if (current.error) throw current.error
  if (payments.error) throw payments.error

  return {
    plans: (plans.data ?? []).map((row) => ({
      code: row.plan_code as PlanCode,
      name: row.plan_name,
      priceCentavos: row.plan_price_centavos,
      billingInterval: row.plan_billing_interval as Plan['billingInterval'],
    })),
    current: current.data
      ? {
          planCode: current.data.plan_code as PlanCode,
          status: current.data.subscription_status,
          periodStart: current.data.subscription_period_start,
          periodEnd: current.data.subscription_period_end,
          agreedPriceCentavos: current.data.subscription_agreed_price_centavos,
        }
      : null,
    payments: (payments.data ?? []).map((row) => ({
      paymentId: row.payment_id,
      planName: row.plan_name_snapshot,
      amountCentavos: row.payment_amount_centavos,
      status: row.payment_status as PaymentStatus,
      createdAt: row.payment_created_at,
      paidAt: row.payment_paid_at,
      // Anything but an explicit true is sandbox: a payment is never shown as live by default.
      livemode: row.payment_livemode === true,
      source: row.payment_provider === 'demo_simulator' ? 'demo_simulator' : 'paymongo',
    })),
  }
}

export async function chooseFreePlan(): Promise<void> {
  const { error } = await supabase.rpc('clinic_admin_choose_free_plan')
  if (error) throw new Error(error.message || 'Your clinic could not be moved to Free.')
}

/** The Edge Function's own message, when it gave one. */
async function invokeCheckout<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('paymongo-checkout', { body })
  if (error) {
    let message = 'The payment service could not be reached. Nothing was charged.'
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: string }
        if (payload?.error) message = payload.error
      } catch {
        // Not JSON; keep the general message.
      }
    }
    throw new Error(message)
  }
  if (!data || data.error) throw new Error(data?.error ?? 'No answer from the payment service.')
  return data
}

/** Starts a PayMongo test checkout; the browser is sent to the URL it returns. */
export async function startCheckout(plan: 'basic' | 'premium'): Promise<{ checkoutUrl: string; paymentId: string }> {
  const result = await invokeCheckout<{ checkoutUrl: string; paymentId: string }>({ action: 'create', plan })
  if (!result.checkoutUrl.startsWith('https://checkout.paymongo.com/')) {
    throw new Error('The payment service returned an unexpected address.')
  }
  return result
}

/**
 * Asks the server to read a checkout back from PayMongo: `check` after the
 * success page, `cancel` after the cancel page. The answer is PayMongo's
 * status, never the page the browser came back to.
 */
export async function confirmCheckout(
  action: 'check' | 'cancel',
  paymentId: string,
): Promise<PaymentStatus> {
  const result = await invokeCheckout<{ status: PaymentStatus }>({ action, paymentId })
  return result.status
}

// --- The internal demo payment simulator (migration 70) ----------------------

export type DemoMethod = 'qr_wallet' | 'card'
export type DemoOutcome = 'paid' | 'failed' | 'cancelled'

export type DemoPaymentResult = {
  result: 'activated' | 'failed' | 'cancelled' | 'duplicate'
  paymentId: string
  reference: string
  status: PaymentStatus
  planCode: 'basic' | 'premium'
  planName: string
  amountCentavos: number
  method: DemoMethod
  periodEnd: string | null
}

/** The database says the function is not there: migration 70 is not applied yet. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

/**
 * Whether the signed-in Clinic Admin's clinic may use the demo simulator.
 * Before migration 70 is applied the answer is simply no.
 */
export async function fetchDemoCheckoutAvailable(): Promise<boolean> {
  const { data, error } = await supabase.rpc('demo_payment_simulator_available')
  if (isMissingFunction(error)) return false
  if (error) throw error
  return data === true
}

/** The reference shown for a demo checkout; the database derives the same one from the request id. */
export function demoReference(requestId: string): string {
  return `RE-${requestId.replaceAll('-', '').slice(0, 10).toUpperCase()}`
}

const PAYMENT_STATUSES: readonly PaymentStatus[] = ['pending', 'paid', 'failed', 'cancelled']

/** Refuses an answer that is not exactly a demo payment result. */
export function parseDemoPaymentResult(data: unknown): DemoPaymentResult {
  const malformed = () => new Error('The demo checkout returned an answer that could not be read.')
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw malformed()
  const r = data as Record<string, unknown>
  if (
    !['activated', 'failed', 'cancelled', 'duplicate'].includes(r['result'] as string) ||
    typeof r['payment_id'] !== 'string' ||
    typeof r['reference'] !== 'string' ||
    !PAYMENT_STATUSES.includes(r['status'] as PaymentStatus) ||
    (r['plan_code'] !== 'basic' && r['plan_code'] !== 'premium') ||
    typeof r['plan_name'] !== 'string' ||
    typeof r['amount_centavos'] !== 'number' ||
    (r['method'] !== 'qr_wallet' && r['method'] !== 'card') ||
    !(r['period_end'] === null || typeof r['period_end'] === 'string')
  ) {
    throw malformed()
  }
  return {
    result: r['result'] as DemoPaymentResult['result'],
    paymentId: r['payment_id'],
    reference: r['reference'],
    status: r['status'] as PaymentStatus,
    planCode: r['plan_code'],
    planName: r['plan_name'],
    amountCentavos: r['amount_centavos'],
    method: r['method'],
    periodEnd: r['period_end'],
  }
}

/**
 * Records a simulated payment through the database. The browser sends the
 * plan's name, the demo screen, the chosen outcome and this checkout's request
 * id - never a clinic, an amount or a mode. The same request id again returns
 * the first answer and changes nothing.
 */
export async function simulateDemoPayment(input: {
  plan: 'basic' | 'premium'
  method: DemoMethod
  outcome: DemoOutcome
  requestId: string
}): Promise<DemoPaymentResult> {
  const { data, error } = await supabase.rpc('clinic_admin_simulate_demo_payment', {
    p_plan_code: input.plan,
    p_method: input.method,
    p_outcome: input.outcome,
    p_request_id: input.requestId,
  })
  if (isMissingFunction(error)) throw new Error('The demo checkout is not set up yet. Nothing was recorded.')
  if (error) throw new Error(error.message || 'The demo payment could not be recorded.')
  return parseDemoPaymentResult(data)
}

/** The signed-in Clinic Admin's own clinic name (RLS returns only their clinic). */
export async function fetchOwnClinicName(): Promise<string | null> {
  const { data, error } = await supabase.from('clinic').select('clinic_name').maybeSingle()
  if (error) throw error
  return data?.clinic_name ?? null
}
