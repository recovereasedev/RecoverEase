import { useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import type { Doctor } from '@/features/patients/api'
import { useUpdateDoctor } from '@/features/patients/hooks'
import { focusFirstInvalid } from '@/lib/form-focus'
import { fullName } from '@/lib/utils'

/**
 * Module 11.2 "Update Doctor Account": a Clinic Admin corrects a doctor's
 * details.
 *
 * Five columns and no others. The account's status, its password and its
 * patients each have their own control on the page; the clinic, the linked
 * sign-in, the doctor's own reminder setting, the record ID and the
 * registration date are not an administrator's to change, and the database
 * refuses them whatever is sent (migrations 7, 29, 42 and 54). Which doctors an administrator may change at all is the database's
 * decision too - their own clinic's, by `doctor_update_self_or_admin`.
 *
 * Only what was changed is sent. The form opens on the list's copy of the
 * row, which may be minutes old; sending every field back would undo a
 * contact number the doctor has since corrected on their own profile.
 */

/** The columns this dialog owns. */
const COLUMNS = [
  'doc_first_name',
  'doc_last_name',
  'doc_license_no',
  'doc_specialization',
  'doc_contact_no',
] as const

type Details = Pick<Doctor, (typeof COLUMNS)[number]>
type Problems = Partial<Record<'firstName' | 'lastName' | 'licenseNo', string>>

const LICENCE_TAKEN = 'Another doctor already has this licence number.'

/** The code PostgREST or Postgres gave a refused save, if it gave one. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The only unique column this dialog writes is the licence number. */
const isLicenceTaken = (error: unknown) => codeOf(error) === '23505'

/**
 * No row came back: the update matched nothing this administrator may write -
 * another clinic's doctor, or access that has since gone. PostgREST's own
 * words for it are about JSON.
 */
function presentable(error: unknown): unknown {
  return codeOf(error) === 'PGRST116'
    ? new Error('This account can no longer be changed from your clinic. Nothing was saved.')
    : error
}

export function EditDoctorDialog({
  doctor,
  onClose,
  onSaved,
}: {
  /** The doctor as the list holds them. Mount afresh for each one. */
  doctor: Doctor
  onClose: () => void
  /** Called once saved, with the doctor's name as it now is. */
  onSaved: (name: string) => void
}) {
  const update = useUpdateDoctor(doctor.doc_id)
  const inFlight = useRef(false)
  const formId = useId()

  const [firstName, setFirstName] = useState(doctor.doc_first_name)
  const [lastName, setLastName] = useState(doctor.doc_last_name)
  const [licenseNo, setLicenseNo] = useState(doctor.doc_license_no)
  const [specialization, setSpecialization] = useState(doctor.doc_specialization ?? '')
  const [contactNo, setContactNo] = useState(doctor.doc_contact_no ?? '')
  const [problems, setProblems] = useState<Problems>({})

  /** Clears one field's message once it is being corrected. */
  const corrected = (field: keyof Problems) =>
    setProblems((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })

  // Always pressable. What is missing is said beside its field, with focus
  // taken there, before anything is sent.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const dialog = event.currentTarget.closest('dialog')

    const next: Problems = {}
    if (!firstName.trim()) next.firstName = 'Enter their first name.'
    if (!lastName.trim()) next.lastName = 'Enter their last name.'
    if (!licenseNo.trim()) next.licenseNo = 'Enter their licence number.'
    flushSync(() => setProblems(next))
    if (Object.keys(next).length > 0) {
      focusFirstInvalid(dialog)
      return
    }

    const entered: Details = {
      doc_first_name: firstName.trim(),
      doc_last_name: lastName.trim(),
      doc_license_no: licenseNo.trim(),
      doc_specialization: specialization.trim() || null,
      doc_contact_no: contactNo.trim() || null,
    }
    const changes: Partial<Details> = {}
    for (const column of COLUMNS) {
      if (entered[column] !== doctor[column]) {
        Object.assign(changes, { [column]: entered[column] })
      }
    }

    // Nothing to save is not a save: no request, and nothing is claimed.
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }

    // Nothing below this line may run twice for one save.
    if (inFlight.current) return
    inFlight.current = true

    update.mutate(changes, {
      onSuccess: (saved) =>
        onSaved(`Dr ${fullName(saved.doc_first_name, saved.doc_last_name)}`),
      onError: (error) => {
        if (!isLicenceTaken(error)) return
        flushSync(() => setProblems({ licenseNo: LICENCE_TAKEN }))
        focusFirstInvalid(dialog)
      },
      onSettled: () => {
        inFlight.current = false
      },
    })
  }

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="Edit doctor account"
      description={`Details on record for Dr ${fullName(doctor.doc_first_name, doctor.doc_last_name)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            isLoading={update.isPending}
            loadingLabel="Saving…"
          >
            Save changes
          </Button>
        </>
      }
    >
      {/* A form, so Enter in a field saves. The fields are checked on submit
          rather than by the browser, which would say nothing beside them. */}
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={problems.firstName}>
            <Input
              value={firstName}
              onChange={(event) => {
                setFirstName(event.target.value)
                corrected('firstName')
              }}
              autoComplete="off"
            />
          </Field>
          <Field label="Last name" required error={problems.lastName}>
            <Input
              value={lastName}
              onChange={(event) => {
                setLastName(event.target.value)
                corrected('lastName')
              }}
              autoComplete="off"
            />
          </Field>
        </div>

        <Field
          label="Licence number"
          description="No two doctors can have the same licence number."
          required
          error={problems.licenseNo}
        >
          <Input
            value={licenseNo}
            onChange={(event) => {
              setLicenseNo(event.target.value)
              corrected('licenseNo')
            }}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Specialisation"
          description="Shown to their patients so they know who is treating them."
        >
          <Input
            value={specialization}
            onChange={(event) => setSpecialization(event.target.value)}
            placeholder="Orthopaedic rehabilitation"
            autoComplete="off"
          />
        </Field>

        <Field label="Contact number">
          <Input
            type="tel"
            value={contactNo}
            onChange={(event) => setContactNo(event.target.value)}
            autoComplete="off"
          />
        </Field>

        {/* A licence number that is taken is said beside its field instead. */}
        {update.isError && !isLicenceTaken(update.error) ? (
          <FormError
            error={presentable(update.error)}
            title="The doctor’s details were not saved"
          />
        ) : null}
      </form>
    </Dialog>
  )
}
