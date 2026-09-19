import { ArrowRight, Check, Pencil, Pill } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { MedicationForm } from '@/features/medications/components/medication-form'
import type { ScheduleWithPrescription } from '@/features/medications/api'
import type { PlanWithGoals } from '@/features/treatment-plans/api'
import { TreatmentGoalForm } from '@/features/treatment-plans/components/treatment-goal-form'
import { TreatmentPlanForm } from '@/features/treatment-plans/components/treatment-plan-form'
import { formatDate, formatScheduleTime } from '@/lib/format'

export type ConsultationStep =
  | 'plan'
  | 'goals'
  | 'medication'
  | 'review'
  | 'done'

const STEPS: { id: ConsultationStep; label: string }[] = [
  { id: 'plan', label: 'Treatment plan' },
  { id: 'goals', label: 'Goals' },
  { id: 'medication', label: 'Medication' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Finish' },
]

/**
 * The consultation the QA asked for: "a button that says start consultation
 * then mo pop to treatment plan then med".
 *
 * It is a guide over the work the patient record already does, not a second
 * way of doing it. Every field here is rendered by the same form component
 * the Treatment and Medication tabs use, and every write goes through the
 * hooks that already existed — so there is one implementation of "create a
 * plan", reached from two places.
 *
 * Nothing is held in a draft. Each step writes its own record when the
 * clinician submits it, which is what makes leaving halfway safe: a
 * consultation interrupted after the plan leaves a plan, not a half-saved
 * wizard, and picking it up again is just opening the patient record.
 */
export function ConsultationFlow({
  patientId,
  doctorId,
  patientName,
  plans,
  schedules,
  onFinish,
}: {
  patientId: string
  doctorId: string
  patientName: string
  plans: PlanWithGoals[]
  schedules: ScheduleWithPrescription[]
  /** Leaves the guided flow, staying on the patient record. */
  onFinish: () => void
}) {
  // The plan this consultation is working on: the most recent, which is what
  // `fetchTreatmentPlans` returns first.
  const plan = plans[0]
  // A medicine added after the first belongs to the prescription just
  // issued, not to a new one.
  const prescriptionId = schedules[0]?.prescription?.prescription_id

  const [step, setStep] = useState<ConsultationStep>(plan ? 'goals' : 'plan')
  const [isEditingPlan, setEditingPlan] = useState(false)
  const [isAddingMedicine, setAddingMedicine] = useState(false)

  const currentIndex = STEPS.findIndex((candidate) => candidate.id === step)

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={`Consultation with ${patientName}`}
          description="Each step is saved as you go. You can leave at any point and carry on later from this record."
          action={
            step === 'done' ? null : (
              <Button variant="ghost" size="sm" onClick={onFinish}>
                Leave consultation
              </Button>
            )
          }
        />
        <CardBody>
          <ol className="flex flex-wrap gap-x-2 gap-y-2">
            {STEPS.map((candidate, index) => {
              const isCurrent = candidate.id === step
              const isPast = index < currentIndex
              return (
                <li
                  key={candidate.id}
                  aria-current={isCurrent ? 'step' : undefined}
                  className="flex items-center gap-2"
                >
                  <span
                    className={[
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                      isCurrent
                        ? 'bg-brand-800 text-white'
                        : isPast
                          ? 'bg-accent-100 text-accent-800'
                          : 'bg-neutral-100 text-muted',
                    ].join(' ')}
                  >
                    {isPast ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span
                    className={
                      isCurrent
                        ? 'text-sm font-medium text-heading'
                        : 'text-sm text-muted'
                    }
                  >
                    {candidate.label}
                  </span>
                  {index < STEPS.length - 1 ? (
                    <ArrowRight
                      className="ml-1 size-3.5 text-neutral-400 max-sm:hidden"
                      aria-hidden="true"
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </CardBody>
      </Card>

      {/* --- Step 1: the treatment plan ---------------------------------- */}
      {step === 'plan' || (step === 'goals' && isEditingPlan) ? (
        <Card>
          <CardHeader
            title={
              plan && isEditingPlan ? 'Edit treatment plan' : 'Treatment plan'
            }
            description={
              plan && isEditingPlan
                ? undefined
                : 'What this course of recovery is working towards.'
            }
          />
          <CardBody>
            <TreatmentPlanForm
              patientId={patientId}
              doctorId={doctorId}
              {...(plan && isEditingPlan ? { plan } : {})}
              onDone={() => {
                setEditingPlan(false)
                setStep('goals')
              }}
              {...(isEditingPlan
                ? { onCancel: () => setEditingPlan(false) }
                : {})}
            />
          </CardBody>
        </Card>
      ) : null}

      {/* --- Step 2: the goals ------------------------------------------- */}
      {step === 'goals' && plan && !isEditingPlan ? (
        <Card>
          <CardHeader
            title="Goals"
            description={`Added to “${plan.treatment_plan_title}”. Add as many as the plan needs.`}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingPlan(true)}
              >
                <Pencil aria-hidden="true" />
                Edit plan
              </Button>
            }
          />
          <CardBody className="space-y-5">
            {plan.treatment_goal.length > 0 ? (
              <ul className="space-y-2">
                {plan.treatment_goal.map((goal) => (
                  <li
                    key={goal.treatment_goal_id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3 text-body"
                  >
                    {goal.treatment_goal_description}
                    {goal.treatment_goal_target_date ? (
                      <span className="mt-0.5 block text-sm text-muted">
                        Target: {formatDate(goal.treatment_goal_target_date)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">
                No goals yet. They can be added now or later.
              </p>
            )}

            <TreatmentGoalForm
              patientId={patientId}
              planId={plan.treatment_plan_id}
            />

            <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
              <Button
                className="max-sm:w-full"
                onClick={() => setStep('medication')}
              >
                Continue to medication
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* --- Step 3: prescription and medication schedule ---------------- */}
      {step === 'medication' ? (
        <Card>
          <CardHeader
            title="Medication"
            description="Issue the prescription and set when each dose is taken."
          />
          <CardBody className="space-y-5">
            {schedules.length > 0 ? (
              <ul className="space-y-2">
                {schedules.map((schedule) => (
                  <li
                    key={schedule.medication_schedule_id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3"
                  >
                    <p className="font-medium text-heading">
                      {schedule.medication_schedule_name}
                    </p>
                    <p className="mt-0.5 text-sm text-body">
                      {schedule.medication_schedule_dosage} ·{' '}
                      <span data-numeric>
                        {schedule.medication_schedule_times
                          .map(formatScheduleTime)
                          .join(', ')}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}

            {schedules.length === 0 || isAddingMedicine ? (
              <MedicationForm
                patientId={patientId}
                doctorId={doctorId}
                {...(prescriptionId ? { prescriptionId } : {})}
                onDone={() => setAddingMedicine(false)}
                {...(isAddingMedicine
                  ? { onCancel: () => setAddingMedicine(false) }
                  : {})}
              />
            ) : (
              <Button
                variant="secondary"
                className="max-sm:w-full"
                onClick={() => setAddingMedicine(true)}
              >
                <Pill aria-hidden="true" />
                Add another medicine
              </Button>
            )}

            <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
              <Button
                className="max-sm:w-full"
                onClick={() => setStep('review')}
              >
                Continue to review
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* --- Step 4: review what was actually written -------------------- */}
      {step === 'review' ? (
        <Card>
          <CardHeader
            title="Review"
            description="Everything below is already saved to the patient's record."
          />
          <CardBody className="space-y-5">
            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold text-heading">
                Treatment plan
              </h3>
              {plan ? (
                <p className="text-body">
                  {plan.treatment_plan_title} — from{' '}
                  {formatDate(plan.treatment_plan_start_date)}
                  {plan.treatment_plan_end_date
                    ? ` until ${formatDate(plan.treatment_plan_end_date)}`
                    : ', ongoing'}
                </p>
              ) : (
                <p className="text-sm text-muted">No plan was created.</p>
              )}
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold text-heading">Goals</h3>
              {plan && plan.treatment_goal.length > 0 ? (
                <ul className="list-inside list-disc space-y-1 text-body">
                  {plan.treatment_goal.map((goal) => (
                    <li key={goal.treatment_goal_id}>
                      {goal.treatment_goal_description}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No goals were added.</p>
              )}
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold text-heading">Medication</h3>
              {schedules.length > 0 ? (
                <ul className="list-inside list-disc space-y-1 text-body">
                  {schedules.map((schedule) => (
                    <li key={schedule.medication_schedule_id}>
                      {schedule.medication_schedule_name} ·{' '}
                      {schedule.medication_schedule_dosage}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">
                  No medication was prescribed.
                </p>
              )}
            </section>

            <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:justify-end sm:gap-3">
              <Button
                variant="ghost"
                className="max-sm:w-full"
                onClick={() => setStep('medication')}
              >
                Back to medication
              </Button>
              <Button
                className="max-sm:w-full"
                onClick={() => setStep('done')}
              >
                <Check aria-hidden="true" />
                Finish consultation
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* --- Step 5: finished -------------------------------------------- */}
      {step === 'done' ? (
        <Card>
          <CardBody className="space-y-4">
            <Notice tone="success" title="Consultation recorded" live="polite">
              {patientName} can see the plan and the medication schedule in
              their own account. Reminders follow the times you set.
            </Notice>
            <div className="flex justify-end">
              <Button className="max-sm:w-full" onClick={onFinish}>
                Back to the patient record
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}
