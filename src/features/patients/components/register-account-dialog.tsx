import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import {
  createDoctorAccount,
  createPatientAccount,
} from '@/features/patients/account-api'
import { queryKeys } from '@/lib/query-keys'

type Mode = 'patient' | 'doctor'

const COPY = {
  patient: {
    title: 'Register a patient',
    description:
      'This creates their account and emails them an invitation to set a password. They are assigned to you.',
    submit: 'Register patient',
  },
  doctor: {
    title: 'Register a doctor',
    description:
      'This creates a clinician account and emails an invitation to set a password.',
    submit: 'Register doctor',
  },
} as const

/**
 * Modules 2.1 and 2.2.
 *
 * No password field, deliberately. The account holder receives an invitation
 * and chooses their own, so a clinician never knows a patient's credentials
 * and cannot be asked to hand them over. It also means a password is never
 * typed into, or transmitted from, someone else's browser.
 */
export function RegisterAccountDialog({
  mode,
  isOpen,
  onClose,
}: {
  mode: Mode
  isOpen: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const copy = COPY[mode]

  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [licenseNo, setLicenseNo] = useState('')
  const [specialization, setSpecialization] = useState('')
  const [contactNo, setContactNo] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [warning, setWarning] = useState<string | null>(null)

  const reset = () => {
    setEmail('')
    setFirstName('')
    setLastName('')
    setLicenseNo('')
    setSpecialization('')
    setContactNo('')
    setBirthDate('')
    setWarning(null)
  }

  const create = useMutation({
    mutationFn: () =>
      mode === 'patient'
        ? createPatientAccount({
            email,
            firstName,
            lastName,
            birthDate: birthDate || null,
            contactNo: contactNo || null,
          })
        : createDoctorAccount({
            email,
            firstName,
            lastName,
            licenseNo,
            specialization: specialization || null,
            contactNo: contactNo || null,
          }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey:
          mode === 'patient' ? queryKeys.patients.all : queryKeys.doctors.all,
      })

      if (result.invitationSent) {
        reset()
        onClose()
      } else {
        // The account exists and is usable, but they have no way in yet.
        // Closing silently would leave the clinician believing it was sent.
        setWarning(
          'The account was created, but the invitation email could not be sent. Ask an administrator to resend it.',
        )
      }
    },
  })

  const canSubmit =
    email.trim() !== '' &&
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    (mode === 'doctor' ? licenseNo.trim() !== '' : true)

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => {
        reset()
        onClose()
      }}
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              setWarning(null)
              create.mutate()
            }}
            disabled={!canSubmit}
            isLoading={create.isPending}
            loadingLabel="Creating the account…"
          >
            {copy.submit}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            <Input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Last name" required>
            <Input
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        <Field
          label="Email address"
          description="The invitation is sent here. It becomes their sign-in address."
          required
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            placeholder="name@example.com"
          />
        </Field>

        {mode === 'doctor' ? (
          <>
            <Field
              label="Licence number"
              description="Must be unique. The database rejects a duplicate."
              required
            >
              <Input
                value={licenseNo}
                onChange={(event) => setLicenseNo(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Specialisation">
              <Input
                value={specialization}
                onChange={(event) => setSpecialization(event.target.value)}
                placeholder="Orthopaedic rehabilitation"
              />
            </Field>
          </>
        ) : (
          <Field label="Date of birth">
            <Input
              type="date"
              value={birthDate}
              onChange={(event) => setBirthDate(event.target.value)}
            />
          </Field>
        )}

        <Field label="Contact number">
          <Input
            type="tel"
            value={contactNo}
            onChange={(event) => setContactNo(event.target.value)}
          />
        </Field>

        {create.isError ? <ErrorState error={create.error} /> : null}

        {warning ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800"
          >
            {warning}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
