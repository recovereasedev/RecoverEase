import { useQuery } from '@tanstack/react-query'
import { Building2, Pencil, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { EmptyState, SavedNotice, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  fetchClinicAdmins,
  fetchClinics,
  type ClinicAdminSummary,
  type PlatformClinic,
} from '@/features/platform/api'
import { EditClinicDialog } from '@/features/platform/components/edit-clinic-dialog'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { formatDate, formatDateTime } from '@/lib/format'

/**
 * One clinic, as a Super Admin manages it: its name, status, time zone and
 * dates, and who administers it. Nothing about its doctors' patients - the
 * two database functions it reads return no such column.
 *
 * The clinic itself comes from the same list the Clinics page shows (one
 * cache, so a change on either page shows on both). Its Clinic Admins come
 * from super_admin_list_clinic_admins, which the database scopes to this
 * clinic.
 */
export function PlatformClinicDetailsPage() {
  const { clinicId = '' } = useParams()
  const queryKeys = useQueryKeys()
  const focusRecovery = useFocusRecovery()

  const clinicsQuery = useQuery({
    queryKey: queryKeys.platform.clinics(),
    queryFn: fetchClinics,
    // Opened from the list or by its address: either way, what is saved now.
    staleTime: 0,
  })
  const clinic = clinicsQuery.data?.find((row) => row.clinic_id === clinicId)
  useDocumentTitle('Clinic Details')

  return (
    <div ref={focusRecovery}>
      <StateView
        isPending={clinicsQuery.isPending}
        error={clinicsQuery.error}
        // Wrapped, so a clinic that is not in the list is "not found", not
        // StateView's "no data was returned" error.
        data={clinicsQuery.data ? { found: clinic } : undefined}
        isEmpty={({ found }) => found === undefined}
        onRetry={() => void clinicsQuery.refetch()}
        loadingLabel="Loading the clinic…"
        empty={<ClinicNotFound />}
      >
        {({ found }) => (found ? <ClinicDetails clinic={found} /> : <ClinicNotFound />)}
      </StateView>
    </div>
  )
}

function ClinicNotFound() {
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Clinics', to: '/platform/clinics' }, { label: 'Not found' }]}
        title="Clinic not found"
      />
      <Card>
        <EmptyState
          icon={Building2}
          title="This clinic could not be found"
          description="It may never have existed, or the address may be mistyped."
          action={
            <Link to="/platform/clinics" className={buttonVariants({ variant: 'secondary' })}>
              Back to clinics
            </Link>
          }
        />
      </Card>
    </>
  )
}

function ClinicDetails({ clinic }: { clinic: PlatformClinic }) {
  const isActive = clinic.clinic_status === 'active'
  const [isEditing, setEditing] = useState(false)
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined)

  const facts: [label: string, value: string][] = [
    ['Name', clinic.clinic_name],
    ['Status', isActive ? 'Active' : 'Inactive'],
    ['Time zone', clinic.clinic_timezone],
    ['Created', formatDateTime(clinic.clinic_created_at)],
    ['Last updated', formatDateTime(clinic.clinic_updated_at)],
  ]

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Clinics', to: '/platform/clinics' }, { label: clinic.clinic_name }]}
        title={clinic.clinic_name}
        description={`${clinic.clinic_timezone} · Added ${formatDate(clinic.clinic_created_at)}`}
        meta={<Badge tone={isActive ? 'success' : 'neutral'}>{isActive ? 'Active' : 'Inactive'}</Badge>}
        actions={
          <Button
            variant="secondary"
            className="max-sm:w-full"
            onClick={() => {
              setSavedAt(undefined)
              setEditing(true)
            }}
          >
            <Pencil aria-hidden="true" />
            Edit clinic
          </Button>
        }
      />

      <SavedNotice {...(savedAt ? { at: savedAt } : {})} className="mb-4">
        {savedAt ? 'The clinic’s details were saved.' : null}
      </SavedNotice>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        <Card>
          <CardHeader title="Clinic information" />
          <CardBody>
            <dl className="divide-y divide-[var(--color-border)]">
              {facts.map(([label, value]) => (
                <div
                  key={label}
                  className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className="min-w-0 break-words text-sm font-medium text-heading">{value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <ClinicAdminsCard clinic={clinic} />
      </div>

      <EditClinicDialog
        clinic={clinic}
        isOpen={isEditing}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false)
          setSavedAt(Date.now())
        }}
      />
    </>
  )
}

function signInLine(admin: ClinicAdminSummary): string {
  return admin.hasSignedIn && admin.lastSignedInAt
    ? `Last signed in ${formatDateTime(admin.lastSignedInAt)}`
    : 'Has not signed in yet'
}

function ClinicAdminsCard({ clinic }: { clinic: PlatformClinic }) {
  const queryKeys = useQueryKeys()
  const adminsQuery = useQuery({
    queryKey: queryKeys.platform.clinicAdmins(clinic.clinic_id),
    queryFn: () => fetchClinicAdmins(clinic.clinic_id),
    staleTime: 0,
  })

  return (
    <Card>
      <CardHeader
        title="Clinic Admins"
        description="Who administers this clinic. Only their names and whether each account has signed in."
      />
      <StateView
        isPending={adminsQuery.isPending}
        error={adminsQuery.error}
        data={adminsQuery.data}
        onRetry={() => void adminsQuery.refetch()}
        loadingLabel="Loading Clinic Admins…"
        empty={
          <EmptyState
            icon={UserRound}
            title="No Clinic Admin yet"
            description={
              clinic.clinic_status === 'active'
                ? 'Add one from the Clinics page.'
                : 'Reactivate the clinic on the Clinics page to add one.'
            }
          />
        }
      >
        {(admins) => (
          <>
            <ul className="divide-y divide-[var(--color-border)]" aria-label={`Clinic Admins of ${clinic.clinic_name}`}>
              {admins.map((admin, index) => (
                <li
                  key={`${admin.createdAt}-${index}`}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 py-4 sm:px-5"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-heading">
                      {admin.firstName} {admin.lastName}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      Added {formatDate(admin.createdAt)} · {signInLine(admin)}
                    </p>
                  </div>
                  <Badge tone={admin.hasSignedIn ? 'success' : 'warning'} className="ms-auto shrink-0">
                    {admin.hasSignedIn ? 'Has signed in' : 'Not signed in yet'}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="border-t border-[var(--color-border)] px-4 py-3 text-sm text-muted sm:px-5">
              RecoverEase records when an account signs in, not when its password was chosen, so
              this does not confirm that account setup is complete.
            </p>
          </>
        )}
      </StateView>
    </Card>
  )
}
