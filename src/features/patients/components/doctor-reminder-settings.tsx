import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { PageSection } from '@/components/ui/section-heading'
import { useAuth } from '@/features/auth/auth-context'
import type { Doctor } from '@/features/patients/api'
import { useUpdateDoctor } from '@/features/patients/hooks'

/**
 * Module 7.3 "Configure Reminder Settings", the doctor's own (migration 42):
 * whether they are sent the reminder the day before each of their
 * appointments.
 *
 * It is this doctor's alone. Saving writes the one column on their own row,
 * which the database lets nobody else change - not their clinic's
 * administrator - and it changes nothing for their patients, whose own
 * appointment reminders are still sent, or for any other doctor, or for the
 * clinic's reminder settings. On by default, as every doctor was before.
 *
 * Its own form with its own Save, beside the profile's: a change here is
 * never sent along with a half-edited name, and the reverse.
 */
export function DoctorReminderSettings({
  doctor,
}: {
  doctor: Pick<Doctor, 'doc_id' | 'doc_appointment_reminder_is_enabled'>
}) {
  const { refresh } = useAuth()
  const update = useUpdateDoctor(doctor.doc_id)
  // On unless the doctor has turned it off, as the column's default is.
  const [enabled, setEnabled] = useState(
    doctor.doc_appointment_reminder_is_enabled !== false,
  )
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  return (
    <PageSection
      title="Reminder settings"
      description="Reminders sent to you. Your patients’ reminders are not affected."
    >
      <Card>
        <CardBody>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setSavedMessage(null)
              update.mutate(
                { doc_appointment_reminder_is_enabled: enabled },
                {
                  onSuccess: () => {
                    setSavedMessage(
                      enabled
                        ? 'Appointment reminders are on.'
                        : 'Appointment reminders are off.',
                    )
                    // The signed-in account's own row, which this page
                    // reads, is reloaded with the saved choice.
                    void refresh()
                  },
                },
              )
            }}
            className="space-y-4"
          >
            <fieldset className="space-y-3">
              <legend className="mb-1 font-semibold text-heading">
                Appointment reminders
              </legend>
              {/* The whole tinted row is the label, so the hit area is the
                  card's width and past 44px tall, as on the patient's
                  profile. */}
              <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-surface-sunken p-3 transition-colors hover:bg-neutral-200/60">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => {
                    setEnabled(event.target.checked)
                    setSavedMessage(null)
                  }}
                  className="mt-0.5 size-5 shrink-0 rounded border-[var(--color-border-strong)] accent-brand-700"
                />
                <span>
                  <span className="block font-medium text-heading">
                    Send me a reminder the day before each appointment
                  </span>
                  <span className="block text-sm text-muted">
                    Turning this off stops that notification only. Your
                    appointments still appear in RecoverEase, and your
                    patients are still reminded.
                  </span>
                </span>
              </label>
            </fieldset>

            {update.isError ? (
              <FormError
                error={update.error}
                title="Your reminder settings were not saved"
              />
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                type="submit"
                className="max-sm:w-full"
                isLoading={update.isPending}
                loadingLabel="Saving…"
              >
                Save reminder settings
              </Button>
              <SavedNotice at={update.submittedAt}>{savedMessage}</SavedNotice>
            </div>
          </form>
        </CardBody>
      </Card>
    </PageSection>
  )
}
