import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { useUpdateDoctor } from '@/features/patients/hooks'
import { fullName } from '@/lib/utils'

/**
 * Module 2.6 "View and Update Doctor Profile".
 *
 * Licence number and account status are read-only here. Both are
 * administrator controls (modules 11.2 and 11.3), and a database trigger
 * rejects a change to either from a non-administrator regardless of what this
 * form submits.
 */
export function DoctorProfilePage() {
  const user = useCurrentUser()
  const { refresh } = useAuth()
  const doctor = user.profile.kind === 'doctor' ? user.profile.doctor : null

  const updateDoctor = useUpdateDoctor(doctor?.doc_id ?? '')

  const [firstName, setFirstName] = useState(doctor?.doc_first_name ?? '')
  const [lastName, setLastName] = useState(doctor?.doc_last_name ?? '')
  const [specialization, setSpecialization] = useState(
    doctor?.doc_specialization ?? '',
  )
  const [contactNo, setContactNo] = useState(doctor?.doc_contact_no ?? '')
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  if (!doctor) return null

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    setSavedMessage(null)

    updateDoctor.mutate(
      {
        doc_first_name: firstName.trim(),
        doc_last_name: lastName.trim(),
        doc_specialization: specialization.trim() || null,
        doc_contact_no: contactNo.trim() || null,
      },
      {
        onSuccess: () => {
          setSavedMessage('Your profile has been updated.')
          void refresh()
        },
      },
    )
  }

  return (
    <>
      <PageHeader
        title="My profile"
        description="Your details as they appear to your patients."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Profile details" />
          <CardBody>
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="First name" required>
                  <Input
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    autoComplete="given-name"
                  />
                </Field>
                <Field label="Last name" required>
                  <Input
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                    autoComplete="family-name"
                  />
                </Field>
              </div>

              <Field
                label="Specialisation"
                description="Shown to your patients so they know who is treating them."
              >
                <Input
                  value={specialization}
                  onChange={(event) => setSpecialization(event.target.value)}
                  placeholder="Orthopaedic rehabilitation"
                />
              </Field>

              <Field label="Contact number">
                <Input
                  type="tel"
                  autoComplete="tel"
                  value={contactNo}
                  onChange={(event) => setContactNo(event.target.value)}
                />
              </Field>

              {updateDoctor.isError ? (
                <ErrorState error={updateDoctor.error} />
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  isLoading={updateDoctor.isPending}
                  loadingLabel="Saving…"
                >
                  Save changes
                </Button>
                {savedMessage ? (
                  <p
                    role="status"
                    className="text-sm font-medium text-success-700"
                  >
                    {savedMessage}
                  </p>
                ) : null}
              </div>
            </form>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardHeader title="Account" as="h3" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted">Name on record</dt>
                <dd className="font-medium text-heading">
                  Dr {fullName(doctor.doc_first_name, doctor.doc_last_name)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Email</dt>
                <dd className="break-words font-medium text-heading">
                  {user.email}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Licence number</dt>
                <dd className="font-medium text-heading" data-numeric>
                  {doctor.doc_license_no}
                </dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-sm text-muted">
              Your licence number and account status are managed by a system
              administrator.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
