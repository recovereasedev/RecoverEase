import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MailCheck, MailWarning } from 'lucide-react'
import { useCallback, useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  createClinicAdmin,
  type ClinicAdminCreated,
  type PlatformClinic,
} from '@/features/platform/api'
import { focusFirstInvalid } from '@/lib/form-focus'

type Problems = {
  firstName?: string
  lastName?: string
  email?: string
}

/**
 * Adds a Clinic Admin to one clinic.
 *
 * No password is made, shown or handed over. The new Clinic Admin is emailed
 * Supabase Auth's own link to choose their password, so what the Super Admin
 * sees afterwards is only whether that email went - and, if it did not, the
 * way that exists for sending it again ("Forgot password").
 */
export function AddClinicAdminDialog({
  clinic,
  onClose,
}: {
  /** The clinic they will administer; the dialog is open while one is set. */
  clinic: PlatformClinic | null
  onClose: () => void
}) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [problems, setProblems] = useState<Problems>({})
  const [added, setAdded] = useState<
    (ClinicAdminCreated & { name: string; email: string }) | null
  >(null)

  const create = useMutation({
    mutationFn: (input: {
      clinicId: string
      firstName: string
      lastName: string
      email: string
    }) => createClinicAdmin(input),
    onSuccess: (result, input) => {
      // The clinic's Clinic Admin count changes.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platform.clinics(),
      })
      setAdded({
        ...result,
        name: `${input.firstName} ${input.lastName}`,
        email: input.email,
      })
    },
  })

  // One press, one invitation. Two presses in the same task both see the
  // mutation idle, and the second would try to create the same sign-in.
  const inFlight = useRef(false)

  const reset = () => {
    setFirstName('')
    setLastName('')
    setEmail('')
    setProblems({})
    setAdded(null)
    create.reset()
  }

  const close = () => {
    reset()
    onClose()
  }

  // Done takes focus once the result shows: the button that was pressed has
  // gone, and Done is the one thing left to do.
  const focusDone = useCallback((element: HTMLDivElement | null) => {
    element
      ?.closest('dialog')
      ?.querySelector<HTMLButtonElement>('[data-autofocus]')
      ?.focus()
  }, [])

  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    if (!clinic || inFlight.current) return

    const next: Problems = {}
    if (!firstName.trim()) next.firstName = 'Enter their first name.'
    if (!lastName.trim()) next.lastName = 'Enter their last name.'
    if (!email.trim()) {
      next.email = 'Enter the email address they will sign in with.'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      next.email = 'Enter an email address, such as name@example.com.'
    }
    flushSync(() => setProblems(next))
    if (Object.keys(next).length > 0) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }

    inFlight.current = true
    create.mutate(
      {
        clinicId: clinic.clinic_id,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
      },
      {
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  const corrected = (field: keyof Problems) =>
    setProblems((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })

  return (
    <Dialog
      isOpen={clinic !== null}
      onClose={close}
      title={clinic ? `Add a Clinic Admin to ${clinic.clinic_name}` : 'Add a Clinic Admin'}
      description="They manage this clinic's doctors, announcements and settings. They never see another clinic."
      footer={
        added ? (
          <Button data-autofocus onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              isLoading={create.isPending}
              loadingLabel="Adding the Clinic Admin…"
            >
              Add Clinic Admin
            </Button>
          </>
        )
      }
    >
      {added ? (
        <div ref={focusDone}>
          {added.setupEmailSent ? (
            <Notice tone="success" title="Clinic Admin added" icon={MailCheck}>
              {added.name} can now administer {clinic?.clinic_name}. We have
              emailed {added.email} a link to choose their password.
            </Notice>
          ) : (
            <Notice
              tone="warning"
              title="Clinic Admin added, but the email did not go"
              icon={MailWarning}
            >
              {added.name}&rsquo;s account is ready, but the email to choose a
              password could not be sent. Ask them to choose &ldquo;Forgot
              password&rdquo; on the sign-in page and enter {added.email}.
            </Notice>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required error={problems.firstName}>
              <Input
                value={firstName}
                autoComplete="off"
                onChange={(event) => {
                  setFirstName(event.target.value)
                  corrected('firstName')
                }}
              />
            </Field>
            <Field label="Last name" required error={problems.lastName}>
              <Input
                value={lastName}
                autoComplete="off"
                onChange={(event) => {
                  setLastName(event.target.value)
                  corrected('lastName')
                }}
              />
            </Field>
          </div>

          <Field
            label="Email"
            required
            error={problems.email}
            description="They sign in with this address, and the link to choose a password goes to it."
          >
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                corrected('email')
              }}
            />
          </Field>

          {create.isError ? (
            <FormError
              error={create.error}
              title="The Clinic Admin was not added"
            />
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
