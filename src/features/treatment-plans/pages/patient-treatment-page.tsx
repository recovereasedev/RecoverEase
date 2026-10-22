import { CalendarDays, Download, Printer } from 'lucide-react'

import { FormError } from '@/components/feedback/form-error'
import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { ProgressBar } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  byTargetDate,
  summariseGoals,
  type TreatmentGoalStatus,
} from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFileDownload } from '@/lib/documents/download'
import { formatDate } from '@/lib/format'
import { treatmentGoalStatus, treatmentPlanStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

// The roadmap marker for each goal state. The status badge beside every goal
// still says the state in words; the marker is the same fact, drawn on the
// path, so the eye can see how far along the plan is at a glance.
const MARKER: Record<TreatmentGoalStatus, string> = {
  achieved: 'border-fill-success-600 bg-fill-success-600 text-white',
  in_progress: 'border-info-600 bg-info-50 text-info-700',
  pending: 'border-[var(--color-border-strong)] bg-surface text-neutral-500',
  missed: 'border-warning-600 bg-warning-50 text-warning-700',
}

/**
 * Modules 3.4 "View Treatment Plan", 3.5 "Download Treatment Plan as PDF",
 * 5.7 "View Recovery Roadmap" and 5.8 "View Treatment Goals".
 *
 * Module 3.5 is a real file: "Download plan (PDF)" builds the PDF in the
 * browser from the plans this page has loaded and saves it, with nothing
 * sent anywhere (`treatment-plan-document.ts`). Printing stays beside it -
 * the browser's own "Save as PDF" also produces a tagged, accessible PDF.
 *
 * RecoverEase 2.0 draws the plan as a roadmap rather than a form. The summary
 * - what the plan is, when it runs, how far through it the patient is - sits
 * beside the goals, and the goals run down a path in the order they are due,
 * each marked by its state: filled when achieved, ringed while in progress,
 * open until started. The path answers "what, when, and how far" in one look;
 * every goal still states its target date and its status in words.
 */
export function PatientTreatmentPage() {
  useDocumentTitle('Treatment Plan')
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const plansQuery = useTreatmentPlans(patientId)
  const planFile = useFileDownload()
  const patient = user.profile.kind === 'patient' ? user.profile.patient : null

  const downloadPlan = () => {
    const plans = plansQuery.data
    if (!patient || !plans) return
    void planFile.download(async () => {
      const { buildTreatmentPlanPdf } = await import(
        '@/features/treatment-plans/treatment-plan-document'
      )
      return buildTreatmentPlanPdf({ patient, plans, generatedAt: new Date() })
    })
  }

  return (
    <>
      <PageHeader
        title="Treatment plan"
        description="The programme your doctor has set, and the goals along the way."
        actions={
          <>
            <Button
              variant="outline"
              // Controls, so on screen only: the printout is the plan.
              className="max-sm:w-full print:hidden"
              onClick={downloadPlan}
              disabled={!plansQuery.data}
              isLoading={planFile.isPending}
              loadingLabel="Preparing…"
            >
              <Download aria-hidden="true" />
              Download plan (PDF)
            </Button>
            <Button
              variant="outline"
              className="max-sm:w-full print:hidden"
              onClick={() => window.print()}
            >
              <Printer aria-hidden="true" />
              Print or save as PDF
            </Button>
          </>
        }
      />

      {planFile.error ? (
        <div className="mb-6 print:hidden">
          <FormError error={planFile.error} title="The plan was not downloaded" />
        </div>
      ) : null}

      <StateView
        isPending={plansQuery.isPending}
        error={plansQuery.error}
        data={plansQuery.data}
        onRetry={() => void plansQuery.refetch()}
        loadingLabel="Loading your treatment plan…"
        empty={
          <Card>
            <CardBody>
              <p className="font-medium text-heading">No treatment plan yet</p>
              <p className="mt-1 text-sm text-muted">
                When your doctor creates your plan it will appear here, with
                the goals you are working towards.
              </p>
            </CardBody>
          </Card>
        }
      >
        {(plans) => (
          <div className="space-y-section lg:space-y-section-lg">
            {plans.map((plan) => {
              const progress = summariseGoals(plan.treatment_goal)
              const goals = [...plan.treatment_goal].sort(byTargetDate)
              const headingId = `plan-${plan.treatment_plan_id}`
              return (
                <section
                  key={plan.treatment_plan_id}
                  aria-labelledby={headingId}
                  className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-10"
                >
                  {/* --- The plan ------------------------------------------ */}
                  <Card className="lg:sticky lg:top-28 print:static">
                    <CardBody className="space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <h2
                          id={headingId}
                          className="text-headline-md text-heading"
                        >
                          {plan.treatment_plan_title}
                        </h2>
                        <StatusBadge
                          status={treatmentPlanStatus[plan.treatment_plan_status]}
                        />
                      </div>

                      <p className="flex items-center gap-2 text-sm text-muted">
                        <CalendarDays
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span data-numeric>
                          {formatDate(plan.treatment_plan_start_date)}
                          {plan.treatment_plan_end_date
                            ? ` — ${formatDate(plan.treatment_plan_end_date)}`
                            : ' onwards'}
                        </span>
                      </p>

                      {plan.treatment_plan_description ? (
                        <p className="whitespace-pre-wrap leading-relaxed text-body">
                          {plan.treatment_plan_description}
                        </p>
                      ) : null}

                      {progress.total > 0 ? (
                        <div className="border-t border-[var(--color-border)] pt-4">
                          <p className="text-sm text-muted" data-numeric>
                            {progress.achieved} of {progress.total} achieved
                          </p>
                          {/* Restates the count above it. The percentage
                              comes from `summariseGoals` over goals the
                              doctor has already marked - nothing here is
                              inferred. */}
                          <ProgressBar
                            className="mt-2"
                            value={progress.percentage ?? 0}
                            tone="accent"
                            label="Goals achieved in this plan"
                            valueText={`${progress.achieved} of ${progress.total} goals achieved`}
                          />
                        </div>
                      ) : null}
                    </CardBody>
                  </Card>

                  {/* --- The roadmap --------------------------------------- */}
                  <div>
                    <h3 className="text-headline-md text-heading">Goals</h3>
                    {goals.length === 0 ? (
                      <p className="mt-2 text-sm text-muted">
                        No goals have been set for this plan yet.
                      </p>
                    ) : (
                      <>
                        <p className="mt-0.5 text-sm text-muted">
                          In the order they are due.
                        </p>
                        <ol className="mt-5">
                          {goals.map((goal, index) => {
                            const status =
                              treatmentGoalStatus[goal.treatment_goal_status]
                            const Icon = status.icon
                            const isLast = index === goals.length - 1
                            const isAchieved =
                              goal.treatment_goal_status === 'achieved'
                            return (
                              <li
                                key={goal.treatment_goal_id}
                                className={cn(
                                  'relative flex gap-4',
                                  !isLast && 'pb-7',
                                )}
                              >
                                {/* The path to the next goal: green once
                                    this one is behind the patient. */}
                                {!isLast ? (
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      'absolute bottom-0 left-4 top-9 w-0.5 -translate-x-1/2 rounded-full',
                                      isAchieved
                                        ? 'bg-success-600'
                                        : 'bg-[var(--color-border-strong)]',
                                    )}
                                  />
                                ) : null}
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    'relative flex size-8 shrink-0 items-center justify-center rounded-full border-2',
                                    MARKER[goal.treatment_goal_status],
                                  )}
                                >
                                  <Icon className="size-4" />
                                </span>
                                <div className="min-w-0 flex-1 pt-0.5">
                                  <p className="font-medium text-heading">
                                    {goal.treatment_goal_description}
                                  </p>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
                                    <span data-numeric>
                                      {goal.treatment_goal_target_date
                                        ? `By ${formatDate(goal.treatment_goal_target_date)}`
                                        : 'No target date'}
                                    </span>
                                    <StatusBadge status={status} />
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ol>
                      </>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </StateView>
    </>
  )
}
