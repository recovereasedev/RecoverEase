import { useQuery } from '@tanstack/react-query'
import { ArrowRight, MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'

import {
  ErrorState,
  InlineEmpty,
  LoadingState,
  StateView,
} from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import {
  fetchAuditLog,
  toneForAuditAction,
} from '@/features/audit-logs/api'
import { StatBand } from '@/components/ui/stat-card'
import { fetchAdminDashboardStats, fetchChatbotUsage } from '@/features/reports/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Modules 10.1 "View Doctor/Patient Count Overview", 10.2 "View System Usage
 * Statistics" and 8.6 "Monitor Chatbot Usage Logs".
 *
 * Every figure comes from a database function that returns aggregates.
 * Administrators have no row access to patient records or chat transcripts —
 * the RLS policies deny both — so the counts genuinely cannot be assembled by
 * reading rows, and are not.
 *
 * The totals are the shared `StatBand`, not a local copy of it. There is
 * nothing on this page that is not already a number the system computes:
 * no health score, no growth rate, no derived percentage.
 *
 * RecoverEase 2.0 makes this an operations screen, not a copy of the clinical
 * ones: no greeting, the portal's slate accent, and - in place of a card of
 * four buttons that repeated the sidebar - the latest entries in the audit
 * log, read through the audit page's own query (same function, same cache
 * key). Those entries name tables and columns, never patient values; that is
 * the audit trigger's design, not a filter applied here.
 */
export function AdminDashboard() {
  useDocumentTitle('Dashboard')
  const statsQuery = useQuery({
    queryKey: queryKeys.admin.dashboard(),
    queryFn: fetchAdminDashboardStats,
  })

  const usageQuery = useQuery({
    queryKey: queryKeys.admin.chatbotUsage(),
    queryFn: () => fetchChatbotUsage(30),
  })

  // Exactly the audit page's unfiltered query, so opening the log afterwards
  // is already warm.
  const auditQuery = useQuery({
    queryKey: queryKeys.admin.auditLog('|'),
    queryFn: () => fetchAuditLog({}),
  })

  return (
    <>
      <PageHeader
        title="System overview"
        description="Accounts, activity and configuration."
      />

      {statsQuery.isPending ? (
        <LoadingState label="Loading system statistics…" />
      ) : statsQuery.isError ? (
        <ErrorState
          error={statsQuery.error}
          onRetry={() => void statsQuery.refetch()}
        />
      ) : statsQuery.data ? (
        <>
          <StatBand
            label="System totals"
            items={[
              {
                label: 'Patients',
                value: statsQuery.data.patients.total,
                detail: `${statsQuery.data.patients.active} active`,
              },
              {
                label: 'Doctors',
                value: statsQuery.data.doctors.total,
                detail: `${statsQuery.data.doctors.active} active`,
              },
              {
                label: 'Upcoming appointments',
                value: statsQuery.data.appointments.upcoming,
              },
              {
                label: 'User accounts',
                value: Object.values(statsQuery.data.accounts ?? {}).reduce(
                  (total, count) => total + count,
                  0,
                ),
                detail: Object.entries(statsQuery.data.accounts ?? {})
                  .map(([role, count]) => `${count} ${role}`)
                  .join(', '),
              },
            ]}
          />

          <div className="mt-section grid gap-section lg:mt-section-lg lg:grid-cols-3 lg:gap-8">
            {/* --- Recent activity — module 13.1 ------------------------ */}
            <PageSection
              className="lg:col-span-2"
              title="Recent activity"
              description="The latest security-sensitive changes."
              action={
                <Link
                  to="/admin/audit"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  Audit log
                  <ArrowRight aria-hidden="true" />
                </Link>
              }
            >
              <Card className="overflow-hidden">
                <StateView
                  isPending={auditQuery.isPending}
                  error={auditQuery.error}
                  data={auditQuery.data}
                  onRetry={() => void auditQuery.refetch()}
                  loadingLabel="Loading recent activity…"
                  empty={
                    <InlineEmpty>Nothing has been recorded yet.</InlineEmpty>
                  }
                >
                  {(entries) => (
                    <ListRows>
                      {entries.slice(0, 6).map((entry) => (
                        <ListRow
                          key={entry.audit_log_id}
                          className="py-3"
                          title={
                            <span className="capitalize">
                              {entry.audit_log_entity.replace(/_/g, ' ')}
                            </span>
                          }
                          description={
                            <>
                              {entry.user_account?.user_email ?? 'System'} ·{' '}
                              <span data-numeric>
                                {formatDateTime(entry.audit_log_timestamp)}
                              </span>
                            </>
                          }
                          status={
                            <Badge
                              tone={toneForAuditAction(entry.audit_log_action)}
                            >
                              {entry.audit_log_action}
                            </Badge>
                          }
                        />
                      ))}
                    </ListRows>
                  )}
                </StateView>
              </Card>
            </PageSection>

            {/* --- Chatbot usage — module 8.6 --------------------------- */}
            <PageSection
              title="Guidance chatbot"
              description="Usage over the last 30 days."
            >
            <Card>
              <CardBody>
                {usageQuery.isPending ? (
                  <p className="text-sm text-muted">Loading…</p>
                ) : usageQuery.isError ? (
                  <ErrorState error={usageQuery.error} />
                ) : usageQuery.data ? (
                  <>
                    <dl className="divide-y divide-[var(--color-border)]">
                      {/* Label and value on one row each: this column is a
                          third of the page on a desktop, and three counts
                          side by side overlapped there. */}
                      {(
                        [
                          ['Conversations', usageQuery.data.sessions],
                          ['Messages', usageQuery.data.messages],
                          [
                            'Flagged as a possible critical concern',
                            usageQuery.data.sessions_flagged_critical,
                          ],
                        ] as const
                      ).map(([label, value]) => (
                        <div
                          key={label}
                          className="flex items-baseline justify-between gap-4 py-2 first:pt-0"
                        >
                          <dt className="text-sm text-muted">{label}</dt>
                          <dd
                            className="text-headline-md text-heading"
                            data-numeric
                          >
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <p className="mt-4 flex items-start gap-2 border-t border-[var(--color-border)] pt-4 text-sm text-muted">
                      <MessageCircle
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      Usage counts only. Conversation contents are visible to
                      the patient and their doctor, and to nobody else.
                    </p>
                  </>
                ) : null}
              </CardBody>
            </Card>
            </PageSection>
          </div>
        </>
      ) : null}
    </>
  )
}
