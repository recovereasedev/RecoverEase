import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { PageSection } from '@/components/ui/section-heading'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  chooseFreePlan,
  confirmCheckout,
  fetchClinicBilling,
  fetchDemoCheckoutAvailable,
  startCheckout,
  type ClinicBilling,
  type PaymentSource,
  type PaymentStatus,
  type Plan,
} from '@/features/billing/api'
import { isDemoPaymentSimulatorEnabled, isOnlineCheckoutEnabled } from '@/features/billing/availability'
import { formatDate, formatDateTime } from '@/lib/format'
import { formatCentavos, formatPlanPrice } from '@/lib/money'
import type { StatusTone } from '@/lib/status'

const PAYMENT_LABELS: Record<PaymentStatus, { label: string; tone: StatusTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/**
 * Which PayMongo mode a payment was made in (migration 69), shown apart from
 * its status: an outlined pill, dashed for Sandbox, so it never reads as a
 * second status. Screen readers hear "Payment mode: Sandbox".
 */
function PaymentModeBadge({ livemode, source }: { livemode: boolean; source: PaymentSource }) {
  // The internal demo simulator (migration 70) is never PayMongo: not
  // Sandbox, not Live.
  if (source === 'demo_simulator') {
    return (
      <Badge tone="warning" className="border-dashed bg-transparent">
        <span data-testid="payment-mode">
          <span className="sr-only">Payment source: </span>
          Simulated
        </span>
      </Badge>
    )
  }
  return (
    <Badge
      tone={livemode ? 'info' : 'neutral'}
      className={livemode ? 'bg-transparent' : 'border-dashed bg-transparent'}
    >
      <span data-testid="payment-mode">
        <span className="sr-only">Payment mode: </span>
        {livemode ? 'Live' : 'Sandbox'}
      </span>
    </Badge>
  )
}

/** How often a pending payment is read again until PayMongo's answer arrives. */
export const PENDING_REFRESH_MS = 5_000

type ReturnState = { status: PaymentStatus | 'checking' | 'error'; message?: string | undefined } | null

/**
 * The clinic's plan on the Clinic Admin's settings page (migration 68): the
 * four plans, the current one, the last few payments, and a PayMongo TEST
 * checkout for Basic or Premium.
 *
 * Coming back from PayMongo, the page's `?billing=success|cancelled` is only
 * a cue to ask the server, which reads the checkout from PayMongo itself; the
 * plan changes only when PayMongo says paid.
 */
export function ClinicSubscriptionSection() {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [returnState, setReturnState] = useState<ReturnState>(null)
  const [confirmingFree, setConfirmingFree] = useState(false)
  const handledReturn = useRef(false)
  const location = useLocation()
  const navigate = useNavigate()
  // Back from the demo checkout's "Cancel payment" (migration 70).
  const [demoCancelled] = useState<string | null>(() => {
    const state = location.state as { demoCancelled?: unknown } | null
    return typeof state?.demoCancelled === 'string' ? state.demoCancelled : null
  })
  useEffect(() => {
    if (demoCancelled) navigate(location.pathname + location.search, { replace: true, state: null })
    // Clears the one-off state once, so a reload does not show it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const billing = useQuery({
    queryKey: queryKeys.admin.subscription(),
    queryFn: fetchClinicBilling,
    refetchInterval: (query) =>
      query.state.data?.payments[0]?.status === 'pending' ? PENDING_REFRESH_MS : false,
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.subscription() })

  // The demo simulator: the build must offer it AND the database must allow
  // it for this clinic. Anything else - including the function not existing
  // yet - hides it.
  const demoBuild = isDemoPaymentSimulatorEnabled()
  const demo = useQuery({
    queryKey: queryKeys.admin.demoCheckout(),
    queryFn: fetchDemoCheckoutAvailable,
    enabled: demoBuild,
  })
  const demoAvailable = demoBuild && demo.data === true

  const checkout = useMutation({
    mutationFn: startCheckout,
    onSuccess: ({ checkoutUrl }) => {
      window.location.assign(checkoutUrl)
    },
  })

  const toFree = useMutation({
    mutationFn: chooseFreePlan,
    onSuccess: () => {
      setConfirmingFree(false)
      void refresh()
    },
  })

  // Back from PayMongo: ask the server about the latest pending checkout once.
  const returnedWith = searchParams.get('billing')
  const checkoutEnabled = isOnlineCheckoutEnabled()
  const latestPending = billing.data?.payments.find((p) => p.status === 'pending') ?? null
  useEffect(() => {
    if (handledReturn.current || !billing.data) return
    if (returnedWith !== 'success' && returnedWith !== 'cancelled') return
    handledReturn.current = true
    const next = new URLSearchParams(searchParams)
    next.delete('billing')
    setSearchParams(next, { replace: true })
    // No online checkout in this build: there is nothing to confirm.
    if (!checkoutEnabled) return

    if (!latestPending) {
      setReturnState({ status: billing.data.payments[0]?.status ?? 'pending' })
      return
    }
    setReturnState({ status: 'checking' })
    confirmCheckout(returnedWith === 'success' ? 'check' : 'cancel', latestPending.paymentId)
      .then((status) => setReturnState({ status }))
      .catch((error: unknown) =>
        setReturnState({ status: 'error', message: error instanceof Error ? error.message : undefined }),
      )
      .finally(() => void refresh())
    // Runs once, when the billing data first arrives after a return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing.data, returnedWith])

  if (billing.isPending) return <LoadingState label="Loading your plan…" />
  if (billing.isError) return <ErrorState error={billing.error} onRetry={() => void billing.refetch()} />

  return (
    <PageSection
      title="Subscription"
      description={
        demoAvailable
          ? 'Your clinic’s RecoverEase plan.'
          : checkoutEnabled
            ? 'Your clinic’s RecoverEase plan. Payments are PayMongo test-mode only: no real money is charged.'
            : 'Your clinic’s RecoverEase plan.'
      }
    >
      <div className="space-y-4">
        {demoCancelled ? (
          <Notice tone="warning" live="polite" title="Payment cancelled">
            Checkout {demoCancelled} was cancelled. Nothing was charged and your plan has not changed.
          </Notice>
        ) : null}
        <ReturnNotice state={returnState} />
        {checkout.isError ? (
          <Notice tone="danger" live="assertive">{checkout.error.message}</Notice>
        ) : null}
        {toFree.isError ? (
          <Notice tone="danger" live="assertive">{toFree.error.message}</Notice>
        ) : null}
        {latestPending && !returnState ? (
          <Notice tone="info" live="polite" title="Payment pending">
            Waiting for PayMongo to confirm your {latestPending.planName} payment. This updates on its own.
          </Notice>
        ) : null}

        <CurrentPlan billing={billing.data} />

        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Plans">
          {billing.data.plans.map((plan) => (
            <li key={plan.code}>
              <PlanCard
                plan={plan}
                isCurrent={billing.data.current?.planCode === plan.code}
                isBusy={checkout.isPending || toFree.isPending}
                checkoutEnabled={checkoutEnabled}
                demoAvailable={demoAvailable}
                confirmingFree={confirmingFree}
                currentIsPaid={billing.data.current?.planCode === 'basic' || billing.data.current?.planCode === 'premium'}
                onSubscribe={(code) => checkout.mutate(code)}
                onChooseFree={() => (confirmingFree ? toFree.mutate() : setConfirmingFree(true))}
                onCancelFree={() => setConfirmingFree(false)}
              />
            </li>
          ))}
        </ul>

        <RecentPayments billing={billing.data} />
      </div>
    </PageSection>
  )
}

function ReturnNotice({ state }: { state: ReturnState }) {
  if (!state) return null
  switch (state.status) {
    case 'checking':
      return <Notice tone="info" live="polite">Checking your payment with PayMongo…</Notice>
    case 'paid':
      return <Notice tone="success" live="polite" title="Payment successful">Your plan is active. Thank you.</Notice>
    case 'failed':
      return <Notice tone="danger" live="assertive" title="Payment failed">PayMongo declined the payment. Your plan has not changed. You can try again.</Notice>
    case 'cancelled':
      return <Notice tone="warning" live="polite" title="Payment cancelled">The checkout was cancelled. Nothing was charged and your plan has not changed.</Notice>
    case 'pending':
      return <Notice tone="info" live="polite" title="Payment pending">PayMongo has not confirmed the payment yet. This page updates on its own.</Notice>
    case 'error':
      return <Notice tone="danger" live="assertive">{state.message ?? 'Your payment could not be checked. Try again shortly.'}</Notice>
  }
}

function CurrentPlan({ billing }: { billing: ClinicBilling }) {
  const current = billing.current
  const plan = billing.plans.find((p) => p.code === current?.planCode)
  if (!current || !plan) {
    return <p className="text-sm text-muted">Your clinic has no active plan.</p>
  }
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm text-muted">Current plan</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-heading">
        {plan.name}
        <Badge tone="success">Active</Badge>
      </p>
      <p className="mt-1 text-sm text-muted">
        {plan.code === 'enterprise' && current.agreedPriceCentavos !== null
          ? `Agreed price ${formatCentavos(current.agreedPriceCentavos)}`
          : formatPlanPrice(plan)}
        {current.periodEnd ? ` · paid until ${formatDate(current.periodEnd)}` : ''}
      </p>
    </Card>
  )
}

function PlanCard(props: {
  plan: Plan
  isCurrent: boolean
  isBusy: boolean
  checkoutEnabled: boolean
  demoAvailable: boolean
  confirmingFree: boolean
  currentIsPaid: boolean
  onSubscribe: (code: 'basic' | 'premium') => void
  onChooseFree: () => void
  onCancelFree: () => void
}) {
  const { plan, isCurrent, isBusy } = props
  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-heading">{plan.name}</h3>
        {isCurrent ? <Badge tone="info">Current plan</Badge> : null}
      </div>
      <p className="mt-1 text-sm text-body" data-numeric>{formatPlanPrice(plan)}</p>
      <div className="mt-auto pt-4">
        {(plan.code === 'basic' || plan.code === 'premium') && props.demoAvailable ? (
          <Link
            to={`/admin/settings/checkout?plan=${plan.code}`}
            className={buttonVariants({ size: 'sm', variant: isCurrent ? 'outline' : 'primary' })}
          >
            {isCurrent ? 'Renew for one more month' : `Subscribe to ${plan.name}`}
          </Link>
        ) : null}
        {(plan.code === 'basic' || plan.code === 'premium') && !props.demoAvailable && !props.checkoutEnabled ? (
          <p className="text-sm text-muted">Online payment is not available yet. Contact RecoverEase to change plans.</p>
        ) : null}
        {(plan.code === 'basic' || plan.code === 'premium') && !props.demoAvailable && props.checkoutEnabled ? (
          <Button
            size="sm"
            variant={isCurrent ? 'outline' : 'primary'}
            disabled={isBusy}
            onClick={() => props.onSubscribe(plan.code as 'basic' | 'premium')}
          >
            {isCurrent ? 'Renew for one more month' : `Subscribe to ${plan.name}`}
          </Button>
        ) : null}
        {plan.code === 'free' && !isCurrent ? (
          props.confirmingFree ? (
            <div className="space-y-2">
              {props.currentIsPaid ? (
                <p className="text-sm text-body">The rest of your paid month is given up and not refunded.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={isBusy} onClick={props.onChooseFree}>
                  Yes, switch to Free
                </Button>
                <Button size="sm" variant="ghost" onClick={props.onCancelFree}>
                  Keep my plan
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={isBusy} onClick={props.onChooseFree}>
              Switch to Free
            </Button>
          )
        ) : null}
        {plan.code === 'enterprise' && !isCurrent ? (
          <p className="text-sm text-muted">Priced per agreement. Contact RecoverEase.</p>
        ) : null}
      </div>
    </Card>
  )
}

function RecentPayments({ billing }: { billing: ClinicBilling }) {
  if (billing.payments.length === 0) return null
  return (
    <div>
      <h3 className="text-sm font-semibold text-heading">Recent payments</h3>
      <ul aria-label="Recent payments" className="mt-2 divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface">
        {billing.payments.map((payment) => {
          const label = PAYMENT_LABELS[payment.status]
          return (
            <li key={payment.paymentId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="text-body">
                {payment.planName} · <span data-numeric>{formatCentavos(payment.amountCentavos)}</span>
                <span className="block text-muted">{formatDateTime(payment.paidAt ?? payment.createdAt)}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={label.tone}>{label.label}</Badge>
                <PaymentModeBadge livemode={payment.livemode} source={payment.source} />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
