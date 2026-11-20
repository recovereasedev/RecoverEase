import { DoorOpen, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Select } from '@/components/ui/field'
import { CLOSURE_REASONS, closureReasonLabel, type ClosureReason } from '@/features/treatment-plans/api'
import { formatDate } from '@/lib/format'

import { isDischarged, type PatientCare } from '../api'
import { useDischargePatientCare, useReopenPatientCare } from '../hooks'

/**
 * Migration 63 on the doctor's patient record, above every tab: the
 * patient's care, and the one action that changes it - Discharge patient
 * (with a required reason) while they are in care, Reopen case once they are
 * discharged. Whether or not the patient has a treatment plan. The database
 * allows each only to the patient's assigned, active doctor; nothing else
 * discharges a patient.
 */
export function PatientCareControls({ care, patientName }: { care: PatientCare; patientName: string }) {
  const patientId = care.pat_id
  const discharge = useDischargePatientCare(patientId)
  const reopen = useReopenPatientCare(patientId)
  const [dialog, setDialog] = useState<'discharge' | 'reopen' | null>(null)
  const [reason, setReason] = useState<ClosureReason | ''>('')
  const [missingReason, setMissingReason] = useState(false)
  // One confirmation at a time: a second press lands before the first has
  // re-rendered the button as busy.
  const pressing = useRef(false)

  const close = () => {
    setDialog(null)
    setReason('')
    setMissingReason(false)
    discharge.reset()
    reopen.reset()
  }
  const run = (action: () => Promise<unknown>) => {
    if (pressing.current) return
    pressing.current = true
    void action()
      .then(close)
      .catch(() => {
        // Shown in the dialog, from the mutation.
      })
      .finally(() => {
        pressing.current = false
      })
  }

  if (isDischarged(care)) {
    return (
      <div
        className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-neutral-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between print:hidden"
        data-testid="patient-care-bar"
      >
        <p className="text-sm text-body" data-numeric>
          <strong>Care ended.</strong> Discharged on {formatDate(care.pat_care_discharged_at)}
          {care.pat_care_closure_reason ? ` · ${closureReasonLabel(care.pat_care_closure_reason)}` : ''}. Care
          records are read-only until you reopen the case.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setDialog('reopen')}>
          <RotateCcw aria-hidden="true" />
          Reopen case
        </Button>
        {/* Rendered only while open, so its text is not on the page otherwise. */}
        {dialog === 'reopen' ? (
          <Dialog
            isOpen
            onClose={close}
            title="Reopen case"
            description={patientName}
            footer={
              <>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button isLoading={reopen.isPending} loadingLabel="Reopening…" onClick={() => run(() => reopen.mutateAsync(undefined))}>
                  Reopen case
                </Button>
              </>
            }
          >
            <p className="text-body">
              The patient is back in your care. They can log check-ins and mark roadmap activities again, and you can
              edit their care plans. The discharge stays in the patient’s care history.
            </p>
            {reopen.error ? <FormError error={reopen.error} title="The case was not reopened" /> : null}
          </Dialog>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between print:hidden"
      data-testid="patient-care-bar"
    >
      <p className="text-sm text-muted">The patient is in your care. Discharge them when their care is complete.</p>
      <Button variant="secondary" size="sm" onClick={() => setDialog('discharge')}>
        <DoorOpen aria-hidden="true" />
        Discharge patient
      </Button>
      {dialog === 'discharge' ? (
        <Dialog
          isOpen
          onClose={close}
          title="Discharge patient"
          description={patientName}
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                isLoading={discharge.isPending}
                loadingLabel="Discharging…"
                onClick={() => {
                  if (!reason) {
                    setMissingReason(true)
                    return
                  }
                  run(() => discharge.mutateAsync(reason))
                }}
              >
                Confirm discharge
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-body">
              This ends the patient’s care with you. They keep their account, records and appointment booking, and can
              book a follow-up; daily check-ins, roadmap activities and goal progress stop, and their care plans become
              read-only. Each plan keeps its own status. You can reopen the case later.
            </p>
            <p className="text-body">
              Medicine and appointment reminders are not changed by a discharge. End any medicine that should stop, or
              switch its reminders off, and cancel any appointment that is no longer needed.
            </p>
            <Field label="Closure reason" required error={missingReason ? 'Choose a reason for the discharge.' : undefined}>
              <Select
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as ClosureReason | '')
                  setMissingReason(false)
                }}
              >
                <option value="">Choose a reason…</option>
                {CLOSURE_REASONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </Field>
            {discharge.error ? <FormError error={discharge.error} title="The patient was not discharged" /> : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
