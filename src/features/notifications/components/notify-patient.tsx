import { Send } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Textarea } from '@/components/ui/field'
import { useSendNotificationToPatient } from '@/features/notifications/hooks'

/**
 * Module 7.1, "Send Notification to Patient".
 *
 * The clinician's one way to put a message in front of a patient outside a
 * consultation — a reminder to bring something, a word about a change in
 * plan. It sits beside the patient's details rather than with the clinical
 * notes on purpose: a note is written *about* a patient and never shown to
 * them, and this is written *to* them. Putting the two in one place is how a
 * private observation ends up on a patient's screen, so the wording of each
 * says plainly which it is.
 *
 * The type is fixed to `general`. The other kinds are raised by the system
 * itself — a due dose, a booked appointment, a critical concern from the
 * guidance chat — and letting a written message borrow one of those would
 * put a person's words behind a machine's icon.
 *
 * Who may be notified is not decided here. The insert is checked against
 * `notification_insert_doctor_to_patient`, which allows only this doctor's
 * own patients; this component addresses the patient whose record is open.
 */
export function NotifyPatient({
  patientUserId,
  patientName,
}: {
  patientUserId: string
  patientName: string
}) {
  const [message, setMessage] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const send = useSendNotificationToPatient()

  const text = message.trim()

  return (
    <Card>
      <CardHeader
        title="Send a notification"
        description={`${patientName} reads this in their notifications. It is not a clinical note.`}
      />
      <CardBody>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!text) return

            send.mutate(
              { userId: patientUserId, type: 'general', message: text },
              {
                onSuccess: () => {
                  setMessage('')
                  setSentTo(patientName)
                },
              },
            )
          }}
          className="space-y-4"
        >
          <Field label="Message">
            <Textarea
              rows={4}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
                // The confirmation belongs to the message that was sent, not
                // to the one being written next.
                if (sentTo) setSentTo(null)
              }}
              placeholder="Bring your medication list to Thursday’s appointment."
            />
          </Field>

          {send.isError ? (
            <FormError
              error={send.error}
              title="The notification was not sent"
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              className="max-sm:w-full"
              disabled={!text}
              isLoading={send.isPending}
              loadingLabel="Sending…"
            >
              <Send aria-hidden="true" />
              Send notification
            </Button>

            {sentTo ? (
              <p role="status" className="text-sm font-medium text-success-800">
                Sent to {sentTo}.
              </p>
            ) : null}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
