import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Building2 } from 'lucide-react'
import { Link } from 'react-router-dom'

import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { StatBand } from '@/components/ui/stat-card'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { fetchPlatformOverview } from '@/features/platform/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateTime } from '@/lib/format'

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The console's first page: how many clinics, Clinic Admins, doctors and
 * patients the platform has, and how many platform announcements.
 *
 * Every figure is a count from one database function,
 * `super_admin_platform_overview()` (migration 46), which refuses anyone but
 * an assured Super Admin and returns no person and nothing clinical - so
 * there is nothing on this page to hide, and nothing derived from it here:
 * no rate, no score, no trend.
 */
export function PlatformOverviewPage() {
  const queryKeys = useQueryKeys()
  useDocumentTitle('Platform Overview')

  const overviewQuery = useQuery({
    queryKey: queryKeys.platform.overview(),
    queryFn: fetchPlatformOverview,
    // Counted afresh each time the page opens, rather than kept for the
    // app's usual minute: every console change - a clinic, a Clinic Admin,
    // an announcement - moves a figure here, and one cheap read is simpler
    // and surer than each of them remembering to refresh this.
    staleTime: 0,
  })

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="How many clinics, staff and patients RecoverEase has. Counts only - no one’s details."
      />

      <StateView
        isPending={overviewQuery.isPending}
        error={overviewQuery.error}
        data={overviewQuery.data}
        onRetry={() => void overviewQuery.refetch()}
        loadingLabel="Loading the platform overview…"
      >
        {(overview) => (
          <>
            <StatBand
              label="Platform totals"
              items={[
                {
                  label: 'Clinics',
                  value: overview.clinics.total,
                  detail: `${overview.clinics.active} active · ${overview.clinics.inactive} inactive`,
                },
                { label: 'Clinic Admins', value: overview.clinicAdmins },
                {
                  label: 'Doctors',
                  value: overview.doctors.total,
                  detail: `${overview.doctors.active} active`,
                },
                {
                  label: 'Patients',
                  value: overview.patients.total,
                  detail: `${overview.patients.active} active`,
                },
              ]}
            />

            <div className="mt-section grid gap-section lg:mt-section-lg lg:grid-cols-3 lg:gap-8">
              <PageSection
                className="lg:col-span-2"
                title="By clinic"
                description="Each clinic’s Clinic Admins, and its active doctors and patients."
                action={
                  <Link
                    to="/platform/clinics"
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  >
                    Manage clinics
                    <ArrowRight aria-hidden="true" />
                  </Link>
                }
              >
                <Card className="overflow-hidden">
                  {overview.byClinic.length === 0 ? (
                    <EmptyState
                      icon={Building2}
                      title="No clinics yet"
                      description="Clinics you create appear here with their counts."
                    />
                  ) : (
                    <ListRows>
                      {overview.byClinic.map((clinic) => {
                        const isActive = clinic.clinicStatus === 'active'
                        return (
                          <ListRow
                            key={clinic.clinicId}
                            className="py-3"
                            title={clinic.clinicName}
                            description={
                              <span data-numeric>
                                {plural(clinic.clinicAdmins, 'Clinic Admin', 'Clinic Admins')} ·{' '}
                                {plural(clinic.activeDoctors, 'active doctor', 'active doctors')} ·{' '}
                                {plural(clinic.activePatients, 'active patient', 'active patients')}
                              </span>
                            }
                            status={
                              <Badge tone={isActive ? 'success' : 'neutral'}>
                                {isActive ? 'Active' : 'Inactive'}
                              </Badge>
                            }
                          />
                        )
                      })}
                    </ListRows>
                  )}
                </Card>
              </PageSection>

              <PageSection
                title="Platform announcements"
                description="Notices for everyone on RecoverEase."
                action={
                  <Link
                    to="/platform/announcements"
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  >
                    Announcements
                    <ArrowRight aria-hidden="true" />
                  </Link>
                }
              >
                <Card>
                  <dl className="divide-y divide-[var(--color-border)] px-4 sm:px-5">
                    {(
                      [
                        ['Published', overview.announcements.published],
                        ['Drafts', overview.announcements.drafts],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-4 py-3">
                        <dt className="text-sm text-muted">{label}</dt>
                        <dd className="text-base font-semibold text-heading" data-numeric>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </PageSection>
            </div>

            <p className="mt-6 text-sm text-muted">
              Counted at{' '}
              <span data-numeric>{formatDateTime(overview.generatedAt)}</span>.
            </p>
          </>
        )}
      </StateView>
    </>
  )
}
