import { Stethoscope } from 'lucide-react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { useAllDoctors, useSetDoctorActive } from '@/features/patients/hooks'
import { formatDate } from '@/lib/format'
import { doctorAccountStatus } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * Modules 11.1 "View Doctor List", 11.2 "Update Doctor Account" and 11.3
 * "Deactivate / Reactivate Doctor Account".
 *
 * Deactivation is not cosmetic. Every doctor-facing Row Level Security policy
 * is written against an active doctor, so switching this off immediately
 * removes that clinician's access to every patient record — not merely their
 * ability to sign in.
 *
 * There is no delete. Removing a clinician who authored treatment plans and
 * prescriptions would orphan the clinical record, and the foreign keys refuse
 * it.
 */
export function AdminDoctorsPage() {
  const doctorsQuery = useAllDoctors()
  const setActive = useSetDoctorActive()

  return (
    <>
      <PageHeader
        title="Doctor accounts"
        description="Clinician accounts and their access to the system."
      />

      <Card>
        <CardBody className="p-0">
          <StateView
            isPending={doctorsQuery.isPending}
            error={doctorsQuery.error}
            data={doctorsQuery.data}
            onRetry={() => void doctorsQuery.refetch()}
            loadingLabel="Loading doctor accounts…"
            empty={
              <div className="px-5 py-12 text-center">
                <Stethoscope
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  No doctor accounts
                </p>
                <p className="mt-1 text-sm text-muted">
                  Doctor accounts are provisioned through the account
                  management workflow.
                </p>
              </div>
            }
          >
            {(doctors) => (
              <ul className="divide-y divide-[var(--color-border)]">
                {doctors.map((doctor) => {
                  const isMutating =
                    setActive.isPending &&
                    setActive.variables?.doctorId === doctor.doc_id

                  return (
                    <li
                      key={doctor.doc_id}
                      className="flex flex-wrap items-center gap-3 px-5 py-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-heading">
                          Dr{' '}
                          {fullName(
                            doctor.doc_first_name,
                            doctor.doc_last_name,
                          )}
                        </p>
                        <p className="text-sm text-muted">
                          {doctor.doc_specialization ?? 'No specialisation recorded'}
                          {' · '}
                          <span data-numeric>
                            Licence {doctor.doc_license_no}
                          </span>
                        </p>
                        <p className="text-sm text-muted">
                          Registered {formatDate(doctor.doc_created_at)}
                        </p>
                      </div>

                      <StatusBadge
                        status={
                          doctor.doc_is_active
                            ? doctorAccountStatus.active
                            : doctorAccountStatus.inactive
                        }
                      />

                      <Button
                        size="sm"
                        variant={doctor.doc_is_active ? 'secondary' : 'primary'}
                        isLoading={isMutating}
                        onClick={() =>
                          setActive.mutate({
                            doctorId: doctor.doc_id,
                            isActive: !doctor.doc_is_active,
                          })
                        }
                      >
                        {doctor.doc_is_active ? 'Deactivate' : 'Reactivate'}
                        <span className="sr-only">
                          {' '}
                          Dr{' '}
                          {fullName(
                            doctor.doc_first_name,
                            doctor.doc_last_name,
                          )}
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </StateView>
        </CardBody>
      </Card>

      <p className="mt-4 text-sm text-muted">
        Deactivating a clinician immediately withdraws their access to all
        patient records. Their patients keep their history and remain assigned
        to them until reassigned.
      </p>
    </>
  )
}
