import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
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
      'This creates their account and gives you a temporary password to hand over. They are assigned to you.',
    submit: 'Register patient',
    handOver: 'Give this password to the patient.',
  },
  doctor: {
    title: 'Register a doctor',
    description:
      'This creates a clinician account and gives you a temporary password to hand over.',
    submit: 'Register doctor',
    handOver: 'Give this password to the doctor.',
  },
} as const

/**
 * Modules 2.1 and 2.2.
 *
 * There is no password field: the credential is generated on the server and
 * shown here once, so nobody chooses a weak one and the same value is never
 * reused across accounts. The holder is required to replace it at first
 * sign-in, which is enforced server-side rather than by this dialog.
 *
 * The value is held in component state for exactly as long as the
 * confirmation is on screen and is cleared when the dialog closes. It is not
 * written to storage, a query cache or a log.
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
  const [issued, setIssued] = useState<{
    name: string
    password: string
  } | null>(null)

  const reset = () => {
    setEmail('')
    setFirstName('')
    setLastName('')
    setLicenseNo('')
    setSpecialization('')
    setContactNo('')
    setBirthDate('')
    setIssued(null)
    // Without this the previous attempt's failure is still on screen when the
    // next account is registered, which is what made a second registration
    // look broken when the first one had already been dealt with.
    create.reset()
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

      // The dialog switches to the confirmation rather than closing: the
      // temporary password is shown once and there is no way to retrieve it
      // afterwards, so it must not disappear on its own.
      setIssued({
        name: `${firstName.trim()} ${lastName.trim()}`.trim(),
        password: result.temporaryPassword,
      })
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
        issued ? (
          <Button
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Done
          </Button>
        ) : (
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
              onClick={() => create.mutate()}
              disabled={!canSubmit}
              isLoading={create.isPending}
              loadingLabel="Creating the account…"
            >
              {copy.submit}
            </Button>
          </>
        )
      }
    >
      {issued ? (
        <div className="space-y-4">
          <Notice tone="success" title="Account created" icon={KeyRound}>
            {copy.handOver} They will be asked to choose their own password
            the first time they sign in, and this one stops working then.
          </Notice>

          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface-sunken p-4">
            <p className="text-label-sm font-medium text-muted">
              Temporary password for {issued.name}
            </p>
            {/* Selectable so it can be copied accurately, and in a monospace
                face so characters that look alike are told apart. */}
            <p className="mt-2 select-all font-mono text-lg font-semibold tracking-wide text-heading">
              {issued.password}
            </p>
          </div>

          <p className="text-sm text-muted">
            This is the only time it is shown. If it is lost, an administrator
            can reset the account rather than recovering this password.
          </p>
        </div>
      ) : (
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

        {/* The server says exactly what went wrong — the email is already
            taken, the licence number is a duplicate, the session expired.
            Showing a generic "we could not load this information" instead
            hid the one sentence the clinician needed. */}
        {create.isError ? (
          <Notice
            tone="danger"
            title="The account was not created"
            icon={TriangleAlert}
            live="assertive"
          >
            {create.error instanceof Error
              ? create.error.message
              : 'The account could not be created.'}
          </Notice>
        ) : null}
      </div>
      )}
    </Dialog>
  )
}
