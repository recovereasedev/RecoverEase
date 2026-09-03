import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarDays,
  MessageCircle,
  Settings,
  ShieldCheck,
  Stethoscope,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { StatCard } from '@/components/ui/stat-card'
import { fetchAdminDashboardStats, fetchChatbotUsage } from '@/features/reports/api'
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
 * The tiles are the shared `StatCard`, not a local copy of it. There is
 * nothing on this page that is not already a number the system computes:
 * no health score, no growth rate, no derived percentage.
 */
export function AdminDashboard() {
  const statsQuery = useQuery({
    queryKey: queryKeys.admin.dashboard(),
    queryFn: fetchAdminDashboardStats,
  })

  const usageQuery = useQuery({
    queryKey: queryKeys.admin.chatbotUsage(),
    queryFn: () => fetchChatbotUsage(30),
  })

  return (
    <>
      <PageHeader
        eyebrow="Administration"
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
          {/* Two up on a phone rather than one: these are short counts, and a
              single column turns four numbers into a page of scrolling. */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard
              icon={Users}
              label="Patients"
              value={statsQuery.data.patients.total}
              footer={`${statsQuery.data.patients.active} active`}
            />
            <StatCard
              icon={Stethoscope}
              label="Doctors"
              value={statsQuery.data.doctors.total}
              footer={`${statsQuery.data.doctors.active} active`}
            />
            <StatCard
              icon={CalendarDays}
              label="Upcoming appointments"
              value={statsQuery.data.appointments.upcoming}
            />
            <StatCard
              icon={ShieldCheck}
              label="User accounts"
              value={Object.values(statsQuery.data.accounts ?? {}).reduce(
                (total, count) => total + count,
                0,
              )}
              footer={Object.entries(statsQuery.data.accounts ?? {})
                .map(([role, count]) => `${count} ${role}`)
                .join(', ')}
            />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            {/* --- Chatbot usage — module 8.6 --------------------------- */}
            <Card>
              <CardHeader
                icon={MessageCircle}
                title="Guidance chatbot"
                description="Usage over the last 30 days."
              />
              <CardBody>
                {usageQuery.isPending ? (
                  <p className="text-sm text-muted">Loading…</p>
                ) : usageQuery.isError ? (
                  <ErrorState error={usageQuery.error} />
                ) : usageQuery.data ? (
                  <>
                    <dl className="grid grid-cols-3 gap-3 sm:gap-4">
                      <div>
                        <dt className="text-sm text-muted">Conversations</dt>
                        <dd
                          className="text-headline-md text-heading"
                          data-numeric
                        >
                          {usageQuery.data.sessions}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted">Messages</dt>
                        <dd
                          className="text-headline-md text-heading"
                          data-numeric
                        >
                          {usageQuery.data.messages}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted">Flagged</dt>
                        <dd
                          className="text-headline-md text-heading"
                          data-numeric
                        >
                          {usageQuery.data.sessions_flagged_critical}
                        </dd>
                      </div>
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

            {/* --- Shortcuts ---------------------------------------------- */}
            <Card>
              <CardHeader icon={Settings} title="Administration" />
              <CardBody className="space-y-2">
                {[
                  { to: '/admin/doctors', label: 'Manage doctor accounts' },
                  { to: '/admin/announcements', label: 'Post an announcement' },
                  { to: '/admin/audit', label: 'Review the audit log' },
                  { to: '/admin/settings', label: 'Configure system settings' },
                ].map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={buttonVariants({
                      variant: 'outline',
                      block: true,
                      className: 'justify-between',
                    })}
                  >
                    {item.label}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                ))}
              </CardBody>
            </Card>
          </div>
        </>
      ) : null}
    </>
  )
}
