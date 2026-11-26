import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Subscriptions and PayMongo sandbox checkout (migration 68) in a real
 * browser against the production build, with Supabase and PayMongo stubbed.
 *
 * What the database counts and allows is tests/db/clinic-subscriptions.test.ts;
 * the Edge Functions' rules and the webhook signature are
 * tests/unit/paymongo.test.ts. Here: what the Super Admin and the Clinic
 * Admin see, what the browser sends (a plan name, never an amount or a
 * clinic), and that the page's return from PayMongo is only a cue to ask the
 * server.
 */

const PAYMENT_ID = '0b4b4c1e-1111-4222-8333-444455556666'

const PLANS = [
  { plan_code: 'free', plan_name: 'Free', plan_price_centavos: 0, plan_billing_interval: 'forever', plan_sort_order: 1 },
  { plan_code: 'basic', plan_name: 'Basic', plan_price_centavos: 99900, plan_billing_interval: 'month', plan_sort_order: 2 },
  { plan_code: 'premium', plan_name: 'Premium', plan_price_centavos: 249900, plan_billing_interval: 'month', plan_sort_order: 3 },
  { plan_code: 'enterprise', plan_name: 'Enterprise', plan_price_centavos: null, plan_billing_interval: 'custom', plan_sort_order: 4 },
]

const FREE = {
  subscription_id: 'sub-free',
  clinic_id: IDS.clinic,
  plan_code: 'free',
  subscription_status: 'active',
  subscription_period_start: '2026-10-01T00:00:00Z',
  subscription_period_end: null,
  subscription_agreed_price_centavos: null,
}

const PENDING_PAYMENT = {
  payment_id: PAYMENT_ID,
  clinic_id: IDS.clinic,
  plan_name_snapshot: 'Basic',
  payment_amount_centavos: 99900,
  payment_status: 'pending',
  payment_created_at: '2026-11-27T00:00:00Z',
  payment_paid_at: null,
}

const billingTables = (payments: Record<string, unknown>[] = []) => ({
  subscription_plan: PLANS,
  clinic_subscription: [FREE],
  subscription_payment: payments,
})

/** Answers the checkout function; records what the browser sent it. */
async function stubCheckout(page: Page, reply: (body: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Record<string, unknown>[] = []
  await page.route('**/functions/v1/paymongo-checkout', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      return
    }
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(reply(body)),
    })
  })
  return sent
}

test.describe('the Super Admin dashboard', () => {
  test('shows the subscriber cards, the four plans and revenue, on a phone too', async ({ page, signInAs }) => {
    await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    await page.goto('/platform')

    const band = page.getByLabel('Subscriptions and revenue')
    await expect(band).toContainText('Total subscribers')
    await expect(band).toContainText('Free subscribers')
    await expect(band).toContainText('Basic subscribers')
    await expect(band).toContainText('Premium subscribers')
    await expect(band).toContainText('Enterprise subscribers')
    await expect(band).toContainText('₱20,997.00')
    await expect(band).toContainText('₱3,498.00 this month')

    const plans = page.getByRole('list', { name: 'Clinics per plan' })
    await expect(plans.getByRole('listitem')).toHaveCount(4)
    await expect(plans).toContainText('Basic · ₱999.00 / month')
    await expect(plans).toContainText('Premium · ₱2,499.00 / month')
    await expect(plans).toContainText('Enterprise · Custom pricing')
    await expect(page.getByRole('list', { name: 'Revenue by plan' })).toContainText('₱17,499.00')
    await expect(page.getByRole('list', { name: 'Revenue by month, last 12 months' })).toContainText('Nov 2026')

    await page.setViewportSize({ width: 375, height: 812 })
    await expect(band).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('a clinic role never reaches it', async ({ page, signInAs }) => {
    const stub = await signInAs('admin', billingTables())
    await page.goto('/platform')
    await expect(page).not.toHaveURL(/\/platform/)
    expect(stub.requests).not.toContain('POST rpc/super_admin_subscription_overview')
  })
})

test.describe('the Clinic Admin’s subscription', () => {
  test('shows the four plans and starts a Basic checkout sending only the plan', async ({ page, signInAs }) => {
    await signInAs('admin', billingTables())
    const sent = await stubCheckout(page, () => ({
      checkoutUrl: 'https://checkout.paymongo.com/cs_test_client#stub',
      paymentId: PAYMENT_ID,
    }))
    await page.route('https://checkout.paymongo.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayMongo test checkout</h1>' }),
    )

    await page.goto('/admin/settings')
    const plans = page.getByRole('list', { name: 'Plans' })
    await expect(plans.getByRole('heading')).toHaveText(['Free', 'Basic', 'Premium', 'Enterprise'])
    await expect(plans).toContainText('Current plan')
    await expect(plans).toContainText('₱999.00 / month')
    await expect(plans).toContainText('Custom pricing')

    await page.getByRole('button', { name: 'Subscribe to Basic' }).click()
    await expect(page.getByRole('heading', { name: 'PayMongo test checkout' })).toBeVisible()
    expect(sent).toEqual([{ action: 'create', plan: 'basic' }])
  })

  test('starts a Premium checkout', async ({ page, signInAs }) => {
    await signInAs('admin', billingTables())
    const sent = await stubCheckout(page, () => ({ error: 'Online payment is not set up yet' }))
    await page.goto('/admin/settings')
    await page.getByRole('button', { name: 'Subscribe to Premium' }).click()
    await expect(page.getByRole('alert')).toContainText('Online payment is not set up yet')
    expect(sent).toEqual([{ action: 'create', plan: 'premium' }])
  })

  for (const [param, action, status, text] of [
    ['success', 'check', 'paid', 'Payment successful'],
    ['success', 'check', 'failed', 'Payment failed'],
    ['cancelled', 'cancel', 'cancelled', 'Payment cancelled'],
  ] as const) {
    test(`back from PayMongo (${param}): the server says ${status}`, async ({ page, signInAs }) => {
      await signInAs('admin', billingTables([PENDING_PAYMENT]))
      const sent = await stubCheckout(page, () => ({ status }))
      await page.goto(`/admin/settings?billing=${param}`)
      await expect(page.getByText(text, { exact: true })).toBeVisible()
      expect(sent).toEqual([{ action, paymentId: PAYMENT_ID }])
      // The cue is consumed: a reload does not ask again.
      await expect(page).toHaveURL(/\/admin\/settings$/)
    })
  }

  for (const role of ['doctor', 'patient'] as const) {
    test(`a ${role} has no subscription page`, async ({ page, signInAs }) => {
      const stub = await signInAs(role, billingTables())
      await page.goto('/admin/settings')
      await expect(page).not.toHaveURL(/\/admin\/settings/)
      expect(stub.requests.filter((r) => r.includes('subscription'))).toEqual([])
    })
  }
})
