import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'

import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import { PageSection } from '@/components/ui/section-heading'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { useMyDoctor, useUpdatePatient } from '@/features/patients/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
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
  useDocumentTitle('My Profile')
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

  // What is stored, against what is on screen: the form offers a way back
  // only once there is something to go back from.
  const stored = {
    contactNo: patient.pat_contact_no ?? '',
    address: patient.pat_address ?? '',
    reminderTime: patient.pat_reminder_preferred_time?.slice(0, 5) ?? '',
    remindersEnabled: patient.pat_reminder_is_enabled ?? true,
  }
  const isEdited =
    contactNo !== stored.contactNo ||
    address !== stored.address ||
    reminderTime !== stored.reminderTime ||
    remindersEnabled !== stored.remindersEnabled

  const discard = () => {
    setContactNo(stored.contactNo)
    setAddress(stored.address)
    setReminderTime(stored.reminderTime)
    setRemindersEnabled(stored.remindersEnabled)
    setSavedMessage(null)
    updatePatient.reset()
  }

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

      <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
        <div className="lg:col-span-2">
          <PageSection
            title="Contact details"
            description="Keep these current so your clinic can reach you."
          >
          <Card>
            <CardBody>
              {/* Fields sit 20px apart, the two groups 32px: the gap between
                  groups is what says where one ends. */}
              <form onSubmit={onSubmit} className="space-y-5 [&>fieldset]:mt-8">
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

                {/* The second group of the same form. Named by its own
                    legend - the element that says "these fields belong
                    together" to a screen reader - and separated by space
                    rather than by a rule across the card. */}
                <fieldset className="space-y-4 pt-3">
                  <legend className="mb-1 font-semibold text-heading">
                    Medication reminders
                  </legend>

                  {/* The checkbox itself is 16px, which is not a tap target.
                      The whole tinted row is the label, so the hit area is the
                      full width of the card and comfortably past 44px tall. */}
                  <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-surface-sunken p-3 transition-colors hover:bg-neutral-200/60">
                    <input
                      type="checkbox"
                      checked={remindersEnabled}
                      onChange={(event) =>
                        setRemindersEnabled(event.target.checked)
                      }
                      className="mt-0.5 size-5 shrink-0 rounded border-[var(--color-border-strong)] accent-brand-700"
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
                  <FormError
                    error={updatePatient.error}
                    title="Your details were not saved"
                  />
                ) : null}

                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <Button
                    type="submit"
                    className="max-sm:w-full"
                    isLoading={updatePatient.isPending}
                    loadingLabel="Saving…"
                  >
                    Save changes
                  </Button>
                  {/* A way back, offered only once there is something to go
                      back from. It restores what is stored; it writes
                      nothing. */}
                  {isEdited ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="max-sm:w-full"
                      onClick={discard}
                    >
                      Discard changes
                    </Button>
                  ) : null}
                  {/* Always rendered, so the confirmation is announced when
                      it arrives. A status region that mounts with its own
                      text is read inconsistently, and saving twice would be
                      silent the second time. */}
                  <p
                    role="status"
                    className="text-sm font-medium text-success-700 empty:hidden"
                  >
                    {savedMessage}
                  </p>
                </div>
              </form>
            </CardBody>
          </Card>
          </PageSection>
        </div>

        {/* --- Read-only record -------------------------------------------
            Facts, not a form: they need a heading and space, not a card
            each. The one card on this page is the thing you can edit. */}
        <div className="space-y-section">
          <PageSection title="Your record" as="h2">
            <div>
              {/* The label is metadata at 14px; the value is the patient's
                  own record, read at the 16px body size. */}
              <dl className="space-y-3">
                <div>
                  <dt className="text-sm text-muted">Name</dt>
                  <dd className="font-medium text-heading">
                    {fullName(patient.pat_first_name, patient.pat_last_name)}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">Email</dt>
                  <dd className="break-words font-medium text-heading">
                    {user.email}
                  </dd>
                </div>
                {patient.pat_birth_date ? (
                  <div>
                    <dt className="text-sm text-muted">Date of birth</dt>
                    <dd className="font-medium text-heading">
                      {formatDate(patient.pat_birth_date)}
                      {age !== null ? ` (${age})` : ''}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-sm text-muted">Status</dt>
                  <dd className="mt-1">
                    <StatusBadge status={patientStatus[patient.pat_status]} />
                  </dd>
                </div>
              </dl>

              {/* Space, not a rule: the caveat belongs to the list above it,
                  and a line drawn across a column that has no card around it
                  only adds an edge. */}
              <p className="mt-5 text-sm text-muted">
                Your name, date of birth and status are maintained by your care
                team. Ask them if anything here is wrong.
              </p>
            </div>
          </PageSection>

          <PageSection title="Your doctor" as="h2">
            <div>
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
                  {/* A number somebody may have to read out or dial: body
                      size, not metadata size. */}
                  {doctorQuery.data.doc_contact_no ? (
                    <p className="mt-2 text-body" data-numeric>
                      {doctorQuery.data.doc_contact_no}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted">
                  Your assigned doctor could not be loaded.
                </p>
              )}
            </div>
          </PageSection>
        </div>
      </div>
    </>
  )
}
