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
      .select('payment_id, plan_name_snapshot, payment_amount_centavos, payment_status, payment_created_at, payment_paid_at')
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
