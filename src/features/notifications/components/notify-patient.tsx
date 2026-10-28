import { Send } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Textarea } from '@/components/ui/field'
import { NOTIFICATION_MESSAGE_MAX_LENGTH } from '@/features/notifications/api'
import { useSendNotificationToPatient } from '@/features/notifications/hooks'
import { newRecordId } from '@/lib/ids'
import { focusFirstInvalid, refocusAfterKeyboardSubmit } from '@/lib/form-focus'

const LIMIT = NOTIFICATION_MESSAGE_MAX_LENGTH.toLocaleString('en')

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
 * put a person's words behind a machine's icon. From migration 41 the
 * database refuses anything else from a doctor too.
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
  return (
    <Card>
      <CardHeader
        title="Send a notification"
        description={`${patientName} reads this in their notifications. It is not a clinical note.`}
      />
      <CardBody>
        <NotifyPatientForm patientUserId={patientUserId} patientName={patientName} />
      </CardBody>
    </Card>
  )
}

/**
 * The message and its Send button, for whichever patient the caller has
 * settled on - the open record's, or the one chosen on the Notifications
 * page.
 *
 * Sent once. Each message is written under an id chosen here (`draftId`):
 * pressing Send again for the same message - twice in quick succession, or
 * after a failure whose insert had in fact reached the database - reuses that
 * id, the database refuses the repeat as a duplicate, and it counts as sent
 * (`sendNotificationToPatient`). Any change to the text makes it a new
 * message with a new id, and so does sending it.
 */
export function NotifyPatientForm({
  patientUserId,
  patientName,
}: {
  patientUserId: string
  patientName: string
}) {
  const [message, setMessage] = useState('')
  const [draftId, setDraftId] = useState(newRecordId)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const send = useSendNotificationToPatient()

  const text = message.trim()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        // "Send notification" is always pressable; with nothing written, or
        // too much, it says so beside the box and takes focus there, sending
        // nothing.
        const invalid = !text
          ? 'Write the message.'
          : text.length > NOTIFICATION_MESSAGE_MAX_LENGTH
            ? `Keep the message to ${LIMIT} characters or fewer.`
            : undefined
        if (invalid) {
          flushSync(() => setProblem(invalid))
          focusFirstInvalid(form)
          return
        }

        send.mutate(
          { notificationId: draftId, userId: patientUserId, type: 'general', message: text },
          {
            onSuccess: () => {
              setMessage('')
              setDraftId(newRecordId())
              setSentTo(patientName)
              // Sent from the keyboard, focus goes back to the emptied box
              // for the next message.
              refocusAfterKeyboardSubmit(form, form.querySelector('textarea'))
            },
          },
        )
      }}
      className="space-y-4"
    >
      <Field
        label="Message"
        description={`Up to ${LIMIT} characters.`}
        error={problem}
      >
        <Textarea
          rows={4}
          value={message}
          maxLength={NOTIFICATION_MESSAGE_MAX_LENGTH}
          onChange={(event) => {
            setMessage(event.target.value)
            // A different message from here on, so a different id.
            setDraftId(newRecordId())
            setProblem(undefined)
            // The confirmation belongs to the message that was sent, not
            // to the one being written next.
            if (sentTo) setSentTo(null)
          }}
          placeholder="Bring your medication list to Thursday’s appointment."
        />
      </Field>
      <p className="-mt-2 text-right text-sm text-muted" aria-hidden="true" data-numeric>
        {message.length.toLocaleString('en')} / {LIMIT}
      </p>

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
          isLoading={send.isPending}
          loadingLabel="Sending…"
        >
          <Send aria-hidden="true" />
          Send notification
        </Button>

        <SavedNotice at={send.submittedAt}>
          {sentTo ? `Sent to ${sentTo}.` : null}
        </SavedNotice>
      </div>
    </form>
  )
}
