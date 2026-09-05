import { KeyRound, Stethoscope, UserPlus } from 'lucide-react'
import { useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { RegisterAccountDialog } from '@/features/patients/components/register-account-dialog'
import { ResetCredentialDialog } from '@/features/patients/components/reset-credential-dialog'
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
  // Holds the doctor whose credential is being reissued. Null closes the
  // dialog; the object carries the name so the confirmation can say who it
  // is for without another lookup.
  const [resetting, setResetting] = useState<{
    doctorId: string
    name: string
  } | null>(null)
  const doctorsQuery = useAllDoctors()
  const setActive = useSetDoctorActive()
  const [isRegisterOpen, setRegisterOpen] = useState(false)

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Doctor accounts"
        description="Clinician accounts and their access to the system."
        actions={
          <Button
            className="max-sm:w-full"
            onClick={() => setRegisterOpen(true)}
          >
            <UserPlus aria-hidden="true" />
            Register a doctor
          </Button>
        }
      />

      <RegisterAccountDialog
        mode="doctor"
        isOpen={isRegisterOpen}
        onClose={() => setRegisterOpen(false)}
      />

      {/* Mounted only while a doctor is selected, so the dialog starts from a
          clean state for each account rather than carrying the previous
          one's result. */}
      {resetting ? (
        <ResetCredentialDialog
          isOpen
          onClose={() => setResetting(null)}
          subject={{
            kind: 'doctor',
            doctorId: resetting.doctorId,
            name: resetting.name,
          }}
        />
      ) : null}

      <Card>
        <CardBody className="p-0">
          <StateView
            isPending={doctorsQuery.isPending}
            error={doctorsQuery.error}
            data={doctorsQuery.data}
            onRetry={() => void doctorsQuery.refetch()}
            loadingLabel="Loading doctor accounts…"
            empty={
              <div className="px-4 py-12 text-center sm:px-5">
                <Stethoscope
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  No doctor accounts
                </p>
                <p className="mt-1 text-sm text-muted">
                  Register a doctor to give them access to the system.
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
                      // Stacked on a phone. The status and the action belong
                      // together on their own line: a deactivation control
                      // wedged beside a three-line account summary is both
                      // cramped and easy to hit by accident.
                      className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
                    >
                      <div className="min-w-0 sm:flex-1">
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

                      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                        <StatusBadge
                          status={
                            doctor.doc_is_active
                              ? doctorAccountStatus.active
                              : doctorAccountStatus.inactive
                          }
                        />

                        {/* Module 11.2. A temporary password is shown once,
                            and outbound email is not configured, so without
                            this a lost credential leaves the account
                            unreachable. */}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setResetting({
                              doctorId: doctor.doc_id,
                              name: `Dr ${fullName(
                                doctor.doc_first_name,
                                doctor.doc_last_name,
                              )}`,
                            })
                          }
                        >
                          <KeyRound aria-hidden="true" />
                          Reset password
                          <span className="sr-only">
                            {' '}
                            for Dr{' '}
                            {fullName(
                              doctor.doc_first_name,
                              doctor.doc_last_name,
                            )}
                          </span>
                        </Button>

                        <Button
                          size="sm"
                          variant={
                            doctor.doc_is_active ? 'secondary' : 'primary'
                          }
                          isLoading={isMutating}
                          onClick={() =>
                            setActive.mutate({
                              doctorId: doctor.doc_id,
                              isActive: !doctor.doc_is_active,
                            })
                          }
                        >
                          {doctor.doc_is_active ? 'Deactivate' : 'Reactivate'}
                          {/* Names the account the button acts on. Several
                              identical "Deactivate" buttons in one list are
                              indistinguishable to a screen reader without
                              it. */}
                          <span className="sr-only">
                            {' '}
                            Dr{' '}
                            {fullName(
                              doctor.doc_first_name,
                              doctor.doc_last_name,
                            )}
                          </span>
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </StateView>
        </CardBody>
      </Card>

      <Notice tone="info" className="mt-4">
        Deactivating a clinician immediately withdraws their access to all
        patient records. Their patients keep their history and remain assigned
        to them until reassigned.
      </Notice>
    </>
  )
}
