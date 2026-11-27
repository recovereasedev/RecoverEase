import type { Browser, Page } from '@playwright/test'

import { expect, IDS, platformDataset, SUBSCRIPTION_OVERVIEW, SupabaseStub, test } from './support/fixtures'

/**
 * The internal demo payment simulator (migration 70) in a real browser
 * against the production build, from both sides: the Clinic Admin pays
 * through the RecoverEase Demo Checkout, then the Super Admin sees the same
 * transaction in Demo Payment Activity and the subscriber counts move while
 * revenue does not.
 *
 * Supabase is stubbed here, as in every browser test: one in-memory ledger
 * stands in for the database, written by the Clinic Admin's simulate call
 * and read by the Super Admin's activity call. What the real database
 * allows, records and counts - for both roles, with the real migrations - is
 * tests/db/demo-payment-simulator.test.ts.
 */

const DEMO_CLINIC = { clinic_id: IDS.clinic, clinic_name: 'RecoverEase Defense Demo Clinic', clinic_status: 'active', clinic_timezone: 'Asia/Manila' }

const PLANS = [
  { plan_code: 'free', plan_name: 'Free', plan_price_centavos: 0, plan_billing_interval: 'forever', plan_sort_order: 1 },
  { plan_code: 'basic', plan_name: 'Basic', plan_price_centavos: 99900, plan_billing_interval: 'month', plan_sort_order: 2 },
  { plan_code: 'premium', plan_name: 'Premium', plan_price_centavos: 249900, plan_billing_interval: 'month', plan_sort_order: 3 },
  { plan_code: 'enterprise', plan_name: 'Enterprise', plan_price_centavos: null, plan_billing_interval: 'custom', plan_sort_order: 4 },
]

type LedgerRow = {
  payment_id: string
  reference: string
  plan_code: 'basic' | 'premium'
  plan_name: string
  amount_centavos: number
  method: 'qr_wallet' | 'card'
  status: 'paid' | 'failed' | 'cancelled'
  created_at: string
}

/** The stand-in database both roles read: demo payments and the clinic's plan. */
class Ledger {
  rows: LedgerRow[] = []
  plan: 'free' | 'basic' | 'premium' = 'free'
  seen = new Set<string>()
  sent: Record<string, unknown>[] = []

  simulate(args: Record<string, unknown>) {
    this.sent.push(args)
    const key = String(args['p_request_id']).replaceAll('-', '')
    const reference = `RE-${key.slice(0, 10).toUpperCase()}`
    const plan = args['p_plan_code'] as 'basic' | 'premium'
    const existing = this.rows.find((r) => r.reference === reference)
    const base = (row: LedgerRow, result: string) => ({
      result,
      payment_id: row.payment_id,
      reference: row.reference,
      status: row.status,
      plan_code: row.plan_code,
      plan_name: row.plan_name,
      amount_centavos: row.amount_centavos,
      method: row.method,
      period_end: this.plan === 'free' ? null : '2026-12-28T00:00:00Z',
    })
    if (existing) return base(existing, 'duplicate')
    const outcome = args['p_outcome'] as 'paid' | 'failed' | 'cancelled'
    const row: LedgerRow = {
      payment_id: `00000000-0000-4000-8000-${String(this.rows.length + 1).padStart(12, '0')}`,
      reference,
      plan_code: plan,
      plan_name: plan === 'basic' ? 'Basic' : 'Premium',
      amount_centavos: plan === 'basic' ? 99900 : 249900,
      method: args['p_method'] as 'qr_wallet' | 'card',
      status: outcome,
      created_at: new Date(Date.UTC(2026, 10, 28, 1, this.rows.length)).toISOString(),
    }
    this.rows.unshift(row)
    if (outcome === 'paid') this.plan = plan
    return base(row, outcome === 'paid' ? 'activated' : outcome)
  }

  /** What the Clinic Admin's RLS-filtered table reads return. */
  paymentRows() {
    return this.rows.map((r) => ({
      payment_id: r.payment_id,
      clinic_id: IDS.clinic,
      plan_name_snapshot: r.plan_name,
      payment_amount_centavos: r.amount_centavos,
      payment_status: r.status,
      payment_created_at: r.created_at,
      payment_paid_at: r.status === 'paid' ? r.created_at : null,
      payment_livemode: false,
      payment_provider: 'demo_simulator',
    }))
  }

  activity() {
    const paid = this.rows.filter((r) => r.status === 'paid')
    return {
      summary: {
        total: this.rows.length,
        paid: paid.length,
        failed: this.rows.filter((r) => r.status === 'failed').length,
        cancelled: this.rows.filter((r) => r.status === 'cancelled').length,
        pending: 0,
        demo_volume_centavos: paid.reduce((sum, r) => sum + r.amount_centavos, 0),
      },
      total_matching: this.rows.length,
      rows: this.rows.map((r) => ({
        payment_id: r.payment_id,
        reference: r.reference,
        clinic_id: IDS.clinic,
        clinic_name: DEMO_CLINIC.clinic_name,
        plan_code: r.plan_code,
        plan_name: r.plan_name,
        amount_centavos: r.amount_centavos,
        method: r.method,
        status: r.status,
        created_at: r.created_at,
        paid_at: r.status === 'paid' ? r.created_at : null,
      })),
      clinics: [{ clinic_id: IDS.clinic, clinic_name: DEMO_CLINIC.clinic_name }],
      page: 0,
      page_size: 10,
      generated_at: '2026-11-28T01:30:00Z',
    }
  }

  /** Two clinics: Harborview stays on Free; the demo clinic is on `plan`. Revenue is live payments only: none. */
  overview() {
    const count = (code: string) => (code === 'free' ? 1 : 0) + (this.plan === code ? 1 : 0)
    return {
      ...SUBSCRIPTION_OVERVIEW,
      total_subscribers: 2,
      plans: SUBSCRIPTION_OVERVIEW.plans.map((p) => ({ ...p, subscribers: count(p.code) })),
      revenue: { ...SUBSCRIPTION_OVERVIEW.revenue, lifetime_centavos: 0, this_month_centavos: 0, monthly: [], by_plan: [] },
    }
  }
}

/** The Defense Demo Clinic's Clinic Admin, writing to the ledger. */
async function asDemoClinicAdmin(signInAs: (role: 'admin', tables: Record<string, Record<string, unknown>[]>) => Promise<SupabaseStub>, ledger: Ledger) {
  const stub = await signInAs('admin', {
    clinic: [DEMO_CLINIC],
    subscription_plan: PLANS,
    clinic_subscription: [],
    subscription_payment: [],
  })
  stub.setRpcResult('demo_payment_simulator_available', true)
  stub.setRpcHandler('clinic_admin_simulate_demo_payment', (args) => {
    const result = ledger.simulate(args)
    sync()
    return { result }
  })
  const sync = () => {
    const payments = stub.rowsIn('subscription_payment')
    payments.splice(0, payments.length, ...ledger.paymentRows())
    const subs = stub.rowsIn('clinic_subscription')
    subs.splice(0, subs.length, {
      subscription_id: 'sub-1',
      clinic_id: IDS.clinic,
      plan_code: ledger.plan,
      subscription_status: 'active',
      subscription_period_start: '2026-11-28T00:00:00Z',
      subscription_period_end: ledger.plan === 'free' ? null : '2026-12-28T00:00:00Z',
      subscription_agreed_price_centavos: null,
    })
  }
  sync()
  return stub
}

/** A Super Admin in a browser session of their own, reading the same ledger. */
async function asSuperAdmin(browser: Browser, baseURL: string, ledger: Ledger) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  const stub = new SupabaseStub(platformDataset())
  await stub.install(page)
  stub.setRpcResult('super_admin_list_clinics', [])
  stub.setRpcHandler('super_admin_demo_payment_activity', () => ({ result: ledger.activity() }))
  stub.setRpcHandler('super_admin_subscription_overview', () => ({ result: ledger.overview() }))
  await stub.signInAs(page, {
    userId: IDS.superAdminUser,
    email: 'platform@recoverease.test',
    mustChangePassword: false,
    mfa: { verifiedFactor: true, aal: 'aal2' },
  })
  return { page, context }
}

async function pay(page: Page, plan: 'Basic' | 'Premium', method: 'QR / E-wallet' | 'Card', button: string) {
  await page.goto('/admin/settings')
  const card = page.getByRole('list', { name: 'Plans' }).getByRole('listitem').filter({ hasText: plan })
  await card.getByRole('link', { name: `Subscribe to ${plan}` }).click()
  await expect(page.getByRole('heading', { name: 'Pay RecoverEase' })).toBeVisible()
  await page.getByRole('radio', { name: new RegExp(`^${method.replace('/', '\\/')}`) }).click()
  await page.getByRole('button', { name: button }).click()
}

test.describe('the demo checkout, Clinic Admin to Super Admin', () => {
  for (const scenario of [
    { outcome: 'paid', plan: 'Basic', method: 'QR / E-wallet', button: 'Pay ₱999.00', status: 'Paid', basic: 1, free: 1 },
    { outcome: 'failed', plan: 'Basic', method: 'Card', button: 'Decline payment', status: 'Failed', basic: 0, free: 2 },
    { outcome: 'cancelled', plan: 'Premium', method: 'QR / E-wallet', button: 'Cancel payment', status: 'Cancelled', basic: 0, free: 2 },
  ] as const) {
    test(`${scenario.outcome}: the Clinic Admin's result is the Super Admin's record`, async ({ page, signInAs, browser, baseURL }) => {
      const ledger = new Ledger()
      await asDemoClinicAdmin(signInAs, ledger)
      await pay(page, scenario.plan, scenario.method, scenario.button)

      if (scenario.outcome === 'paid') {
        await expect(page.getByText('Your Basic plan is now active.')).toBeVisible()
        await page.screenshot({ path: 'test-results/demo-checkout-success.png', fullPage: true })
        await page.getByRole('link', { name: 'Back to Subscription' }).last().click()
        await expect(page.getByRole('list', { name: 'Plans' }).getByRole('listitem').filter({ hasText: 'Basic' })).toContainText('Current plan')
      } else if (scenario.outcome === 'failed') {
        await expect(page.getByText(/Your payment was declined/)).toBeVisible()
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
        await page.getByRole('link', { name: 'Back to Subscription' }).last().click()
      } else {
        await expect(page.getByText('Payment cancelled')).toBeVisible()
      }
      await expect(page).toHaveURL(/\/admin\/settings$/)
      const history = page.getByRole('list', { name: 'Recent payments' }).getByRole('listitem').first()
      await expect(history).toContainText(scenario.status)
      await expect(history.getByTestId('payment-mode')).toHaveText('Payment source: Simulated')

      // The browser sent the plan, method, outcome and request id - never an amount or a clinic.
      expect(ledger.sent).toHaveLength(1)
      expect(Object.keys(ledger.sent[0]!).sort()).toEqual(['p_method', 'p_outcome', 'p_plan_code', 'p_request_id'])

      await page.getByRole('button', { name: 'Sign out' }).first().click()
      await expect(page).toHaveURL(/\/sign-in/)

      const { page: platform, context } = await asSuperAdmin(browser, baseURL!, ledger)
      try {
        await platform.goto('/platform')
        await expect(platform.getByRole('heading', { name: 'Checkout Activity' })).toBeVisible()
        const row = platform.getByRole('list', { name: 'Checkout transactions' }).getByRole('listitem').first()
        await expect(row).toContainText(ledger.rows[0]!.reference)
        await expect(row).toContainText('RecoverEase Defense Demo Clinic')
        await expect(row).toContainText(scenario.plan)
        await expect(row).toContainText(scenario.plan === 'Basic' ? '₱999.00' : '₱2,499.00')
        await expect(row).toContainText(scenario.method)
        await expect(row).toContainText(scenario.status)
        await expect(row).toContainText('Simulated')

        const band = platform.getByLabel('Subscriptions and revenue')
        await expect(band).toContainText(`Basic subscribers${scenario.basic}`)
        await expect(band).toContainText(`Free subscribers${scenario.free}`)
        await expect(band).toContainText('Total revenue₱0.00')
        const summary = platform.getByLabel('Checkout summary')
        await expect(summary).toContainText(scenario.outcome === 'paid' ? '₱999.00' : '₱0.00')
        await platform.getByRole('heading', { name: 'Checkout Activity' }).scrollIntoViewIfNeeded()
        await platform.screenshot({ path: `test-results/demo-activity-${scenario.outcome}.png`, fullPage: true })
      } finally {
        await context.close()
      }
    })
  }
})

test.describe('the demo checkout page', () => {
  test('desktop: split layout; phone: stacked, no sideways scroll', async ({ page, signInAs }) => {
    const ledger = new Ledger()
    await asDemoClinicAdmin(signInAs, ledger)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/admin/settings/checkout?plan=basic')
    await expect(page.getByTestId('demo-qr')).toBeVisible()
    const summary = await page.getByRole('heading', { name: 'Pay RecoverEase' }).boundingBox()
    const method = await page.getByRole('heading', { name: 'Payment method' }).boundingBox()
    expect(method!.x).toBeGreaterThan(summary!.x + 200)
    await page.screenshot({ path: 'test-results/demo-checkout-desktop.png', fullPage: true })

    await page.getByRole('radio', { name: /^Card/ }).click()
    await expect(page.getByText('No card details required for this checkout')).toBeVisible()
    // Nowhere in the checkout can a card number, expiry or code be typed.
    expect(await page.getByTestId('demo-card-panel').locator('xpath=ancestor::div[contains(@class,"max-w-6xl")]').locator('input, textarea, select').count()).toBe(0)
    expect((await page.locator('main').innerText()).replaceAll('RecoverEase Defense Demo Clinic', '')).not.toMatch(/demo/i)
    await page.screenshot({ path: 'test-results/demo-checkout-card-desktop.png', fullPage: true })

    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('radio', { name: /^QR \/ E-wallet/ }).click()
    await expect(page.getByText('Simulated checkout · no real charge is made')).toBeVisible()
    const stackedSummary = await page.getByTestId('demo-total').boundingBox()
    const stackedMethod = await page.getByRole('heading', { name: 'Payment method' }).boundingBox()
    expect(stackedMethod!.y).toBeGreaterThan(stackedSummary!.y)
    const qr = await page.getByTestId('demo-qr').boundingBox()
    expect(qr!.x).toBeGreaterThanOrEqual(0)
    expect(qr!.x + qr!.width).toBeLessThanOrEqual(375)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const pay = await page.getByRole('button', { name: 'Pay ₱999.00' }).boundingBox()
    expect(pay!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: 'test-results/demo-checkout-mobile.png', fullPage: true })
  })

  test('the Harborview Clinic Admin is never offered it', async ({ page, signInAs }) => {
    const stub = await signInAs('admin', { subscription_plan: PLANS, subscription_payment: [] })
    stub.setRpcResult('demo_payment_simulator_available', false)
    await page.goto('/admin/settings')
    await expect(page.getByRole('list', { name: 'Plans' })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Subscribe to (Basic|Premium)/ })).toHaveCount(0)
    await page.goto('/admin/settings/checkout?plan=basic')
    await expect(page.getByText('Checkout is not available')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0)
  })

  test('the Super Admin section stays hidden until migration 70 exists', async ({ page, signInAs }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    stub.setRpcHandler('super_admin_demo_payment_activity', () => ({
      error: { code: 'PGRST202', message: 'Could not find the function' },
      status: 404,
    }))
    await page.goto('/platform')
    await expect(page.getByLabel('Subscriptions and revenue')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Checkout Activity' })).toHaveCount(0)
  })
})
