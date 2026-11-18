import { DoorOpen, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Select } from '@/components/ui/field'
import { formatDate } from '@/lib/format'

import { CLOSURE_REASONS, closureReasonLabel, isOpenCare, type ClosureReason, type TreatmentPlan } from '../api'
import { useDischargePlan, useReopenPlan } from '../hooks'

/**
 * Migrations 57 and 60 on the doctor's patient record: discharge an active
 * plan with a required reason, or reopen a discharged one. The database
 * allows each only to the patient's assigned, active doctor and only from the
 * right status; this offers the action that fits the plan and says plainly
 * what it does. Nothing discharges a plan but the doctor.
 */
export function CaseLifecycle({ patientId, plan }: { patientId: string; plan: TreatmentPlan }) {
  const discharge = useDischargePlan(patientId)
  const reopen = useReopenPlan(patientId)
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

  const status = plan.treatment_plan_status
  if (status === 'discharged') {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted" data-numeric>
          Discharged on {formatDate(plan.treatment_plan_discharged_at)}
          {plan.treatment_plan_closure_reason ? ` · ${closureReasonLabel(plan.treatment_plan_closure_reason)}` : ''}
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
          description="The plan becomes active again for you and the patient."
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button isLoading={reopen.isPending} loadingLabel="Reopening…" onClick={() => run(() => reopen.mutateAsync(plan.treatment_plan_id))}>
                Reopen case
              </Button>
            </>
          }
        >
          <p className="text-body">
            The patient can log check-ins and work on this plan’s activities and goals again, and reminders resume for
            what comes next. Nothing is sent about the time the case was closed. The discharge stays in the plan’s
            history.
          </p>
          {reopen.error ? <FormError error={reopen.error} title="The case was not reopened" /> : null}
        </Dialog>
        ) : null}
      </div>
    )
  }

  if (!isOpenCare(status)) return null

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted">
        Discharge the patient when their care under this plan is complete.
      </p>
      <Button variant="secondary" size="sm" onClick={() => setDialog('discharge')}>
        <DoorOpen aria-hidden="true" />
        Discharge patient
      </Button>
      {dialog === 'discharge' ? (
      <Dialog
        isOpen
        onClose={close}
        title="Discharge patient"
        description={`“${plan.treatment_plan_title}”`}
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
                run(() => discharge.mutateAsync({ planId: plan.treatment_plan_id, reason }))
              }}
            >
              Confirm discharge
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-body">
            This ends this care plan. The patient keeps their account, records and appointment booking, and can book a
            follow-up; daily check-ins and reminders for this care stop. You can reopen the case later.
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
