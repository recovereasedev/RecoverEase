import { useQuery } from '@tanstack/react-query'

import { StateView } from '@/components/feedback/state-view'
import { BarList } from '@/components/ui/bar-list'
import { Card } from '@/components/ui/card'
import { PageSection } from '@/components/ui/section-heading'
import { StatBand } from '@/components/ui/stat-card'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { fetchSubscriptionOverview, type SubscriptionOverview } from '@/features/platform/api'
import { formatCentavos, formatPlanPrice } from '@/lib/money'

/** How often the figures are read again while the page is open. */
export const SUBSCRIPTION_REFRESH_MS = 60_000

const monthLabel = new Intl.DateTimeFormat('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' })

/** "2026-11" → "Nov 2026". The month is already Asia/Manila's; read as UTC so it stays put. */
function formatMonth(month: string): string {
  return monthLabel.format(new Date(`${month}-01T00:00:00Z`))
}

const clinics = (n: number) => `${n} ${n === 1 ? 'clinic' : 'clinics'}`

/**
 * Subscribers and revenue on the Super Admin overview (migration 68).
 *
 * Every figure comes from `super_admin_subscription_overview()`: distinct
 * clinics per active plan, and the sum of payments PayMongo confirmed paid -
 * pending, failed and cancelled checkouts never count. It is read again every
 * minute and whenever the window regains focus, so a subscription, a payment,
 * an expiry or a change of plan shows without a reload.
 */
export function SubscriptionOverviewSection() {
  const queryKeys = useQueryKeys()
  const query = useQuery({
    queryKey: queryKeys.platform.subscriptions(),
    queryFn: fetchSubscriptionOverview,
    staleTime: 0,
    refetchInterval: SUBSCRIPTION_REFRESH_MS,
    refetchOnWindowFocus: true,
  })

  return (
    <StateView
      isPending={query.isPending}
      error={query.error}
      data={query.data}
      onRetry={() => void query.refetch()}
      loadingLabel="Loading subscriptions and revenue…"
    >
      {(overview) => <SubscriptionFigures overview={overview} />}
    </StateView>
  )
}

export function SubscriptionFigures({ overview }: { overview: SubscriptionOverview }) {
  const subscribersOf = (code: string) => overview.plans.find((plan) => plan.code === code)?.subscribers ?? 0
  const nameOf = (code: string) => overview.plans.find((plan) => plan.code === code)?.name ?? code
  const hasRevenue = overview.revenue.lifetimeCentavos > 0

  return (
    <>
      <StatBand
        label="Subscriptions and revenue"
        className="lg:grid-cols-3"
        items={[
          { label: 'Total subscribers', value: overview.totalSubscribers, detail: 'Clinics with an active plan' },
          { label: 'Free subscribers', value: subscribersOf('free') },
          { label: 'Basic subscribers', value: subscribersOf('basic') },
          { label: 'Premium subscribers', value: subscribersOf('premium') },
          { label: 'Enterprise subscribers', value: subscribersOf('enterprise') },
          {
            label: 'Total revenue',
            value: formatCentavos(overview.revenue.lifetimeCentavos),
            detail: `${formatCentavos(overview.revenue.thisMonthCentavos)} this month`,
          },
        ]}
      />

      <div className="mt-section grid gap-section lg:mt-section-lg lg:grid-cols-2">
        <PageSection
          title="Subscription overview"
          description="Each plan, its price, and how many clinics are on it now."
        >
          <Card className="p-4 sm:p-5">
            <BarList
              label="Clinics per plan"
              items={overview.plans.map((plan) => ({
                key: plan.code,
                label: `${plan.name} · ${formatPlanPrice(plan)}`,
                value: plan.subscribers,
                valueLabel: clinics(plan.subscribers),
              }))}
            />
          </Card>
        </PageSection>

        <PageSection
          title="Revenue overview"
          description="Payments PayMongo confirmed. Pending, failed and cancelled payments are not counted. Months are Philippine time."
        >
          <Card className="p-4 sm:p-5">
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted">Collected, all time</dt>
                <dd className="text-base font-semibold text-heading" data-numeric>
                  {formatCentavos(overview.revenue.lifetimeCentavos)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">This month</dt>
                <dd className="text-base font-semibold text-heading" data-numeric>
                  {formatCentavos(overview.revenue.thisMonthCentavos)}
                </dd>
              </div>
            </dl>

            {hasRevenue ? (
              <>
                <h3 className="mt-5 text-sm font-semibold text-heading">By plan</h3>
                <BarList
                  className="mt-2"
                  label="Revenue by plan"
                  items={overview.revenue.byPlan.map((entry) => ({
                    key: entry.code,
                    label: nameOf(entry.code),
                    value: entry.centavos,
                    valueLabel: formatCentavos(entry.centavos),
                  }))}
                />
                <h3 className="mt-5 text-sm font-semibold text-heading">By month</h3>
                <BarList
                  className="mt-2"
                  label="Revenue by month, last 12 months"
                  items={overview.revenue.monthly.map((month) => ({
                    key: month.month,
                    label: formatMonth(month.month),
                    value: month.centavos,
                    valueLabel: formatCentavos(month.centavos),
                  }))}
                />
              </>
            ) : (
              <p className="mt-5 text-sm text-muted">
                No payments yet. Revenue appears here once PayMongo confirms a payment.
              </p>
            )}
          </Card>
        </PageSection>
      </div>
    </>
  )
}
