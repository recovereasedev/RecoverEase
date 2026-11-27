import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Landmark,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { LoadingState } from '@/components/feedback/state-view'
import { BrandMark } from '@/components/layout/brand'
import { Button, buttonVariants } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  demoReference,
  fetchClinicBilling,
  fetchDemoCheckoutAvailable,
  fetchOwnClinicName,
  simulateDemoPayment,
  type DemoMethod,
  type DemoOutcome,
  type DemoPaymentResult,
} from '@/features/billing/api'
import { isDemoPaymentSimulatorEnabled } from '@/features/billing/availability'
import { DemoQrGraphic } from '@/features/billing/demo-checkout/demo-qr-graphic'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDate } from '@/lib/format'
import { formatCentavos } from '@/lib/money'
import { cn } from '@/lib/utils'

export const SUBSCRIPTION_PATH = '/admin/settings'

/** A short pause so the processing state is seen; the result is the database's. */
export const DEMO_PROCESSING_MS = 900

const METHOD_LABEL: Record<DemoMethod, string> = {
  qr_wallet: 'QR / E-wallet',
  card: 'Card',
}

type PaidPlan = 'basic' | 'premium'
const isPaidPlan = (value: string | null): value is PaidPlan => value === 'basic' || value === 'premium'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * RecoverEase Demo Checkout — Simulation Only (migration 70).
 *
 * A RecoverEase-only checkout for the capstone demonstration. Nothing here
 * talks to a payment provider: there is no card field, the QR graphic cannot
 * be scanned, and the outcome is chosen by the presenter. What it records is
 * real: `clinic_admin_simulate_demo_payment` writes a demo payment row (never
 * live, never revenue) and, when paid, moves the clinic's subscription.
 *
 * The browser sends only the plan name, the demo screen, the outcome and
 * this checkout's request id. The same request id again changes nothing, so
 * a double press cannot pay twice; "Try again" starts a new checkout.
 */
export function DemoCheckoutPage() {
  useDocumentTitle('Checkout')
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const planParam = searchParams.get('plan')
  const plan = isPaidPlan(planParam) ? planParam : null

  const [method, setMethod] = useState<DemoMethod>('qr_wallet')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [result, setResult] = useState<DemoPaymentResult | null>(null)
  const inFlight = useRef(false)

  const enabled = isDemoPaymentSimulatorEnabled()
  const available = useQuery({
    queryKey: queryKeys.admin.demoCheckout(),
    queryFn: fetchDemoCheckoutAvailable,
    enabled,
  })
  const billing = useQuery({ queryKey: queryKeys.admin.subscription(), queryFn: fetchClinicBilling, enabled })
  const clinicName = useQuery({ queryKey: [...queryKeys.admin.demoCheckout(), 'clinic-name'], queryFn: fetchOwnClinicName, enabled })

  const simulate = useMutation({
    mutationFn: async (outcome: DemoOutcome) => {
      if (!plan) throw new Error('Choose Basic or Premium first.')
      const [answer] = await Promise.all([
        simulateDemoPayment({ plan, method, outcome, requestId }),
        wait(DEMO_PROCESSING_MS),
      ])
      return answer
    },
    onSuccess: (answer, outcome) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.subscription() })
      if (outcome === 'cancelled' || answer.status === 'cancelled') {
        navigate(SUBSCRIPTION_PATH, { state: { demoCancelled: answer.reference } })
        return
      }
      setResult(answer)
    },
    onSettled: () => {
      inFlight.current = false
    },
  })

  const run = (outcome: DemoOutcome) => {
    if (inFlight.current || simulate.isPending) return
    inFlight.current = true
    simulate.mutate(outcome)
  }

  const tryAgain = () => {
    setResult(null)
    simulate.reset()
    setRequestId(crypto.randomUUID())
  }

  const back = (
    <Link to={SUBSCRIPTION_PATH} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-3')}>
      <ArrowLeft aria-hidden="true" />
      Back to Subscription
    </Link>
  )

  if (!enabled || available.data === false || available.isError) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {back}
        <Notice tone="info" title="Checkout is not available">
          Online checkout is not enabled for your clinic. Your plan has not changed.
        </Notice>
      </div>
    )
  }
  if (!plan) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {back}
        <Notice tone="info" title="Choose a plan">Open the checkout from Basic or Premium on your Subscription page.</Notice>
      </div>
    )
  }
  if (available.isPending || billing.isPending || clinicName.isPending) {
    return <LoadingState label="Opening the checkout…" />
  }
  if (billing.isError) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {back}
        <Notice tone="danger">{billing.error.message}</Notice>
      </div>
    )
  }

  const planRow = billing.data.plans.find((p) => p.code === plan)
  if (!planRow || planRow.priceCentavos === null) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {back}
        <Notice tone="danger">That plan has no price. Nothing was recorded.</Notice>
      </div>
    )
  }

  const amount = planRow.priceCentavos
  const reference = demoReference(requestId)
  const clinic = clinicName.data ?? 'Your clinic'
  const currentPlan = billing.data.current?.planCode
  // Once a result is shown the plan may already be the one just paid for;
  // the summary keeps describing the checkout as it was opened.
  const isRenewal = currentPlan === plan && !result
  const busy = simulate.isPending

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3">{back}</div>

      <div className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-surface shadow-[var(--shadow-sm)] lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <OrderSummary
          planName={planRow.name}
          amount={amount}
          clinic={clinic}
          isRenewal={isRenewal}
        />

        <section
          aria-labelledby="demo-payment-heading"
          className="border-t border-[var(--color-border)] p-5 sm:p-8 lg:border-t-0 lg:border-l"
        >
          {result ? (
            <ResultPanel result={result} clinic={clinic} onTryAgain={tryAgain} />
          ) : (
            <>
              <h2 id="demo-payment-heading" className="text-lg font-semibold text-heading">
                Payment method
              </h2>
              <MethodPicker value={method} onChange={setMethod} disabled={busy} />

              <div className="mt-5">
                {method === 'qr_wallet' ? (
                  <QrWalletPanel planName={planRow.name} amount={amount} reference={reference} />
                ) : (
                  <CardPanel planName={planRow.name} amount={amount} clinic={clinic} reference={reference} />
                )}
              </div>

              {simulate.isError ? (
                <Notice tone="danger" live="assertive" className="mt-4">
                  {simulate.error.message}
                </Notice>
              ) : null}

              <div className="mt-6 space-y-2.5" aria-live="polite">
                {busy ? (
                  <p className="text-center text-sm text-muted" role="status">
                    Processing your payment…
                  </p>
                ) : null}
                <Button
                  block
                  size="lg"
                  isLoading={busy && simulate.variables === 'paid'}
                  loadingLabel="Processing your payment…"
                  disabled={busy}
                  onClick={() => run('paid')}
                >
                  Pay {formatCentavos(amount)}
                </Button>
                <Button
                  block
                  variant="outline"
                  isLoading={busy && simulate.variables === 'failed'}
                  loadingLabel="Processing your payment…"
                  disabled={busy}
                  onClick={() => run('failed')}
                >
                  Decline payment
                </Button>
                <Button
                  block
                  variant="ghost"
                  isLoading={busy && simulate.variables === 'cancelled'}
                  loadingLabel="Cancelling…"
                  disabled={busy}
                  onClick={() => run('cancelled')}
                >
                  Cancel payment
                </Button>
              </div>

              <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Simulated checkout · no real charge is made
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  )
}


function OrderSummary(props: { planName: string; amount: number; clinic: string; isRenewal: boolean }) {
  return (
    <section aria-labelledby="demo-summary-heading" className="bg-canvas p-5 sm:p-8">
      <div className="flex items-center gap-2.5">
        <BrandMark className="size-8" />
        <span className="text-base font-semibold text-heading">RecoverEase</span>
      </div>

      <h1 id="demo-summary-heading" className="mt-6 text-sm font-medium text-muted">
        Pay RecoverEase
      </h1>
      <p className="mt-1 text-4xl font-semibold tracking-tight text-heading" data-numeric data-testid="demo-total">
        {formatCentavos(props.amount)}
      </p>
      <p className="mt-1 text-sm text-muted">per month</p>

      <dl className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)] text-sm">
        <div className="flex items-start justify-between gap-4 py-3">
          <dt>
            <span className="block font-medium text-heading">{props.planName} Plan</span>
            <span className="block text-muted">
              {props.isRenewal ? 'One more month on your current plan' : 'Monthly billing period'}
            </span>
          </dt>
          <dd className="font-medium text-heading" data-numeric>{formatCentavos(props.amount)} / month</dd>
        </div>
        <div className="flex items-start justify-between gap-4 py-3">
          <dt className="text-muted">Clinic</dt>
          <dd className="text-right font-medium text-heading">{props.clinic}</dd>
        </div>
        <div className="flex items-start justify-between gap-4 py-3">
          <dt className="text-muted">Billing period</dt>
          <dd className="text-right text-heading">1 month</dd>
        </div>
        <div className="flex items-start justify-between gap-4 py-3">
          <dt className="font-semibold text-heading">Total due</dt>
          <dd className="text-base font-semibold text-heading" data-numeric>{formatCentavos(props.amount)}</dd>
        </div>
      </dl>

    </section>
  )
}

function MethodPicker(props: { value: DemoMethod; onChange: (m: DemoMethod) => void; disabled: boolean }) {
  const options: { value: DemoMethod; icon: LucideIcon; hint: string }[] = [
    { value: 'qr_wallet', icon: QrCode, hint: 'Scan to pay' },
    { value: 'card', icon: CreditCard, hint: 'Credit or debit card' },
  ]
  return (
    <div role="radiogroup" aria-label="Payment method" className="mt-3 grid gap-2.5 sm:grid-cols-2">
      {options.map(({ value, icon: Icon, hint }) => {
        const selected = props.value === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={props.disabled}
            onClick={() => props.onChange(value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                props.onChange(value === 'qr_wallet' ? 'card' : 'qr_wallet')
                const sibling = (event.currentTarget.parentElement?.querySelector(`[aria-checked="false"]`) as HTMLElement | null)
                sibling?.focus()
              }
            }}
            tabIndex={selected ? 0 : -1}
            className={cn(
              'flex min-h-16 items-center gap-3 rounded-[var(--radius-lg)] border bg-surface px-3 py-2.5 text-left transition-colors disabled:opacity-60',
              selected
                ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                : 'border-[var(--color-border-strong)] hover:border-neutral-400',
            )}
          >
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)]',
                selected ? 'bg-brand-600 text-white' : 'bg-[var(--color-surface-raised)] text-brand-700',
              )}
              aria-hidden="true"
            >
              <Icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-heading">{METHOD_LABEL[value]}</span>
              <span className="block text-xs text-muted">{hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

const CHIPS: { label: string; icon: LucideIcon }[] = [
  { label: 'E-wallet', icon: Wallet },
  { label: 'Mobile banking', icon: Smartphone },
  { label: 'Bank transfer', icon: Landmark },
  { label: 'Card', icon: CreditCard },
]

function QrWalletPanel(props: { planName: string; amount: number; reference: string }) {
  return (
    <div data-testid="demo-qr-panel">
      <div className="mx-auto w-full max-w-[19rem] rounded-[1.75rem] border border-[var(--color-border)] bg-surface p-5 shadow-[var(--shadow-lg)]">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-heading">
            <BrandMark className="size-5" />
            RecoverEase
          </span>
        </div>
        <p className="mt-3 text-center text-lg font-semibold text-heading">Scan to pay</p>
        <DemoQrGraphic seed={props.reference} className="mx-auto mt-3 w-full max-w-[13rem]" />
        <p className="mt-3 text-center text-base font-semibold text-heading" data-numeric>
          {formatCentavos(props.amount)}
        </p>
        <p className="text-center text-sm text-muted">{props.planName} Plan · RecoverEase</p>
        <p className="mt-2 text-center text-xs text-muted">
          Reference <span className="font-mono text-body" data-testid="demo-reference">{props.reference}</span>
        </p>
      </div>

      <div className="mt-5">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Pay from</p>
        <ul aria-label="Ways to pay" className="mt-2 flex flex-wrap gap-2">
          {CHIPS.map(({ label, icon: Icon }) => (
            <li
              key={label}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-surface px-3 py-1.5 text-sm text-body"
            >
              <Icon className="size-4 text-brand-700" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function CardPanel(props: { planName: string; amount: number; clinic: string; reference: string }) {
  return (
    <div data-testid="demo-card-panel" className="space-y-4">
      <div>
        <p className="text-sm font-medium text-heading">Card information</p>
        <div
          className="mt-1.5 flex min-h-12 items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-sunken)] px-3 py-2.5"
          data-testid="demo-card-placeholder"
        >
          <CreditCard className="size-5 shrink-0 text-brand-700" aria-hidden="true" />
          <span className="text-sm text-body">No card details required for this checkout</span>
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)]">
        <p className="border-b border-[var(--color-border)] px-4 py-2.5 text-sm font-medium text-heading">Billing summary</p>
        <dl className="space-y-2 px-4 py-3 text-sm">
          <Row label="Plan" value={`${props.planName} · monthly`} />
          <Row label="Clinic" value={props.clinic} />
          <Row label="Reference" value={<span className="font-mono" data-testid="demo-reference">{props.reference}</span>} />
          <Row label="Total" value={<span className="font-semibold text-heading" data-numeric>{formatCentavos(props.amount)}</span>} />
        </dl>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-body">{value}</dd>
    </div>
  )
}

function ResultPanel({ result, clinic, onTryAgain }: { result: DemoPaymentResult; clinic: string; onTryAgain: () => void }) {
  const paid = result.status === 'paid'
  const Icon = paid ? CheckCircle2 : XCircle
  return (
    <div className="flex flex-col items-center py-4 text-center" data-testid={paid ? 'demo-result-success' : 'demo-result-failed'}>
      <span className={cn('grid size-14 place-items-center rounded-full', paid ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700')}>
        <Icon className="size-8" aria-hidden="true" />
      </span>
      <h2 id="demo-payment-heading" className="mt-4 text-xl font-semibold text-heading" role="status">
        {paid ? 'Payment successful' : 'Payment declined'}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-body">
        {paid
          ? `Your ${result.planName} plan is now active.`
          : 'Your payment was declined. Your plan has not changed and nothing was charged.'}
      </p>

      <dl className="mt-5 w-full max-w-sm space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] px-4 py-3 text-left text-sm">
        <Row label="Reference" value={<span className="font-mono" data-testid="demo-result-reference">{result.reference}</span>} />
        <Row label="Clinic" value={clinic} />
        <Row label="Plan" value={`${result.planName} · monthly`} />
        <Row label="Amount" value={<span data-numeric>{formatCentavos(result.amountCentavos)}</span>} />
        <Row label="Method" value={METHOD_LABEL[result.method]} />
        {paid && result.periodEnd ? <Row label="Active until" value={formatDate(result.periodEnd)} /> : null}
      </dl>

      <div className="mt-6 flex w-full max-w-sm flex-col gap-2">
        {paid ? null : (
          <Button block onClick={onTryAgain}>
            Try again
          </Button>
        )}
        <Link to={SUBSCRIPTION_PATH} className={buttonVariants({ variant: paid ? 'primary' : 'outline', block: true })}>
          Back to Subscription
        </Link>
      </div>
    </div>
  )
}
