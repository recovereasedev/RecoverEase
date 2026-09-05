import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClipboardPlus, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import {
  createDoctorAccount,
  createPatientAccount,
} from '@/features/patients/account-api'
import { TemporaryCredential } from '@/features/patients/components/temporary-credential'
import { queryKeys } from '@/lib/query-keys'

type Mode = 'patient' | 'doctor'

const COPY = {
  patient: {
    title: 'Register a patient',
    description:
      'This creates their account and gives you a temporary password to hand over. They are assigned to you.',
    submit: 'Register patient',
    handOver: 'Give this password to the patient.',
    lostHint:
      'If it is lost, reset the account from their record to issue a new one.',
  },
  doctor: {
    title: 'Register a doctor',
    description:
      'This creates a clinician account and gives you a temporary password to hand over.',
    submit: 'Register doctor',
    handOver: 'Give this password to the doctor.',
    lostHint:
      'If it is lost, reset the account from the doctor accounts list to issue a new one.',
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
  const navigate = useNavigate()
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
    profileId: string
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
        profileId: result.profileId,
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
          <>
            <Button
              variant={mode === 'patient' ? 'ghost' : 'primary'}
              onClick={() => {
                reset()
                onClose()
              }}
            >
              Done
            </Button>
            {/* Registering a patient is their first consultation: the
                clinician has just seen them. This goes straight to the care
                plan rather than leaving them to find it, but it creates
                nothing on the way — every clinical value is still entered
                deliberately, and the record is reachable again later if they
                leave now. */}
            {mode === 'patient' ? (
              <Button
                onClick={() => {
                  const destination = `/doctor/patients/${issued.profileId}?tab=treatment`
                  reset()
                  onClose()
                  void navigate(destination)
                }}
              >
                <ClipboardPlus aria-hidden="true" />
                Set up care plan
              </Button>
            ) : null}
          </>
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
          <TemporaryCredential
            title="Account created"
            handOver={copy.handOver}
            name={issued.name}
            password={issued.password}
            lostHint={copy.lostHint}
          />

          {mode === 'patient' ? (
            <p className="text-sm text-muted">
              This registration is their first consultation. Continue to set
              up the treatment plan and medication now, or open the patient
              from your list whenever you are ready.
            </p>
          ) : null}
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
          // No message is sent here. Onboarding is credential handover, so the
          // address is only ever the sign-in identifier; saying an invitation
          // arrives leaves the creator waiting for an email that is never sent.
          description="This becomes their sign-in address. No email is sent — give them the temporary password yourself."
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
