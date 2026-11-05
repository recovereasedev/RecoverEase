import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { updateClinic, type PlatformClinic } from '@/features/platform/api'
import { parseTimezone } from '@/features/system-settings/api'
import { focusFirstInvalid } from '@/lib/form-focus'

/** The longest clinic name the database accepts (migration 33). */
export const CLINIC_NAME_MAX = 120

type Problems = { name?: string | undefined; timezone?: string | undefined }

export type ClinicEdit = { name: string; timezone: string }

/**
 * Checks an edit as the database will, so a mistake is caught before
 * anything is sent. The database checks it all again; this is a convenience
 * for the person typing, not the control.
 */
export function validateClinicEdit(
  input: ClinicEdit,
): { ok: true; value: ClinicEdit } | { ok: false; problems: Problems } {
  const name = input.name.trim()
  const zone = parseTimezone(input.timezone)
  const problems: Problems = {}
  if (!name) problems.name = "Enter the clinic's name."
  else if (name.length > CLINIC_NAME_MAX) {
    problems.name = `A clinic name can be at most ${CLINIC_NAME_MAX} characters.`
  }
  if (!zone.ok) problems.timezone = zone.message
  if (problems.name || problems.timezone || !zone.ok) return { ok: false, problems }
  return { ok: true, value: { name, timezone: zone.value } }
}

/** IANA zone names the browser knows, to suggest while typing. */
function knownZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

/**
 * Edits a clinic's name and time zone.
 *
 * A new name saves at once. A new time zone asks first, on a second screen
 * that says what it does and what it does not: doses already scheduled keep
 * their exact times and are never moved, while everything worked out from
 * now on - new dose times, the doses added each night, "today" and reminder
 * days - is read in the new zone.
 */
export function EditClinicDialog({
  clinic,
  isOpen,
  onClose,
  onSaved,
}: {
  clinic: PlatformClinic
  isOpen: boolean
  onClose: () => void
  onSaved: (clinic: PlatformClinic) => void
}) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const [name, setName] = useState(clinic.clinic_name)
  const [timezone, setTimezone] = useState(clinic.clinic_timezone)
  const [problems, setProblems] = useState<Problems>({})
  const [noChange, setNoChange] = useState(false)
  // The checked edit waiting on the time zone confirmation, if any.
  const [confirming, setConfirming] = useState<ClinicEdit | null>(null)
  const [zones] = useState(knownZones)

  const save = useMutation({
    mutationFn: (edit: ClinicEdit) =>
      updateClinic({ clinicId: clinic.clinic_id, ...edit }),
    onSuccess: (saved) => {
      // Read back from the database, so the page shows what was stored.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.clinics() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.audit() })
      setConfirming(null)
      onSaved(saved)
    },
  })

  // One press, one save: the button is not busy until React draws it.
  const inFlight = useRef(false)
  const send = (edit: ClinicEdit) => {
    if (inFlight.current) return
    inFlight.current = true
    save.mutate(edit, {
      onSettled: () => {
        inFlight.current = false
      },
    })
  }

  const close = () => {
    if (save.isPending) return
    onClose()
  }

  // Each opening starts from what is saved now.
  const [openedFor, setOpenedFor] = useState<boolean>(false)
  if (isOpen !== openedFor) {
    setOpenedFor(isOpen)
    if (isOpen) {
      setName(clinic.clinic_name)
      setTimezone(clinic.clinic_timezone)
      setProblems({})
      setNoChange(false)
      setConfirming(null)
      save.reset()
    }
  }

  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    const checked = validateClinicEdit({ name, timezone })
    flushSync(() => setProblems(checked.ok ? {} : checked.problems))
    if (!checked.ok) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }
    const edit = checked.value
    if (edit.name === clinic.clinic_name && edit.timezone === clinic.clinic_timezone) {
      setNoChange(true)
      return
    }
    if (edit.timezone !== clinic.clinic_timezone) {
      save.reset()
      setConfirming(edit)
      return
    }
    send(edit)
  }

  if (confirming) {
    return (
      <Dialog
        isOpen={isOpen}
        onClose={close}
        title="Change the clinic's time zone?"
        description={`${clinic.clinic_name}: from ${clinic.clinic_timezone} to ${confirming.timezone}.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={save.isPending}>
              Go back
            </Button>
            <Button
              variant="danger"
              isLoading={save.isPending}
              loadingLabel="Saving…"
              onClick={() => send(confirming)}
            >
              Change time zone
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-body">
          <div>
            <h3 className="text-sm font-semibold text-heading">What stays the same</h3>
            <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
              <li>
                Medication doses already scheduled keep their exact times. They are not
                moved, regenerated or deleted, and their reminders are sent at the same moments.
              </li>
              <li>Appointments keep their exact date and time.</li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-heading">What follows {confirming.timezone} from now on</h3>
            <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
              <li>
                Dose times worked out after this change, for a new or edited schedule and for the
                doses added each night to keep 30 days ahead, read times such as 08:00 as 08:00 in{' '}
                {confirming.timezone}.
              </li>
              <li>
                The clinic's "today", appointment reminder days and the dates on its records
                follow {confirming.timezone}.
              </li>
            </ul>
          </div>
          <Notice tone="warning" title="Check active medication schedules afterwards">
            If {confirming.timezone} is ahead of or behind {clinic.clinic_timezone}, the doses added
            each night use the new local times while the doses already scheduled keep the old
            ones. For up to 30 days, a patient can then see the same dose at both times. Ask the
            clinic's doctors to review their patients' active schedules after the change.
          </Notice>
          {confirming.name !== clinic.clinic_name ? (
            <p className="text-sm">The clinic will also be renamed {confirming.name}.</p>
          ) : null}
          {save.isError ? (
            <FormError error={save.error} title="The clinic was not changed" />
          ) : null}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title="Edit clinic"
      description="Its id, status, people and records stay as they are."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={save.isPending} loadingLabel="Saving…">
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Clinic name" required error={problems.name}>
          <Input
            value={name}
            autoComplete="off"
            maxLength={CLINIC_NAME_MAX + 20}
            onChange={(event) => {
              setName(event.target.value)
              setNoChange(false)
              setProblems((current) => ({ ...current, name: undefined }))
            }}
          />
        </Field>

        <Field
          label="Time zone"
          required
          error={problems.timezone}
          description={`Saved now: ${clinic.clinic_timezone}. A name such as Asia/Manila. Changing it asks you to confirm first.`}
        >
          <Input
            value={timezone}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            list={zones.length > 0 ? 'clinic-time-zones' : undefined}
            onChange={(event) => {
              setTimezone(event.target.value)
              setNoChange(false)
              setProblems((current) => ({ ...current, timezone: undefined }))
            }}
          />
        </Field>
        {zones.length > 0 ? (
          <datalist id="clinic-time-zones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        ) : null}

        {noChange ? (
          <p role="status" className="text-sm text-muted">
            Nothing has changed, so there is nothing to save.
          </p>
        ) : null}

        {save.isError ? <FormError error={save.error} title="The clinic was not changed" /> : null}
      </div>
    </Dialog>
  )
}
