import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { renameClinic, type PlatformClinic } from '@/features/platform/api'
import { focusFirstInvalid } from '@/lib/form-focus'

/** The longest clinic name the database accepts (migration 33). */
export const CLINIC_NAME_MAX = 120

/**
 * Checks a new name as the database will, so a mistake is caught before
 * anything is sent. The database checks it all again; this is a convenience
 * for the person typing, not the control.
 */
export function validateClinicName(
  input: string,
): { ok: true; value: string } | { ok: false; problem: string } {
  const name = input.trim()
  if (!name) return { ok: false, problem: "Enter the clinic's name." }
  if (name.length > CLINIC_NAME_MAX) {
    return { ok: false, problem: `A clinic name can be at most ${CLINIC_NAME_MAX} characters.` }
  }
  return { ok: true, value: name }
}

/**
 * Edits a clinic's name. Only its name: the time zone is shown, read-only.
 *
 * Changing a clinic's time zone is not offered to the Super Admin. While the
 * nightly job that keeps 30 days of doses ahead adds doses at the new local
 * times next to those already scheduled, a zone change can duplicate a
 * patient's doses; the database function behind this dialog
 * (super_admin_rename_clinic, migration 47) takes no time zone at all.
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
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [noChange, setNoChange] = useState(false)

  const save = useMutation({
    mutationFn: (newName: string) => renameClinic({ clinicId: clinic.clinic_id, name: newName }),
    onSuccess: (saved) => {
      // Read back from the database, so the page shows what was stored.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.clinics() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.audit() })
      onSaved(saved)
    },
  })

  // One press, one save: the button is not busy until React draws it.
  const inFlight = useRef(false)
  const send = (newName: string) => {
    if (inFlight.current) return
    inFlight.current = true
    save.mutate(newName, {
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
      setProblem(undefined)
      setNoChange(false)
      save.reset()
    }
  }

  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    const checked = validateClinicName(name)
    flushSync(() => setProblem(checked.ok ? undefined : checked.problem))
    if (!checked.ok) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }
    if (checked.value === clinic.clinic_name) {
      setNoChange(true)
      return
    }
    send(checked.value)
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title="Edit clinic"
      description="Its id, status, time zone, people and records stay as they are."
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
        <Field label="Clinic name" required error={problem}>
          <Input
            value={name}
            autoComplete="off"
            maxLength={CLINIC_NAME_MAX + 20}
            onChange={(event) => {
              setName(event.target.value)
              setNoChange(false)
              setProblem(undefined)
            }}
          />
        </Field>

        <div className="text-sm">
          <p className="font-medium text-heading">Time zone</p>
          <p className="mt-1 break-words text-body">{clinic.clinic_timezone}</p>
          <p className="mt-1 text-muted">
            Read-only here. Changing a clinic's time zone is not available in the Super Admin
            console yet, so that no patient's medication doses are scheduled twice.
          </p>
        </div>

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
