import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Select } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import type { Doctor } from '@/features/patients/api'
import { useDoctorPatientCount, useReassignDoctorPatients } from '@/features/patients/hooks'
import { focusFirstInvalid } from '@/lib/form-focus'
import { fullName } from '@/lib/utils'

/**
 * Decision D8: hands every patient of a deactivated doctor to an active
 * doctor in the same clinic.
 *
 * Deactivating a clinician withdraws their access at once, which leaves
 * their patients with nobody who can see their records. This moves them, all
 * together, in one audited step.
 *
 * The administrator is told how many patients, and never who. Choosing where
 * a caseload goes needs the number; the names, and anything in the records,
 * are clinical information an administrator does not hold. The database
 * functions enforce the same thing - this screen only asks.
 */

const patients = (count: number) => (count === 1 ? '1 patient' : `${count} patients`)

export function ReassignPatientsDialog({
  isOpen,
  onClose,
  from,
  doctors,
}: {
  isOpen: boolean
  onClose: () => void
  /** The deactivated doctor whose patients are moving. */
  from: { doctorId: string; name: string }
  /** The doctors the administrator can see, which are their clinic's. */
  doctors: Doctor[]
}) {
  const countQuery = useDoctorPatientCount(from.doctorId)
  const reassign = useReassignDoctorPatients()
  const inFlight = useRef(false)
  const [toDoctorId, setToDoctorId] = useState('')
  const [problem, setProblem] = useState<string | undefined>()
  const [moved, setMoved] = useState<{ count: number; to: string } | null>(null)

  // Once moved, the button just pressed is gone. "Done" takes focus, rather
  // than letting it fall to the page behind the dialog.
  const doneId = useId()
  useEffect(() => {
    if (moved) document.getElementById(doneId)?.focus()
  }, [moved, doneId])

  const candidates = doctors.filter(
    (doctor) => doctor.doc_is_active && doctor.doc_id !== from.doctorId,
  )
  const nameOf = (doctorId: string) => {
    const doctor = candidates.find((candidate) => candidate.doc_id === doctorId)
    return doctor ? `Dr ${fullName(doctor.doc_first_name, doctor.doc_last_name)}` : 'the new doctor'
  }

  const count = countQuery.data
  const canMove = count !== undefined && count > 0 && candidates.length > 0 && !moved

  const close = () => {
    reassign.reset()
    onClose()
  }

  // Always pressable. Without a doctor chosen it says so beside the field and
  // takes focus there, before anything is sent.
  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    if (count === undefined) return

    const next = toDoctorId ? undefined : 'Choose the doctor who will take over these patients.'
    flushSync(() => setProblem(next))
    if (next) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }

    // Nothing below this line may run twice for one move.
    if (inFlight.current) return
    inFlight.current = true

    reassign.mutate(
      { fromDoctorId: from.doctorId, toDoctorId, expectedCount: count },
      {
        onSuccess: (movedCount) => setMoved({ count: movedCount, to: nameOf(toDoctorId) }),
        onSettled: () => {
          inFlight.current = false
        },
      },
    )
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title={moved ? 'Patients reassigned' : 'Reassign patients'}
      description={`Patients of ${from.name}, who has been deactivated.`}
      footer={
        canMove ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              isLoading={reassign.isPending}
              loadingLabel="Moving patients…"
            >
              Move {patients(count)}
            </Button>
          </>
        ) : (
          <Button id={doneId} onClick={close}>
            {moved ? 'Done' : 'Close'}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {moved ? (
          <Notice tone="success" title={`${patients(moved.count)} moved to ${moved.to}`} icon={CheckCircle2}>
            Their records and history are unchanged, and everything {from.name} wrote
            still shows them as its author.
          </Notice>
        ) : countQuery.isPending ? (
          <p role="status" className="text-sm text-muted">
            Counting patients…
          </p>
        ) : countQuery.isError ? (
          <Notice tone="danger" title="The patient count could not be loaded" icon={TriangleAlert}>
            Nothing has been changed. Close this and try again in a moment.
          </Notice>
        ) : count === 0 ? (
          <p className="text-body">
            {from.name} has no patients assigned, so there is nothing to move.
          </p>
        ) : candidates.length === 0 ? (
          <Notice tone="warning" title="No active doctor to take them over" icon={TriangleAlert}>
            {from.name} has {patients(count ?? 0)}. Reactivate or register a doctor first, then
            reassign them.
          </Notice>
        ) : (
          <>
            <p className="text-body">
              {from.name} has <strong data-numeric>{patients(count ?? 0)}</strong>. Choose an
              active doctor in your clinic to take them over.
            </p>

            <Field label="New doctor" error={problem} required>
              <Select
                value={toDoctorId}
                onChange={(event) => {
                  setToDoctorId(event.target.value)
                  if (event.target.value) setProblem(undefined)
                }}
              >
                <option value="">Choose a doctor</option>
                {candidates.map((doctor) => (
                  <option key={doctor.doc_id} value={doctor.doc_id}>
                    Dr {fullName(doctor.doc_first_name, doctor.doc_last_name)}
                  </option>
                ))}
              </Select>
            </Field>

            <Notice tone="info">
              Only the doctor caring for them changes. Their records, history and who wrote
              each entry stay as they are, and the move is recorded in the audit log.
            </Notice>

            {reassign.isError ? (
              <FormError error={reassign.error} title="The patients were not moved" />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
