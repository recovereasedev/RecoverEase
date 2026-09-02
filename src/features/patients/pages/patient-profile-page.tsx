import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { useMyDoctor, useUpdatePatient } from '@/features/patients/hooks'
import { calculateAge, formatDate } from '@/lib/format'
import { fullName } from '@/lib/utils'
import { patientStatus } from '@/lib/status'

/**
 * Modules 2.7 "View and Update Patient Profile" and 4.9 "Configure Medication
 * Reminder Preferences".
 *
 * The fields a patient cannot change — their assigned doctor, their status,
 * their date of birth — are shown as read-only facts rather than hidden. A
 * patient should be able to see the record held about them even where they
 * cannot edit it, and can ask their doctor to correct anything wrong.
 *
 * Those columns are refused by a database trigger regardless of what this
 * form sends.
 */
export function PatientProfilePage() {
  const user = useCurrentUser()
  const { refresh } = useAuth()
  const patient =
    user.profile.kind === 'patient' ? user.profile.patient : null

  const doctorQuery = useMyDoctor(patient?.doc_id)
  const updatePatient = useUpdatePatient(patient?.pat_id ?? '')

  const [contactNo, setContactNo] = useState(patient?.pat_contact_no ?? '')
  const [address, setAddress] = useState(patient?.pat_address ?? '')
  const [reminderTime, setReminderTime] = useState(
    patient?.pat_reminder_preferred_time?.slice(0, 5) ?? '',
  )
  const [remindersEnabled, setRemindersEnabled] = useState(
    patient?.pat_reminder_is_enabled ?? true,
  )
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  if (!patient) return null

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    setSavedMessage(null)

    updatePatient.mutate(
      {
        pat_contact_no: contactNo.trim() || null,
        pat_address: address.trim() || null,
        pat_reminder_preferred_time: reminderTime ? `${reminderTime}:00` : null,
        pat_reminder_is_enabled: remindersEnabled,
      },
      {
        onSuccess: () => {
          setSavedMessage('Your details have been saved.')
          void refresh()
        },
      },
    )
  }

  const age = calculateAge(patient.pat_birth_date)

  return (
    <>
      <PageHeader
        title="My profile"
        description="Your details and how you would like to be reminded."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Contact details"
              description="Keep these current so your clinic can reach you."
            />
            <CardBody>
              <form onSubmit={onSubmit} className="space-y-5">
                <Field
                  label="Contact number"
                  description="A mobile number your clinic can reach you on."
                >
                  <Input
                    type="tel"
                    autoComplete="tel"
                    value={contactNo}
                    onChange={(event) => setContactNo(event.target.value)}
                    placeholder="0917 000 0000"
                  />
                </Field>

                <Field label="Address">
                  <Input
                    autoComplete="street-address"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                </Field>

                <fieldset className="space-y-4 border-t border-[var(--color-border)] pt-5">
                  <legend className="sr-only">Medication reminders</legend>
                  <h3 className="font-semibold text-heading">
                    Medication reminders
                  </h3>

                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={remindersEnabled}
                      onChange={(event) =>
                        setRemindersEnabled(event.target.checked)
                      }
                      className="mt-1 size-4 rounded border-[var(--color-border-strong)]"
                    />
                    <span>
                      <span className="block font-medium text-heading">
                        Send me medication reminders
                      </span>
                      <span className="block text-sm text-muted">
                        You will still see your doses in the app if you turn
                        this off.
                      </span>
                    </span>
                  </label>

                  <Field
                    label="Preferred reminder time"
                    description="The time of day that suits you best for a daily reminder."
                  >
                    <Input
                      type="time"
                      value={reminderTime}
                      onChange={(event) => setReminderTime(event.target.value)}
                      disabled={!remindersEnabled}
                    />
                  </Field>
                </fieldset>

                {updatePatient.isError ? (
                  <ErrorState error={updatePatient.error} />
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    isLoading={updatePatient.isPending}
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
        </div>

        {/* --- Read-only record ------------------------------------------- */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Your record" as="h3" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted">Name</dt>
                  <dd className="font-medium text-heading">
                    {fullName(patient.pat_first_name, patient.pat_last_name)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Email</dt>
                  <dd className="break-words font-medium text-heading">
                    {user.email}
                  </dd>
                </div>
                {patient.pat_birth_date ? (
                  <div>
                    <dt className="text-muted">Date of birth</dt>
                    <dd className="font-medium text-heading">
                      {formatDate(patient.pat_birth_date)}
                      {age !== null ? ` (${age})` : ''}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-muted">Status</dt>
                  <dd className="mt-1">
                    <StatusBadge status={patientStatus[patient.pat_status]} />
                  </dd>
                </div>
              </dl>

              <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-sm text-muted">
                Your name, date of birth and status are maintained by your care
                team. Ask them if anything here is wrong.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Your doctor" as="h3" />
            <CardBody>
              {doctorQuery.isPending ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : doctorQuery.data ? (
                <>
                  <p className="font-medium text-heading">
                    Dr{' '}
                    {fullName(
                      doctorQuery.data.doc_first_name,
                      doctorQuery.data.doc_last_name,
                    )}
                  </p>
                  {doctorQuery.data.doc_specialization ? (
                    <p className="text-sm text-muted">
                      {doctorQuery.data.doc_specialization}
                    </p>
                  ) : null}
                  {doctorQuery.data.doc_contact_no ? (
                    <p className="mt-2 text-sm text-body" data-numeric>
                      {doctorQuery.data.doc_contact_no}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted">
                  Your assigned doctor could not be loaded.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}
