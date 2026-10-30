import { Pencil } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import type { Patient } from '@/features/patients/api'
import { useUpdatePatient } from '@/features/patients/hooks'
import { formatDate, toDateKey } from '@/lib/format'

type Draft = {
  firstName: string
  lastName: string
  birthDate: string
  gender: string
  contactNo: string
  address: string
}

function draftOf(patient: Patient): Draft {
  return {
    firstName: patient.pat_first_name,
    lastName: patient.pat_last_name,
    birthDate: patient.pat_birth_date ?? '',
    gender: patient.pat_gender ?? '',
    contactNo: patient.pat_contact_no ?? '',
    address: patient.pat_address ?? '',
  }
}

/**
 * Module 2.5 "Update Patient Information", for the patient's assigned doctor:
 * the record's details panel, with an Edit that corrects them in place.
 *
 * Only the details a patient's record describes them by - name, date of
 * birth, gender, contact number and address. Who the patient's doctor is,
 * their status, their consent and their sign-in are not here, and the
 * database refuses a change to them from this form all the same
 * (`patient_guard_protected_columns`). Who may save it at all is
 * `patient_update`: the patient themselves, or their assigned doctor.
 */
export function PatientDetailsCard({ patient }: { patient: Patient }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftOf(patient))
  const [problems, setProblems] = useState<Partial<Record<keyof Draft, string>>>({})
  const [saved, setSaved] = useState<number | null>(null)
  const update = useUpdatePatient(patient.pat_id)

  const set = (key: keyof Draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setProblems((current) => ({ ...current, [key]: undefined }))
  }

  const save = () => {
    const next: Partial<Record<keyof Draft, string>> = {}
    if (!draft.firstName.trim()) next.firstName = 'Enter their first name.'
    if (!draft.lastName.trim()) next.lastName = 'Enter their last name.'
    if (draft.birthDate && draft.birthDate > toDateKey()) {
      next.birthDate = 'A date of birth cannot be in the future.'
    }
    setProblems(next)
    if (Object.keys(next).length > 0) return

    const blankToNull = (value: string) => (value.trim() ? value.trim() : null)
    update.mutate(
      {
        pat_first_name: draft.firstName.trim(),
        pat_last_name: draft.lastName.trim(),
        pat_birth_date: draft.birthDate || null,
        pat_gender: blankToNull(draft.gender),
        pat_contact_no: blankToNull(draft.contactNo),
        pat_address: blankToNull(draft.address),
      },
      {
        onSuccess: () => {
          setEditing(false)
          setSaved(Date.now())
        },
      },
    )
  }

  const rows: [string, string][] = [
    ['Date of birth', patient.pat_birth_date ? formatDate(patient.pat_birth_date) : 'Not recorded'],
    ['Gender', patient.pat_gender ?? 'Not recorded'],
    ['Contact', patient.pat_contact_no ?? 'Not recorded'],
    ['Address', patient.pat_address ?? 'Not recorded'],
    ['Registered', formatDate(patient.pat_created_at)],
    ['Privacy consent', patient.pat_consent_at ? formatDate(patient.pat_consent_at) : 'Not yet given'],
  ]

  return (
    <Card>
      <CardHeader
        title="Patient details"
        as="h2"
        action={
          editing ? null : (
            <Button
              variant="outline"
              size="sm"
              className="print:hidden"
              onClick={() => {
                setDraft(draftOf(patient))
                setProblems({})
                setSaved(null)
                update.reset()
                setEditing(true)
              }}
            >
              <Pencil aria-hidden="true" />
              Edit details
            </Button>
          )
        }
      />
      <CardBody>
        {editing ? (
          <form
            noValidate
            className="space-y-4"
            aria-label="Edit patient details"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required error={problems.firstName}>
                <Input
                  value={draft.firstName}
                  onChange={(event) => set('firstName', event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Last name" required error={problems.lastName}>
                <Input
                  value={draft.lastName}
                  onChange={(event) => set('lastName', event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Date of birth" error={problems.birthDate}>
                <Input
                  type="date"
                  value={draft.birthDate}
                  max={toDateKey()}
                  onChange={(event) => set('birthDate', event.target.value)}
                />
              </Field>
              <Field label="Gender">
                <Input value={draft.gender} onChange={(event) => set('gender', event.target.value)} />
              </Field>
              <Field label="Contact number">
                <Input
                  type="tel"
                  inputMode="tel"
                  value={draft.contactNo}
                  onChange={(event) => set('contactNo', event.target.value)}
                />
              </Field>
              <Field label="Address">
                <Input value={draft.address} onChange={(event) => set('address', event.target.value)} />
              </Field>
            </div>

            {update.isError ? (
              <FormError error={update.error} title="The patient’s details were not saved" />
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button type="submit" isLoading={update.isPending} loadingLabel="Saving…">
                Save details
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="min-w-0 font-medium text-heading [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
            <SavedNotice className="mt-3" {...(saved ? { at: saved } : {})}>
              {saved ? 'The patient’s details are saved.' : null}
            </SavedNotice>
          </>
        )}
      </CardBody>
    </Card>
  )
}
