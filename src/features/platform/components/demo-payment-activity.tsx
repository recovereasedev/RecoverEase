import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/field'
import { PageSection } from '@/components/ui/section-heading'
import { StatBand } from '@/components/ui/stat-card'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  DEMO_PAYMENTS_PAGE_SIZE,
  fetchDemoPaymentActivity,
  type DemoPaymentActivity,
  type DemoPaymentFilters,
  type DemoPaymentMethod,
  type DemoPaymentStatus,
} from '@/features/platform/api'
import { formatDateTime } from '@/lib/format'
import { formatCentavos } from '@/lib/money'
import type { StatusTone } from '@/lib/status'

/** How often the list is read again while the page is open. */
export const DEMO_ACTIVITY_REFRESH_MS = 10_000

const STATUS: Record<DemoPaymentStatus, { label: string; tone: StatusTone }> = {
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'warning' },
}

const METHOD: Record<DemoPaymentMethod, string> = {
  qr_wallet: 'QR / E-wallet',
  card: 'Card',
}

const NO_FILTERS: DemoPaymentFilters = { clinicId: null, status: null, method: null, from: null, to: null, page: 0 }

/**
 * Demo Payment Activity on the Super Admin overview (migration 70).
 *
 * Every transaction a Clinic Admin made with the internal RecoverEase demo
 * checkout, read from `super_admin_demo_payment_activity()` - the database's
 * own rows, refreshed every few seconds and on focus. Demo volume is shown
 * apart and is never revenue. When a new demo transaction appears, the
 * subscriber figures above are read again, so a paid demo payment's plan
 * change shows at once.
 *
 * Hidden entirely while the database has no such function (before
 * migration 70 is applied).
 */
export function DemoPaymentActivitySection() {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<DemoPaymentFilters>(NO_FILTERS)

  const query = useQuery({
    queryKey: queryKeys.platform.demoPayments(JSON.stringify(filters)),
    queryFn: () => fetchDemoPaymentActivity(filters),
    staleTime: 0,
    refetchInterval: DEMO_ACTIVITY_REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  })

  // A new demo transaction can change a clinic's plan: refresh the counts.
  const lastTotal = useRef<number | null>(null)
  const total = query.data?.summary.total
  useEffect(() => {
    if (total === undefined) return
    if (lastTotal.current !== null && lastTotal.current !== total) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.subscriptions() })
    }
    lastTotal.current = total
  }, [total, queryClient, queryKeys])

  if (query.data === null) return null

  return (
    <section aria-labelledby="demo-activity-heading" className="mt-section-lg">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id="demo-activity-heading" className="text-lg font-semibold text-heading">
          Checkout Activity
        </h2>
        <Badge tone="neutral">Not counted in revenue</Badge>
      </div>
      <p className="-mt-2 mb-4 text-sm text-muted">
        Every checkout a Clinic Admin completes, declines or cancels. These are simulated and never count toward Total revenue.
      </p>
      <StateView
        isPending={query.isPending}
        error={query.error}
        data={query.data ?? undefined}
        onRetry={() => void query.refetch()}
        loadingLabel="Loading checkout activity…"
      >
        {(activity) => <DemoActivity activity={activity} filters={filters} onFilters={setFilters} />}
      </StateView>
    </section>
  )
}

export function DemoActivity({
  activity,
  filters,
  onFilters,
}: {
  activity: DemoPaymentActivity
  filters: DemoPaymentFilters
  onFilters: (next: DemoPaymentFilters) => void
}) {
  const set = (patch: Partial<DemoPaymentFilters>) => onFilters({ ...filters, ...patch, page: patch.page ?? 0 })
  const filtered = filters.clinicId || filters.status || filters.method || filters.from || filters.to
  const first = activity.totalMatching === 0 ? 0 : filters.page * DEMO_PAYMENTS_PAGE_SIZE + 1
  const last = Math.min((filters.page + 1) * DEMO_PAYMENTS_PAGE_SIZE, activity.totalMatching)

  return (
    <>
      <StatBand
        label="Checkout summary"
        className="lg:grid-cols-5"
        items={[
          { label: 'Transactions', value: activity.summary.total },
          { label: 'Successful', value: activity.summary.paid },
          { label: 'Failed', value: activity.summary.failed },
          { label: 'Cancelled', value: activity.summary.cancelled },
          {
            label: 'Checkout volume',
            value: formatCentavos(activity.summary.demoVolumeCentavos),
            detail: 'Not counted in revenue',
          },
        ]}
      />

      <PageSection className="mt-section" title="Transactions" description="Newest first. Times are your device’s; dates filter in Philippine time.">
        <Card className="p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" role="group" aria-label="Filter transactions">
            <Field label="Clinic">
              <Select value={filters.clinicId ?? ''} onChange={(e) => set({ clinicId: e.target.value || null })}>
                <option value="">All clinics</option>
                {activity.clinics.map((clinic) => (
                  <option key={clinic.clinicId} value={clinic.clinicId}>
                    {clinic.clinicName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={filters.status ?? ''} onChange={(e) => set({ status: (e.target.value || null) as DemoPaymentStatus | null })}>
                <option value="">All statuses</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
                <option value="pending">Pending</option>
              </Select>
            </Field>
            <Field label="Method">
              <Select value={filters.method ?? ''} onChange={(e) => set({ method: (e.target.value || null) as DemoPaymentMethod | null })}>
                <option value="">All methods</option>
                <option value="qr_wallet">QR / E-wallet</option>
                <option value="card">Card</option>
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
            </Field>
            <Field label="To">
              <Input type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
            </Field>
          </div>
          {filtered ? (
            <Button className="mt-3" size="sm" variant="ghost" onClick={() => onFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          ) : null}

          {activity.rows.length === 0 ? (
            <p className="mt-5 text-sm text-muted">
              {filtered ? 'No transactions match these filters.' : 'No transactions yet. They appear here when a Clinic Admin checks out.'}
            </p>
          ) : (
            <ul aria-label="Checkout transactions" className="mt-5 divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
              {activity.rows.map((row) => {
                const status = STATUS[row.status]
                return (
                  <li key={row.paymentId} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{row.reference}</p>
                      <p className="truncate font-medium text-heading">{row.clinicName}</p>
                      <p className="text-muted">{formatDateTime(row.paidAt ?? row.createdAt)}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-body">
                        {row.planName} · <span data-numeric className="font-medium text-heading">{formatCentavos(row.amountCentavos)}</span>
                      </p>
                      <p className="text-muted">{METHOD[row.method]}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <Badge tone="neutral" className="border-dashed bg-transparent">
                        <span className="sr-only">Source: </span>Simulated
                      </Badge>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {activity.totalMatching > DEMO_PAYMENTS_PAGE_SIZE ? (
            <nav aria-label="Transaction pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted" data-numeric>
                {first}–{last} of {activity.totalMatching}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={filters.page === 0} onClick={() => set({ page: filters.page - 1 })}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={last >= activity.totalMatching} onClick={() => set({ page: filters.page + 1 })}>
                  Next
                </Button>
              </div>
            </nav>
          ) : null}
          <p className="mt-4 text-xs text-muted">
            Updated <span data-numeric>{formatDateTime(activity.generatedAt)}</span>. Refreshes every few seconds.
          </p>
        </Card>
      </PageSection>
    </>
  )
}
