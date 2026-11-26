import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Subscriptions and revenue (migration 68): money formatting, the Super
 * Admin overview's parser and figures, and the Clinic Admin's plan section.
 * The data layer is replaced; tests/db/clinic-subscriptions.test.ts covers
 * what the database counts and allows, tests/unit/paymongo.test.ts the
 * Edge Functions.
 */

const billing = vi.hoisted(() => ({
  fetchClinicBilling: vi.fn(),
  chooseFreePlan: vi.fn(),
  startCheckout: vi.fn(),
  confirmCheckout: vi.fn(),
}))
const platform = vi.hoisted(() => ({ fetchSubscriptionOverview: vi.fn() }))

vi.mock('@/features/billing/api', () => billing)
vi.mock('@/features/platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/platform/api')>()),
  ...platform,
}))
vi.mock('@/features/auth/use-query-keys', async () => {
  const { queryKeysFor } = await import('@/lib/query-keys')
  return { useQueryKeys: () => queryKeysFor('user-1') }
})

const { formatCentavos, formatPlanPrice } = await import('@/lib/money')
const { parseSubscriptionOverview } = await import('@/features/platform/api')
const { SubscriptionOverviewSection, SUBSCRIPTION_REFRESH_MS } = await import(
  '@/features/platform/components/subscription-overview'
)
const { ClinicSubscriptionSection } = await import(
  '@/features/billing/components/clinic-subscription-section'
)

function renderWith(node: ReactNode, path = '/admin/settings') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const RAW = {
  total_subscribers: 4,
  plans: [
    { code: 'free', name: 'Free', price_centavos: 0, billing_interval: 'forever', subscribers: 1 },
    { code: 'basic', name: 'Basic', price_centavos: 99900, billing_interval: 'month', subscribers: 1 },
    { code: 'premium', name: 'Premium', price_centavos: 249900, billing_interval: 'month', subscribers: 1 },
    { code: 'enterprise', name: 'Enterprise', price_centavos: null, billing_interval: 'custom', subscribers: 1 },
  ],
  revenue: {
    currency: 'PHP',
    lifetime_centavos: 2099700,
    this_month_centavos: 349800,
    monthly: [
      { month: '2026-10', centavos: 1749900 },
      { month: '2026-11', centavos: 349800 },
    ],
    by_plan: [
      { code: 'basic', centavos: 99900 },
      { code: 'premium', centavos: 249900 },
      { code: 'enterprise', centavos: 1749900 },
    ],
  },
  generated_at: '2026-11-27T00:00:00Z',
}

describe('money', () => {
  it('formats centavos as pesos without rounding drift', () => {
    expect(formatCentavos(99900)).toBe('₱999.00')
    expect(formatCentavos(249900)).toBe('₱2,499.00')
    expect(formatCentavos(1)).toBe('₱0.01')
    expect(formatCentavos(0)).toBe('₱0.00')
    expect(() => formatCentavos(1.5)).toThrow()
  })

  it('writes each plan’s price, and never a price for Enterprise', () => {
    expect(formatPlanPrice({ priceCentavos: 0, billingInterval: 'forever' })).toBe('₱0 · free forever')
    expect(formatPlanPrice({ priceCentavos: 99900, billingInterval: 'month' })).toBe('₱999.00 / month')
    expect(formatPlanPrice({ priceCentavos: null, billingInterval: 'custom' })).toBe('Custom pricing')
  })
})

describe('parseSubscriptionOverview', () => {
  it('keeps exactly the figures', () => {
    const parsed = parseSubscriptionOverview({ ...RAW, extra: 'dropped' })
    expect(parsed.totalSubscribers).toBe(4)
    expect(parsed.plans[3]).toEqual({ code: 'enterprise', name: 'Enterprise', priceCentavos: null, billingInterval: 'custom', subscribers: 1 })
    expect(parsed.revenue.lifetimeCentavos).toBe(2099700)
    expect(JSON.stringify(parsed)).not.toContain('dropped')
  })

  it('refuses anything that is not counts', () => {
    expect(() => parseSubscriptionOverview(null)).toThrow()
    expect(() => parseSubscriptionOverview({ ...RAW, total_subscribers: -1 })).toThrow()
    expect(() => parseSubscriptionOverview({ ...RAW, plans: [{ ...RAW.plans[0], code: 'gold' }] })).toThrow()
    expect(() =>
      parseSubscriptionOverview({ ...RAW, revenue: { ...RAW.revenue, lifetime_centavos: 1.5 } }),
    ).toThrow()
    expect(() =>
      parseSubscriptionOverview({ ...RAW, revenue: { ...RAW.revenue, monthly: [{ month: 'Nov', centavos: 1 }] } }),
    ).toThrow()
  })
})

describe('the Super Admin’s subscriptions and revenue', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the six cards, the plans with prices, and revenue', async () => {
    platform.fetchSubscriptionOverview.mockResolvedValue(parseSubscriptionOverview(RAW))
    renderWith(<SubscriptionOverviewSection />)

    const band = await screen.findByLabelText('Subscriptions and revenue')
    for (const [label, value] of [
      ['Total subscribers', '4'],
      ['Free subscribers', '1'],
      ['Basic subscribers', '1'],
      ['Premium subscribers', '1'],
      ['Enterprise subscribers', '1'],
      ['Total revenue', '₱20,997.00'],
    ]) {
      const term = within(band).getByText(label)
      expect(term.parentElement).toHaveTextContent(value!)
    }
    expect(within(band).getByText('₱3,498.00 this month')).toBeInTheDocument()

    const plans = screen.getByRole('list', { name: 'Clinics per plan' })
    expect(within(plans).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Free · ₱0 · free forever1 clinic',
      'Basic · ₱999.00 / month1 clinic',
      'Premium · ₱2,499.00 / month1 clinic',
      'Enterprise · Custom pricing1 clinic',
    ])
    const byPlan = screen.getByRole('list', { name: 'Revenue by plan' })
    expect(within(byPlan).getByText('₱17,499.00')).toBeInTheDocument()
    const byMonth = screen.getByRole('list', { name: 'Revenue by month, last 12 months' })
    expect(within(byMonth).getByText('Nov 2026')).toBeInTheDocument()
  })

  it('says so when there is no revenue yet', async () => {
    platform.fetchSubscriptionOverview.mockResolvedValue(
      parseSubscriptionOverview({
        ...RAW,
        revenue: { ...RAW.revenue, lifetime_centavos: 0, this_month_centavos: 0, monthly: [], by_plan: [] },
      }),
    )
    renderWith(<SubscriptionOverviewSection />)
    expect(await screen.findByText(/No live payments yet/)).toBeInTheDocument()
    // Sandbox payments are never revenue (migration 69), and the page says so.
    expect(screen.getByText(/Sandbox \(test-mode\) payments are never counted/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Revenue by plan' })).toBeNull()
  })

  it('shows loading, then an error with a retry that works', async () => {
    platform.fetchSubscriptionOverview.mockRejectedValueOnce(new Error('The subscription overview could not be read.'))
    platform.fetchSubscriptionOverview.mockResolvedValueOnce(parseSubscriptionOverview(RAW))
    renderWith(<SubscriptionOverviewSection />)
    expect(screen.getByText('Loading subscriptions and revenue…')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }))
    expect(await screen.findByLabelText('Subscriptions and revenue')).toBeInTheDocument()
    expect(platform.fetchSubscriptionOverview).toHaveBeenCalledTimes(2)
  })

  it('reads the figures again every minute', async () => {
    expect(SUBSCRIPTION_REFRESH_MS).toBe(60_000)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      platform.fetchSubscriptionOverview.mockResolvedValue(parseSubscriptionOverview(RAW))
      renderWith(<SubscriptionOverviewSection />)
      await screen.findByLabelText('Subscriptions and revenue')
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_REFRESH_MS + 10)
      await waitFor(() => expect(platform.fetchSubscriptionOverview).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })
})

const PLANS = [
  { code: 'free', name: 'Free', priceCentavos: 0, billingInterval: 'forever' },
  { code: 'basic', name: 'Basic', priceCentavos: 99900, billingInterval: 'month' },
  { code: 'premium', name: 'Premium', priceCentavos: 249900, billingInterval: 'month' },
  { code: 'enterprise', name: 'Enterprise', priceCentavos: null, billingInterval: 'custom' },
]
const onFree = {
  plans: PLANS,
  current: { planCode: 'free', status: 'active', periodStart: '2026-10-01T00:00:00Z', periodEnd: null, agreedPriceCentavos: null },
  payments: [],
}
const PENDING = {
  paymentId: '0b4b4c1e-1111-4222-8333-444455556666',
  planName: 'Basic',
  amountCentavos: 99900,
  status: 'pending',
  createdAt: '2026-11-27T00:00:00Z',
  paidAt: null,
}

describe('the Clinic Admin’s plan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the four plans, the current one, and the paid choices', async () => {
    billing.fetchClinicBilling.mockResolvedValue(onFree)
    renderWith(<ClinicSubscriptionSection />)
    const plans = await screen.findByRole('list', { name: 'Plans' })
    expect(within(plans).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Free', 'Basic', 'Premium', 'Enterprise'])
    expect(within(plans).getByText('₱999.00 / month')).toBeInTheDocument()
    expect(within(plans).getByText('₱2,499.00 / month')).toBeInTheDocument()
    expect(within(plans).getByText('Custom pricing')).toBeInTheDocument()
    expect(within(plans).getByText('Current plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Subscribe to Basic' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Subscribe to Premium' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Enterprise/ })).toBeNull()
  })

  it('starts a checkout with the plan name only', async () => {
    billing.fetchClinicBilling.mockResolvedValue(onFree)
    billing.startCheckout.mockRejectedValue(new Error('Online payment is not set up yet'))
    renderWith(<ClinicSubscriptionSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe to Premium' }))
    expect(billing.startCheckout).toHaveBeenCalledWith('premium', expect.anything())
    expect(await screen.findByRole('alert')).toHaveTextContent('Online payment is not set up yet')
  })

  it('a pending payment is shown and checked again until PayMongo answers', async () => {
    billing.fetchClinicBilling.mockResolvedValue({ ...onFree, payments: [PENDING] })
    renderWith(<ClinicSubscriptionSection />)
    expect(await screen.findByText(/Waiting for PayMongo to confirm your Basic payment/)).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it.each([
    ['success', 'check', 'paid', 'Payment successful'],
    ['success', 'check', 'failed', 'Payment failed'],
    ['cancelled', 'cancel', 'cancelled', 'Payment cancelled'],
    ['success', 'check', 'pending', 'PayMongo has not confirmed the payment yet. This page updates on its own.'],
  ] as const)('back from PayMongo (%s): asks the server, which says %s → %s', async (param, action, status, title) => {
    billing.fetchClinicBilling.mockResolvedValue({ ...onFree, payments: [PENDING] })
    billing.confirmCheckout.mockResolvedValue(status)
    renderWith(<ClinicSubscriptionSection />, `/admin/settings?billing=${param}`)
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(billing.confirmCheckout).toHaveBeenCalledTimes(1)
    expect(billing.confirmCheckout).toHaveBeenCalledWith(action, PENDING.paymentId)
  })

  it('moving off a paid plan to Free asks first and warns', async () => {
    billing.fetchClinicBilling.mockResolvedValue({
      ...onFree,
      current: { ...onFree.current, planCode: 'premium', periodEnd: '2026-12-27T00:00:00Z' },
    })
    billing.chooseFreePlan.mockResolvedValue(undefined)
    renderWith(<ClinicSubscriptionSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Free' }))
    expect(screen.getByText(/given up and not refunded/)).toBeInTheDocument()
    expect(billing.chooseFreePlan).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, switch to Free' }))
    await waitFor(() => expect(billing.chooseFreePlan).toHaveBeenCalledTimes(1))
  })

  it('shows the error state with a retry', async () => {
    billing.fetchClinicBilling.mockRejectedValueOnce(new Error('boom'))
    billing.fetchClinicBilling.mockResolvedValueOnce(onFree)
    renderWith(<ClinicSubscriptionSection />)
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('list', { name: 'Plans' })).toBeInTheDocument()
  })
})
