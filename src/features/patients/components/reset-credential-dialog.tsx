import { useMutation, useQueryClient } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Notice } from '@/components/ui/notice'
import {
  resetDoctorPassword,
  resetPatientPassword,
} from '@/features/patients/account-api'
import { TemporaryCredential } from '@/features/patients/components/temporary-credential'
import { queryKeys } from '@/lib/query-keys'

/**
 * Reissues a lost temporary credential.
 *
 * A temporary password is shown once. Before this existed, losing it left the
 * account unreachable: outbound email is not configured, so the sign-in
 * screen's "forgot password" could not help either, and the creation panel
 * promised an administrator reset that no screen offered.
 *
 * The reset is deliberately not silent. It invalidates the current password
 * immediately, so someone who has already signed in and chosen their own
 * password would be locked out of it — that is a real consequence for the
 * account holder and it is stated before the action, not after.
 */
export function ResetCredentialDialog({
  isOpen,
  onClose,
  subject,
}: {
  isOpen: boolean
  onClose: () => void
  subject:
    | { kind: 'doctor'; doctorId: string; name: string }
    | { kind: 'patient'; patientId: string; name: string }
}) {
  const queryClient = useQueryClient()
  const [issued, setIssued] = useState<string | null>(null)

  const reset = useMutation({
    mutationFn: () =>
      subject.kind === 'doctor'
        ? resetDoctorPassword(subject.doctorId)
        : resetPatientPassword(subject.patientId),
    onSuccess: (result) => {
      setIssued(result.temporaryPassword)
      void queryClient.invalidateQueries({
        queryKey:
          subject.kind === 'doctor'
            ? queryKeys.doctors.all
            : queryKeys.patients.all,
      })
    },
  })

  const close = () => {
    setIssued(null)
    // Without this the previous failure is still on screen the next time the
    // dialog is opened for a different account.
    reset.reset()
    onClose()
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title={issued ? 'New password issued' : 'Reset this account’s password'}
      {...(issued
        ? {}
        : {
            description: `${subject.name} will be given a new temporary password and asked to choose their own the next time they sign in.`,
          })}
      footer={
        issued ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => reset.mutate()}
              isLoading={reset.isPending}
              loadingLabel="Resetting…"
            >
              Reset password
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {issued ? (
          <TemporaryCredential
            // Not "New password issued" again — that is the dialog's own
            // title, directly above this. The heading here is the one thing
            // the title does not say, and the thing that decides whether the
            // account holder is about to be locked out without warning.
            title="Their previous password has stopped working"
            handOver={
              subject.kind === 'doctor'
                ? 'Give this password to the doctor.'
                : 'Give this password to the patient.'
            }
            name={subject.name}
            password={issued}
            lostHint="If it is lost again, reset the account once more to issue another."
          />
        ) : (
          <>
            {/* Said before the action, not discovered after it. */}
            <Notice
              tone="warning"
              title="Their current password stops working"
              icon={TriangleAlert}
            >
              If {subject.name} has already chosen their own password, this
              replaces it and they will have to set a new one. Only reset when
              they cannot get in.
            </Notice>

            {reset.isError ? (
              <FormError
                error={reset.error}
                title="The account was not reset"
              />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
