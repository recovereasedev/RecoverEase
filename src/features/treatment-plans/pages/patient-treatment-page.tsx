import { ClipboardList, Printer } from 'lucide-react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useCurrentUser } from '@/features/auth/auth-context'
import { summariseGoals } from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { formatDate } from '@/lib/format'
import { treatmentGoalStatus, treatmentPlanStatus } from '@/lib/status'

/**
 * Modules 3.4 "View Treatment Plan", 3.5 "Download Treatment Plan as PDF",
 * 5.7 "View Recovery Roadmap" and 5.8 "View Treatment Goals".
 *
 * Module 3.5 is served by the browser's own print pipeline, which produces a
 * real PDF through "Save as PDF" on every platform. The alternative — a
 * button that calls a server that does not exist yet — would be a download
 * that never arrives.
 */
export function PatientTreatmentPage() {
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const plansQuery = useTreatmentPlans(patientId)

  return (
    <>
      <PageHeader
        title="Treatment plan"
        description="The programme your doctor has set, and the goals along the way."
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            Print or save as PDF
          </Button>
        }
      />

      <StateView
        isPending={plansQuery.isPending}
        error={plansQuery.error}
        data={plansQuery.data}
        onRetry={() => void plansQuery.refetch()}
        loadingLabel="Loading your treatment plan…"
        empty={
          <Card>
            <CardBody>
              <div className="py-8 text-center">
                <ClipboardList
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  No treatment plan yet
                </p>
                <p className="mt-1 text-sm text-muted">
                  When your doctor creates your plan it will appear here, with
                  the goals you are working towards.
                </p>
              </div>
            </CardBody>
          </Card>
        }
      >
        {(plans) => (
          <div className="space-y-5">
            {plans.map((plan) => {
              const progress = summariseGoals(plan.treatment_goal)

              return (
                <Card key={plan.treatment_plan_id}>
                  <CardHeader
                    title={plan.treatment_plan_title}
                    description={`${formatDate(plan.treatment_plan_start_date)}${
                      plan.treatment_plan_end_date
                        ? ` — ${formatDate(plan.treatment_plan_end_date)}`
                        : ' onwards'
                    }`}
                    action={
                      <StatusBadge
                        status={
                          treatmentPlanStatus[plan.treatment_plan_status]
                        }
                      />
                    }
                  />
                  <CardBody className="space-y-5">
                    {plan.treatment_plan_description ? (
                      <p className="whitespace-pre-wrap leading-relaxed text-body">
                        {plan.treatment_plan_description}
                      </p>
                    ) : null}

                    <div>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="font-semibold text-heading">
                          Goals
                        </h3>
                        {progress.total > 0 ? (
                          <p className="text-sm text-muted" data-numeric>
                            {progress.achieved} of {progress.total} achieved
                          </p>
                        ) : null}
                      </div>

                      {plan.treatment_goal.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">
                          No goals have been set for this plan yet.
                        </p>
                      ) : (
                        <ol className="mt-3 space-y-2">
                          {plan.treatment_goal.map((goal) => (
                            <li
                              key={goal.treatment_goal_id}
                              className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-body">
                                  {goal.treatment_goal_description}
                                </p>
                                {goal.treatment_goal_target_date ? (
                                  <p className="mt-0.5 text-sm text-muted">
                                    Target:{' '}
                                    {formatDate(goal.treatment_goal_target_date)}
                                  </p>
                                ) : null}
                              </div>
                              <StatusBadge
                                status={
                                  treatmentGoalStatus[goal.treatment_goal_status]
                                }
                              />
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        )}
      </StateView>
    </>
  )
}
