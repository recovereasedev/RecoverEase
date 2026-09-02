import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBarChart, Printer } from 'lucide-react'

import { ErrorState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  fetchAdminDashboardStats,
  fetchReports,
  recordGeneratedReport,
} from '@/features/reports/api'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Modules 9.3 "Generate System-wide Report", 9.4 "Download/Export System-wide
 * Report" and 9.5 "View Recently Generated Reports".
 *
 * The report contents are the same aggregates the dashboard shows, because
 * that is all an administrator has access to. It contains no patient rows,
 * and building it from patient rows would be impossible: the RLS policies
 * return none to this role.
 */
export function AdminReportsPage() {
  const user = useCurrentUser()
  const queryClient = useQueryClient()

  const statsQuery = useQuery({
    queryKey: queryKeys.admin.dashboard(),
    queryFn: fetchAdminDashboardStats,
  })

  const reportsQuery = useQuery({
    queryKey: queryKeys.reports.list(),
    queryFn: fetchReports,
  })

  const generate = useMutation({
    mutationFn: () =>
      recordGeneratedReport({
        userId: user.userId,
        type: 'system_wide',
        patientId: null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports.all })
    },
  })

  const stats = statsQuery.data

  return (
    <>
      <PageHeader
        title="Reports"
        description="System-wide reporting."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => window.print()}
              disabled={!stats}
            >
              <Printer aria-hidden="true" />
              Print or save as PDF
            </Button>
            <Button
              onClick={() => generate.mutate()}
              isLoading={generate.isPending}
              loadingLabel="Generating…"
            >
              <FileBarChart aria-hidden="true" />
              Generate report
            </Button>
          </>
        }
      />

      {generate.isError ? <ErrorState error={generate.error} /> : null}

      <div className="space-y-5">
        {/* --- Current figures ------------------------------------------- */}
        <Card>
          <CardHeader
            title="System summary"
            description={
              stats
                ? `As at ${formatDateTime(stats.generated_at)}`
                : undefined
            }
          />
          <CardBody>
            {statsQuery.isPending ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : statsQuery.isError ? (
              <ErrorState
                error={statsQuery.error}
                onRetry={() => void statsQuery.refetch()}
              />
            ) : stats ? (
              <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-sm text-muted">Patients on record</dt>
                  <dd
                    className="text-2xl font-semibold text-heading"
                    data-numeric
                  >
                    {stats.patients.total}
                  </dd>
                  <dd className="text-sm text-muted" data-numeric>
                    {stats.patients.active} active
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Doctor accounts</dt>
                  <dd
                    className="text-2xl font-semibold text-heading"
                    data-numeric
                  >
                    {stats.doctors.total}
                  </dd>
                  <dd className="text-sm text-muted" data-numeric>
                    {stats.doctors.active} active
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">
                    Upcoming appointments
                  </dt>
                  <dd
                    className="text-2xl font-semibold text-heading"
                    data-numeric
                  >
                    {stats.appointments.upcoming}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Accounts by role</dt>
                  <dd className="mt-1 space-y-0.5 text-sm text-body">
                    {Object.entries(stats.accounts ?? {}).map(
                      ([role, count]) => (
                        <span key={role} className="block" data-numeric>
                          {count} {role}
                        </span>
                      ),
                    )}
                  </dd>
                </div>
              </dl>
            ) : null}
          </CardBody>
        </Card>

        {/* --- Recently generated — module 9.5 ---------------------------- */}
        <Card>
          <CardHeader title="Recently generated reports" />
          <CardBody className="p-0">
            <StateView
              isPending={reportsQuery.isPending}
              error={reportsQuery.error}
              data={reportsQuery.data}
              onRetry={() => void reportsQuery.refetch()}
              empty={
                <div className="px-5 py-12 text-center">
                  <FileBarChart
                    className="mx-auto size-6 text-neutral-400"
                    aria-hidden="true"
                  />
                  <p className="mt-2 font-medium text-heading">
                    No reports generated yet
                  </p>
                </div>
              }
            >
              {(reports) => (
                <ul className="divide-y divide-[var(--color-border)]">
                  {reports.map((report) => (
                    <li
                      key={report.report_id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                    >
                      <p className="font-medium text-heading">
                        {report.report_type === 'system_wide'
                          ? 'System-wide report'
                          : 'Patient recovery report'}
                      </p>
                      <p className="text-sm text-muted">
                        {formatDateTime(report.report_generated_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </StateView>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
