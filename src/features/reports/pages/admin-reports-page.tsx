import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBarChart, Printer } from 'lucide-react'

import { FormError } from '@/components/feedback/form-error'
import { ErrorState, EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  fetchAdminDashboardStats,
  fetchReports,
  recordGeneratedReport,
} from '@/features/reports/api'
import { ReportLetterhead } from '@/features/reports/components/report-document'
import { reportDateTime } from '@/features/reports/report-format'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import { fullName } from '@/lib/utils'

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
  useDocumentTitle('Reports')
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

  // Named on paper as the report names its preparer.
  const preparer =
    user.profile.kind === 'admin'
      ? fullName(
          user.profile.admin.admin_first_name,
          user.profile.admin.admin_last_name,
        )
      : null

  return (
    <>
      <PageHeader
        // On paper the letterhead says what this is, and when and by whom
        // it was printed.
        className="print:hidden"
        title="Reports"
        description="System-wide reporting."
        actions={
          <>
            {/* Controls, so on screen only: the printout is the report. */}
            <Button
              variant="outline"
              className="max-sm:w-full print:hidden"
              onClick={() => window.print()}
              disabled={!stats}
            >
              <Printer aria-hidden="true" />
              Print or save as PDF
            </Button>
            <Button
              className="max-sm:w-full print:hidden"
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

      {generate.isError ? (
        // The outcome of an action on screen, not part of the report.
        <div className="print:hidden">
          <FormError
            error={generate.error}
            title="The report was not generated"
          />
        </div>
      ) : null}

      {/* On paper this is a document like the doctor's recovery report:
          `report-sheet` puts it on the report's A4 page, with its margins and
          running footer, and the cards lose their boxes so the figures sit
          on the sheet under the letterhead. */}
      <div className="space-y-section report-sheet">
        <PrintedLetterhead preparer={preparer} />

        {/* --- Current figures ------------------------------------------- */}
        <PageSection
          title="System summary"
          description={
            stats
              ? `As at ${formatDateTime(stats.generated_at)}`
              : undefined
          }
        >
          <Card className="print:rounded-none print:border-0 print:bg-transparent">
            <CardBody className="print:p-0!">
              {statsQuery.isPending ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : statsQuery.isError ? (
                <ErrorState
                  error={statsQuery.error}
                  onRetry={() => void statsQuery.refetch()}
                />
              ) : stats ? (
                // Two up on a phone. These are four short counts; one column
                // turns them into a page of scrolling.
                <dl className="grid grid-cols-2 gap-5 lg:grid-cols-4">
                  <div>
                    <dt className="text-sm text-muted">Patients on record</dt>
                    <dd
                      className="text-headline-lg font-bold text-heading"
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
                      className="text-headline-lg font-bold text-heading"
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
                      className="text-headline-lg font-bold text-heading"
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
        </PageSection>

        {/* --- Recently generated — module 9.5 ---------------------------- */}
        <PageSection title="Recently generated reports">
          <Card className="print:rounded-none print:border-0 print:bg-transparent">
            {/* `sm:p-5` survives `p-0` here. On paper that padding would
                inset the list from the heading and, under the last row, can
                spill onto a sheet of its own. */}
            <CardBody className="p-0 print:p-0!">
              <StateView
                isPending={reportsQuery.isPending}
                error={reportsQuery.error}
                data={reportsQuery.data}
                onRetry={() => void reportsQuery.refetch()}
                empty={
                  <EmptyState
                    icon={FileBarChart}
                    title="No reports generated yet"
                  />
                }
              >
                {(reports) => (
                  <ListRows>
                    {reports.map((report) => (
                      <ListRow
                        key={report.report_id}
                        // Flush with the headings on paper, and never split
                        // across two sheets.
                        className="py-3 break-inside-avoid print:px-0!"
                        title={
                          report.report_type === 'system_wide'
                            ? 'System-wide report'
                            : 'Patient recovery report'
                        }
                        status={
                          <span className="text-sm text-muted">
                            {formatDateTime(report.report_generated_at)}
                          </span>
                        }
                      />
                    ))}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>
        </PageSection>
      </div>
    </>
  )
}

/**
 * The printed report's letterhead: the recovery report's own, saying who
 * printed it and when. Paper only - on screen the page header already says
 * what the page is.
 */
function PrintedLetterhead({ preparer }: { preparer: string | null }) {
  // Kept to the minute while the page is open, so the time printed is the
  // time of printing, not of arriving on the page.
  const now = useNow()

  return (
    <div className="hidden print:block">
      <ReportLetterhead
        title="System-wide report"
        subtitle="Accounts, appointments and generated reports"
        meta={
          <>
            <p>
              <span className="text-muted">Printed</span>{' '}
              <span className="font-semibold text-heading" data-numeric>
                {reportDateTime(new Date(now).toISOString())}
              </span>
            </p>
            {preparer ? (
              <p>
                <span className="text-muted">Prepared by</span>{' '}
                <span className="font-semibold text-heading">{preparer}</span>
              </p>
            ) : null}
          </>
        }
      />
    </div>
  )
}
