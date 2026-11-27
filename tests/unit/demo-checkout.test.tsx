import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The internal demo payment simulator (migration 70): the Clinic Admin's
 * demo checkout, the Subscription page's demo button and badge, and the
 * Super Admin's Demo Payment Activity. The data layer is replaced here;
 * tests/db/demo-payment-simulator.test.ts covers what the database allows,
 * records and counts, end to end across both roles.
 */

const billing = vi.hoisted(() => ({
  fetchClinicBilling: vi.fn(),
  chooseFreePlan: vi.fn(),
  startCheckout: vi.fn(),
  confirmCheckout: vi.fn(),
  fetchDemoCheckoutAvailable: vi.fn(),
  fetchOwnClinicName: vi.fn(),
  simulateDemoPayment: vi.fn(),
}))
const switches = vi.hoisted(() => ({ demo: true, paymongo: false }))

vi.mock('@/features/billing/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/billing/api')>()),
  ...billing,
}))
vi.mock('@/features/billing/availability', () => ({
  isOnlineCheckoutEnabled: () => switches.paymongo,
  isDemoPaymentSimulatorEnabled: () => switches.demo,
}))
vi.mock('@/features/auth/use-query-keys', async () => {
  const { queryKeysFor } = await import('@/lib/query-keys')
  return { useQueryKeys: () => queryKeysFor('user-1') }
})

const { demoReference, parseDemoPaymentResult } = await import('@/features/billing/api')
const { DemoCheckoutPage } = await import('@/features/billing/demo-checkout/demo-checkout-page')
const { DEMO_QR_MODULES } = await import('@/features/billing/demo-checkout/demo-qr-graphic')
const { ClinicSubscriptionSection } = await import('@/features/billing/components/clinic-subscription-section')
const { DemoActivity } = await import('@/features/platform/components/demo-payment-activity')
const { parseDemoPaymentActivity } = await import('@/features/platform/api')

const PLANS = [
  { code: 'free', name: 'Free', priceCentavos: 0, billingInterval: 'forever' },
  { code: 'basic', name: 'Basic', priceCentavos: 99900, billingInterval: 'month' },
  { code: 'premium', name: 'Premium', priceCentavos: 249900, billingInterval: 'month' },
  { code: 'enterprise', name: 'Enterprise', priceCentavos: null, billingInterval: 'custom' },
]
const onFree = {
  plans: PLANS,
  current: { planCode: 'free', status: 'active', periodStart: '2026-11-27T00:00:00Z', periodEnd: null, agreedPriceCentavos: null },
  payments: [],
}

function LocationProbe() {
  const location = useLocation()
  return (
    <p data-testid="location">
      {location.pathname}|{JSON.stringify(location.state)}
    </p>
  )
}

function renderAt(path: string, node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/settings/checkout" element={node} />
          <Route path="/admin/settings" element={<><LocationProbe /><ClinicSubscriptionSection /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const result = (overrides: Record<string, unknown> = {}) => ({
  result: 'activated',
  paymentId: 'p-1',
  reference: 'RE-ABCDEF0123',
  status: 'paid',
  planCode: 'basic',
  planName: 'Basic',
  amountCentavos: 99900,
  method: 'qr_wallet',
  periodEnd: '2026-12-28T00:00:00Z',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  switches.demo = true
  switches.paymongo = false
  billing.fetchClinicBilling.mockResolvedValue(onFree)
  billing.fetchDemoCheckoutAvailable.mockResolvedValue(true)
  billing.fetchOwnClinicName.mockResolvedValue('RecoverEase Defense Demo Clinic')
})

describe('the demo reference', () => {
  it('is derived from the request id exactly as the database derives it', () => {
    expect(demoReference('0b4b4c1e-1111-4222-8333-444455556666')).toBe('RE-0B4B4C1E11')
  })

  it('parses only a well-formed demo result', () => {
    const raw = { result: 'activated', payment_id: 'p', reference: 'RE-X', status: 'paid', plan_code: 'basic', plan_name: 'Basic', amount_centavos: 99900, method: 'card', period_end: null }
    expect(parseDemoPaymentResult(raw)).toMatchObject({ planCode: 'basic', method: 'card' })
    expect(() => parseDemoPaymentResult({ ...raw, method: 'gcash' })).toThrow()
    expect(() => parseDemoPaymentResult({ ...raw, plan_code: 'enterprise' })).toThrow()
    expect(() => parseDemoPaymentResult(null)).toThrow()
  })
})

describe('the demo checkout page', () => {
  it('shows the plan, the clinic and the database price, with no demo wording', async () => {
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    expect(await screen.findByRole('heading', { name: 'Pay RecoverEase' })).toBeInTheDocument()
    // One plain line says no money moves; nothing on the page says "demo".
    expect(screen.getByText(/Simulated checkout · no real charge is made/)).toBeInTheDocument()
    // The clinic's own name is data, not wording.
    expect(document.body.textContent!.replaceAll('RecoverEase Defense Demo Clinic', '')).not.toMatch(/demo/i)
    expect(screen.getByTestId('demo-total')).toHaveTextContent('₱999.00')
    expect(screen.getByText('Basic Plan')).toBeInTheDocument()
    expect(screen.getAllByText('RecoverEase Defense Demo Clinic').length).toBeGreaterThan(0)
  })

  it('opens on QR / E-wallet with a non-scannable graphic and neutral chips', async () => {
    renderAt('/admin/settings/checkout?plan=premium', <DemoCheckoutPage />)
    const qrPanel = await screen.findByTestId('demo-qr-panel')
    expect(screen.getByRole('radio', { name: /QR \/ E-wallet/ })).toHaveAttribute('aria-checked', 'true')
    const qr = within(qrPanel).getByTestId('demo-qr')
    // Real QR codes are 21 + 4n modules a side; the graphic is not.
    expect(Number(qr.getAttribute('data-modules'))).toBe(DEMO_QR_MODULES)
    expect((DEMO_QR_MODULES - 21) % 4).not.toBe(0)
    expect(qr).toHaveAccessibleName(/cannot be scanned/)
    const chips = within(qrPanel).getByRole('list', { name: 'Ways to pay' })
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['E-wallet', 'Mobile banking', 'Bank transfer', 'Card'])
    expect(qrPanel).toHaveTextContent('₱2,499.00')
    expect(within(qrPanel).getByTestId('demo-reference').textContent).toMatch(/^RE-[0-9A-F]{10}$/)
  })

  it('switches to Card, which collects no card details at all', async () => {
    const user = userEvent.setup()
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    await user.click(await screen.findByRole('radio', { name: /^Card/ }))
    const card = screen.getByTestId('demo-card-panel')
    expect(within(card).getByText('No card details required for this checkout')).toBeInTheDocument()
    expect(within(card).queryAllByRole('textbox')).toHaveLength(0)
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
  })

  it('moves between the two methods with the arrow keys', async () => {
    const user = userEvent.setup()
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    const qr = await screen.findByRole('radio', { name: /QR \/ E-wallet/ })
    qr.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: /^Card/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /^Card/ })).toHaveFocus()
  })

  it('simulates a successful payment, sending only plan, method, outcome and request id', async () => {
    const user = userEvent.setup()
    billing.simulateDemoPayment.mockResolvedValue(result())
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    const pay = await screen.findByRole('button', { name: 'Pay ₱999.00' })
    await user.click(pay)
    await user.click(pay)
    const success = await screen.findByTestId('demo-result-success', {}, { timeout: 3000 })
    expect(billing.simulateDemoPayment).toHaveBeenCalledTimes(1)
    const sent = billing.simulateDemoPayment.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['method', 'outcome', 'plan', 'requestId'])
    expect(sent).toMatchObject({ plan: 'basic', method: 'qr_wallet', outcome: 'paid' })
    expect(within(success).getByText('Your Basic plan is now active.')).toBeInTheDocument()
    expect(within(success).getByTestId('demo-result-reference')).toHaveTextContent('RE-ABCDEF0123')
    expect(within(success).getByRole('link', { name: 'Back to Subscription' })).toHaveAttribute('href', '/admin/settings')
  })

  it('simulates a failed payment and tries again with a new request id', async () => {
    const user = userEvent.setup()
    billing.simulateDemoPayment.mockResolvedValue(result({ result: 'failed', status: 'failed', method: 'card', periodEnd: null }))
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    await user.click(await screen.findByRole('radio', { name: /^Card/ }))
    await user.click(screen.getByRole('button', { name: 'Decline payment' }))
    const failed = await screen.findByTestId('demo-result-failed', {}, { timeout: 3000 })
    expect(failed).toHaveTextContent('Your payment was declined. Your plan has not changed')
    await user.click(within(failed).getByRole('button', { name: 'Try again' }))
    await user.click(await screen.findByRole('button', { name: 'Decline payment' }))
    await waitFor(() => expect(billing.simulateDemoPayment).toHaveBeenCalledTimes(2), { timeout: 3000 })
    const [first, second] = billing.simulateDemoPayment.mock.calls.map((c) => (c[0] as { requestId: string }).requestId)
    expect(first).not.toBe(second)
  })

  it('cancels, returns to Subscription and says so there', async () => {
    const user = userEvent.setup()
    billing.simulateDemoPayment.mockResolvedValue(result({ result: 'cancelled', status: 'cancelled', periodEnd: null }))
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    await user.click(await screen.findByRole('button', { name: 'Cancel payment' }))
    expect(await screen.findByText('Payment cancelled', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/Checkout RE-ABCDEF0123 was cancelled. Nothing was charged/)).toBeInTheDocument()
    expect(billing.simulateDemoPayment.mock.calls[0]![0]).toMatchObject({ outcome: 'cancelled' })
  })

  it('shows the database’s refusal and records nothing more', async () => {
    const user = userEvent.setup()
    billing.simulateDemoPayment.mockRejectedValue(new Error('The demo checkout is only for the Clinic Admin of a clinic it is enabled for'))
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    await user.click(await screen.findByRole('button', { name: 'Pay ₱999.00' }))
    expect(await screen.findByText(/only for the Clinic Admin/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByTestId('demo-result-success')).toBeNull()
  })

  it('is not offered where the database says no (Harborview), or when the build is off', async () => {
    billing.fetchDemoCheckoutAvailable.mockResolvedValue(false)
    const { unmount } = renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    expect(await screen.findByText('Checkout is not available')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
    unmount()

    switches.demo = false
    renderAt('/admin/settings/checkout?plan=basic', <DemoCheckoutPage />)
    expect(await screen.findByText('Checkout is not available')).toBeInTheDocument()
    expect(billing.fetchDemoCheckoutAvailable).toHaveBeenCalledTimes(1)
  })

  it('asks for Basic or Premium when the plan is anything else', async () => {
    renderAt('/admin/settings/checkout?plan=enterprise', <DemoCheckoutPage />)
    expect(await screen.findByText('Choose a plan')).toBeInTheDocument()
  })
})

describe('the Subscription page with the simulator', () => {
  it('offers Subscribe on Basic and Premium only, where the database allows it', async () => {
    renderAt('/admin/settings', null)
    const links = await screen.findAllByRole('link', { name: /^Subscribe to/ })
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/admin/settings/checkout?plan=basic',
      '/admin/settings/checkout?plan=premium',
    ])
    expect(screen.queryByText(/Online payment is not available yet/)).toBeNull()
  })

  it('shows nothing of the simulator to a clinic the database does not allow', async () => {
    billing.fetchDemoCheckoutAvailable.mockResolvedValue(false)
    renderAt('/admin/settings', null)
    expect((await screen.findAllByText(/Online payment is not available yet/)).length).toBe(2)
    expect(screen.queryByRole('link', { name: /^Subscribe to/ })).toBeNull()
  })

  it('labels simulated payments Simulated, never Sandbox or Live', async () => {
    billing.fetchClinicBilling.mockResolvedValue({
      ...onFree,
      payments: [
        { paymentId: 'a', planName: 'Basic', amountCentavos: 99900, status: 'paid', createdAt: '2026-11-28T00:00:00Z', paidAt: '2026-11-28T00:00:00Z', livemode: false, source: 'demo_simulator' },
        { paymentId: 'b', planName: 'Basic', amountCentavos: 99900, status: 'failed', createdAt: '2026-11-28T00:00:00Z', paidAt: null, livemode: false, source: 'paymongo' },
      ],
    })
    renderAt('/admin/settings', null)
    const list = await screen.findByRole('list', { name: 'Recent payments' })
    const modes = within(list).getAllByTestId('payment-mode').map((m) => m.textContent)
    expect(modes).toEqual(['Payment source: Simulated', 'Payment mode: Sandbox'])
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Paid')
  })
})

const ACTIVITY = {
  summary: { total: 3, paid: 1, failed: 1, cancelled: 1, pending: 0, demo_volume_centavos: 99900 },
  total_matching: 3,
  rows: [
    { payment_id: '1', reference: 'RE-AAAAAAAAAA', clinic_id: 'c1', clinic_name: 'RecoverEase Defense Demo Clinic', plan_code: 'basic', plan_name: 'Basic', amount_centavos: 99900, method: 'qr_wallet', status: 'paid', created_at: '2026-11-28T01:00:00Z', paid_at: '2026-11-28T01:00:00Z' },
    { payment_id: '2', reference: 'RE-BBBBBBBBBB', clinic_id: 'c1', clinic_name: 'RecoverEase Defense Demo Clinic', plan_code: 'premium', plan_name: 'Premium', amount_centavos: 249900, method: 'card', status: 'failed', created_at: '2026-11-28T00:30:00Z', paid_at: null },
    { payment_id: '3', reference: 'RE-CCCCCCCCCC', clinic_id: 'c1', clinic_name: 'RecoverEase Defense Demo Clinic', plan_code: 'basic', plan_name: 'Basic', amount_centavos: 99900, method: 'card', status: 'cancelled', created_at: '2026-11-28T00:00:00Z', paid_at: null },
  ],
  clinics: [{ clinic_id: 'c1', clinic_name: 'RecoverEase Defense Demo Clinic' }],
  page: 0,
  page_size: 10,
  generated_at: '2026-11-28T01:00:05Z',
}

describe('the Super Admin’s Demo Payment Activity', () => {
  const NONE = { clinicId: null, status: null, method: null, from: null, to: null, page: 0 }

  it('parses only well-formed activity, and never keeps unknown fields', () => {
    const parsed = parseDemoPaymentActivity({ ...ACTIVITY, extra: 'x' })
    expect(parsed.summary.demoVolumeCentavos).toBe(99900)
    expect(parsed.rows[1]).toMatchObject({ method: 'card', status: 'failed', planName: 'Premium' })
    expect(JSON.stringify(parsed)).not.toContain('"x"')
    expect(() => parseDemoPaymentActivity({ ...ACTIVITY, rows: [{ ...ACTIVITY.rows[0], method: 'gcash' }] })).toThrow()
    expect(() => parseDemoPaymentActivity({ ...ACTIVITY, summary: { ...ACTIVITY.summary, total: -1 } })).toThrow()
  })

  it('shows each transaction, the summary and demo volume apart from revenue', () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <DemoActivity activity={parseDemoPaymentActivity(ACTIVITY)} filters={NONE} onFilters={() => {}} />
      </QueryClientProvider>,
    )
    const summary = screen.getByLabelText('Checkout summary')
    expect(summary).toHaveTextContent('Transactions')
    expect(summary).toHaveTextContent('Checkout volume')
    expect(summary).toHaveTextContent('₱999.00')
    expect(summary).toHaveTextContent('Not counted in revenue')
    const rows = within(screen.getByRole('list', { name: 'Checkout transactions' })).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('RE-AAAAAAAAAA')
    expect(rows[0]).toHaveTextContent('RecoverEase Defense Demo Clinic')
    expect(rows[0]).toHaveTextContent('Basic · ₱999.00')
    expect(rows[0]).toHaveTextContent('QR / E-wallet')
    expect(rows[0]).toHaveTextContent('Paid')
    expect(rows[0]).toHaveTextContent('Simulated')
    expect(rows[1]).toHaveTextContent('Card')
    expect(rows[1]).toHaveTextContent('Failed')
    expect(rows[2]).toHaveTextContent('Cancelled')
  })

  it('filters by clinic, status, method and date', async () => {
    const user = userEvent.setup()
    const onFilters = vi.fn()
    render(<DemoActivity activity={parseDemoPaymentActivity(ACTIVITY)} filters={NONE} onFilters={onFilters} />)
    await user.selectOptions(screen.getByLabelText('Status'), 'failed')
    expect(onFilters).toHaveBeenLastCalledWith({ ...NONE, status: 'failed' })
    await user.selectOptions(screen.getByLabelText('Method'), 'card')
    expect(onFilters).toHaveBeenLastCalledWith({ ...NONE, method: 'card' })
    await user.selectOptions(screen.getByLabelText('Clinic'), 'c1')
    expect(onFilters).toHaveBeenLastCalledWith({ ...NONE, clinicId: 'c1' })
    await user.type(screen.getByLabelText('From'), '2026-11-28')
    expect(onFilters).toHaveBeenLastCalledWith({ ...NONE, from: '2026-11-28' })
  })

  it('pages through more than one page', async () => {
    const user = userEvent.setup()
    const onFilters = vi.fn()
    render(<DemoActivity activity={parseDemoPaymentActivity({ ...ACTIVITY, total_matching: 25 })} filters={NONE} onFilters={onFilters} />)
    expect(screen.getByText('1–10 of 25')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onFilters).toHaveBeenLastCalledWith({ ...NONE, page: 1 })
  })
})
