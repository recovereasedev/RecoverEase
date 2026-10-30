import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartLine,
  ListChecks,
  Pill,
  Target,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { FormError } from '@/components/feedback/form-error'
import { ErrorState, LoadingState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ProgressBar } from '@/components/ui/progress'
import { Tabs } from '@/components/ui/tabs'
import { fetchAppointments } from '@/features/appointments/api'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { addDays, deviceTimeZone, todayIn } from '@/features/calendar/calendar-model'
import { fetchAllDoses } from '@/features/medications/api'
import { fetchOwnClinicTimeZone } from '@/features/patients/api'
import { byTargetDate, summariseGoals, type PlanWithGoals } from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import { formatDate } from '@/lib/format'
import { treatmentGoalStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

import type { RecoveryActivity } from '../api'
import { PhaseTimeline } from '../components/phase-timeline'
import { useCompleteActivity, useReopenActivity, useRoadmap } from '../hooks'
import { planRoadmap, upcomingTasks, type PlanRoadmap, type UpcomingTask, type UpcomingTaskKind } from '../roadmap'

/** How far ahead Upcoming tasks looks: two weeks. */
const UPCOMING_DAYS = 14

const TASK_ICON: Record<UpcomingTaskKind, LucideIcon> = {
  activity: ListChecks,
  dose: Pill,
  appointment: CalendarClock,
  goal: Target,
}

/**
 * Module 5.7 "View Recovery Roadmap", enhanced (migration 45): the plan the
 * patient's doctor set, laid out as numbered phases with the activities the
 * patient marks done as they go, beside their treatment goals and what is
 * coming up.
 *
 * Nothing here is a second copy. Goals are the plan's; doses, appointments
 * and check-ins are read from where they live, and each upcoming item links
 * there to be acted on. The roadmap's percentage counts only the doctor's
 * activities and the goals linked to a phase (`roadmap.ts`); each active plan
 * has its own.
 */
export function PatientRoadmapPage() {
  useDocumentTitle('Recovery Roadmap')
  const user = useCurrentUser()
  const queryKeys = useQueryKeys()
  const patientId = user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const plansQuery = useTreatmentPlans(patientId)
  const activePlans = (plansQuery.data ?? []).filter((plan) => plan.treatment_plan_status === 'active')
  const roadmapQuery = useRoadmap(patientId, plansQuery.data ? activePlans : undefined)

  // Days and times in the clinic's zone, as the calendar keeps them.
  const zoneQuery = useQuery({
    queryKey: queryKeys.ownClinic.timeZone(),
    queryFn: fetchOwnClinicTimeZone,
  })
  const zone = zoneQuery.data ?? deviceTimeZone()
  const now = useNow()
  const today = todayIn(zone, new Date(now))
  const lastDay = addDays(today, UPCOMING_DAYS - 1)
  // A day either side, so no time zone's offset loses an item; each is
  // placed on its clinic day below.
  const from = `${addDays(today, -1)}T00:00:00Z`
  const to = `${addDays(lastDay, 1)}T23:59:59Z`

  const dosesQuery = useQuery({
    queryKey: queryKeys.medications.allDosesFor(patientId, from, to),
    queryFn: () => fetchAllDoses({ patientId, from, to }),
    enabled: Boolean(patientId),
  })
  const appointmentsQuery = useQuery({
    queryKey: queryKeys.appointments.forPatient(patientId),
    queryFn: () => fetchAppointments(patientId),
    enabled: Boolean(patientId),
  })

  const [chosenPlanId, setChosenPlanId] = useState<string | null>(null)
  const plan = activePlans.find((candidate) => candidate.treatment_plan_id === chosenPlanId) ?? activePlans[0]

  const complete = useCompleteActivity(patientId)
  const reopen = useReopenActivity(patientId)
  const [lastChange, setLastChange] = useState<{ at: number; text: string } | null>(null)
  const saving = complete.isPending ? complete.variables : reopen.isPending ? reopen.variables : null
  const changeError = complete.error ?? reopen.error

  // One press at a time. A second press arrives before the first has
  // re-rendered the page as saving, so it is held here, not by state. (The
  // database refuses a second completion all the same.)
  const pressing = useRef(false)
  const markDone = (activity: RecoveryActivity) => {
    if (pressing.current) return
    pressing.current = true
    reopen.reset()
    complete.mutate(activity.recovery_activity_id, {
      onSuccess: () =>
        setLastChange({ at: Date.now(), text: `Marked done: ${activity.recovery_activity_title}. Your doctor can see it.` }),
      onSettled: () => {
        pressing.current = false
      },
    })
  }
  const markNotDone = (activity: RecoveryActivity) => {
    if (pressing.current) return
    pressing.current = true
    complete.reset()
    reopen.mutate(activity.recovery_activity_id, {
      onSuccess: () => setLastChange({ at: Date.now(), text: `Marked not done: ${activity.recovery_activity_title}.` }),
      onSettled: () => {
        pressing.current = false
      },
    })
  }

  return (
    <>
      <PageHeader
        title="Recovery Roadmap"
        description="Your recovery plan, phase by phase: what you have done, and what comes next."
        actions={
          <Link to="/patient/recovery#progress-charts" className={cn(buttonVariants({ variant: 'outline' }), 'max-sm:w-full')}>
            <ChartLine aria-hidden="true" />
            View Progress Charts
          </Link>
        }
      />

      <StateView
        isPending={plansQuery.isPending}
        error={plansQuery.error}
        data={plansQuery.data ? activePlans : undefined}
        onRetry={() => void plansQuery.refetch()}
        loadingLabel="Loading your roadmap…"
        empty={
          <Card>
            <CardBody>
              <p className="font-medium text-heading">No active treatment plan</p>
              <p className="mt-1 text-sm text-muted">
                When your doctor sets your plan, its phases and activities appear here. Past plans stay on your{' '}
                <Link to="/patient/treatment" className="text-brand-700 underline underline-offset-4">
                  Treatment plan
                </Link>{' '}
                page.
              </p>
            </CardBody>
          </Card>
        }
      >
        {(plans) => {
          const current = plan ?? plans[0]!
          const roadmaps = roadmapQuery.data
            ? plans.map((candidate) => planRoadmap(candidate.treatment_plan_id, candidate.treatment_goal, roadmapQuery.data, today))
            : null
          const roadmap = roadmaps?.[plans.indexOf(current)] ?? null
          const body = (
            <PlanView
              plan={current}
              roadmap={roadmap}
              roadmapQuery={roadmapQuery}
              onComplete={markDone}
              onReopen={markNotDone}
              savingId={saving ?? null}
              tasks={
                roadmaps && dosesQuery.data && appointmentsQuery.data
                  ? upcomingTasks({
                      roadmaps: roadmap ? [roadmap] : [],
                      goals: current.treatment_goal,
                      doses: dosesQuery.data,
                      appointments: appointmentsQuery.data,
                      today,
                      lastDay,
                      now,
                      zone,
                    })
                  : null
              }
              tasksPending={dosesQuery.isPending || appointmentsQuery.isPending || roadmapQuery.isPending}
              tasksError={dosesQuery.error ?? appointmentsQuery.error ?? null}
              onRetryTasks={() => {
                void dosesQuery.refetch()
                void appointmentsQuery.refetch()
              }}
            />
          )
          return (
            <div className="space-y-5">
              {/* The outcome of a press, said once; the list itself shows it too. */}
              <p role="status" className="text-sm text-success-700 empty:hidden">
                {lastChange ? <span key={lastChange.at}>{lastChange.text}</span> : null}
              </p>
              {changeError ? (
                <FormError error={changeError} title="The activity was not updated" />
              ) : null}
              {plans.length > 1 ? (
                // Each active plan is its own roadmap, with its own progress.
                <Tabs
                  tabs={plans.map((candidate) => ({ id: candidate.treatment_plan_id, label: candidate.treatment_plan_title }))}
                  value={current.treatment_plan_id}
                  onChange={setChosenPlanId}
                >
                  {body}
                </Tabs>
              ) : (
                body
              )}
            </div>
          )
        }}
      </StateView>
    </>
  )
}

function PlanView({
  plan,
  roadmap,
  roadmapQuery,
  onComplete,
  onReopen,
  savingId,
  tasks,
  tasksPending,
  tasksError,
  onRetryTasks,
}: {
  plan: PlanWithGoals
  roadmap: PlanRoadmap | null
  roadmapQuery: { isPending: boolean; error: unknown; refetch: () => unknown }
  onComplete: (activity: RecoveryActivity) => void
  onReopen: (activity: RecoveryActivity) => void
  savingId: string | null
  tasks: UpcomingTask[] | null
  tasksPending: boolean
  tasksError: unknown
  onRetryTasks: () => void
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)] lg:items-start lg:gap-8">
      <div className="min-w-0 space-y-6">
        <CurrentPlanCard plan={plan} roadmap={roadmap} />

        <section aria-labelledby="phases-heading">
          <h2 id="phases-heading" className="text-headline-md text-heading">
            Recovery phases
          </h2>
          <p className="mt-0.5 text-sm text-muted">In the order your doctor set them.</p>
          <div className="mt-5">
            {roadmapQuery.isPending ? (
              <LoadingState label="Loading the phases…" />
            ) : roadmapQuery.error ? (
              <ErrorState error={roadmapQuery.error} onRetry={() => void roadmapQuery.refetch()} />
            ) : roadmap && roadmap.phases.length > 0 ? (
              <PhaseTimeline roadmap={roadmap} onComplete={onComplete} onReopen={onReopen} savingId={savingId} />
            ) : (
              <Card>
                <CardBody>
                  <p className="font-medium text-heading">No phases yet</p>
                  <p className="mt-1 text-sm text-muted">
                    Your doctor has not laid this plan out in phases yet. Its goals are beside it.
                  </p>
                </CardBody>
              </Card>
            )}
          </div>
        </section>
      </div>

      <aside className="space-y-6" aria-label="Treatment goals and upcoming tasks">
        <GoalsCard plan={plan} roadmap={roadmap} />
        <UpcomingCard tasks={tasks} isPending={tasksPending} error={tasksError} onRetry={onRetryTasks} />
      </aside>
    </div>
  )
}

/** The plan as a whole: what it is, when, and how far along its roadmap is. */
function CurrentPlanCard({ plan, roadmap }: { plan: PlanWithGoals; roadmap: PlanRoadmap | null }) {
  const count = roadmap?.count
  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <p className="text-sm font-medium text-accent-700">Current recovery goal</p>
          <h2 className="mt-1 text-headline-md text-heading">{plan.treatment_plan_title}</h2>
        </div>
        {plan.treatment_plan_description ? (
          <p className="whitespace-pre-wrap leading-relaxed text-body">{plan.treatment_plan_description}</p>
        ) : null}
        <p className="flex items-center gap-2 text-sm text-muted" data-numeric>
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          {formatDate(plan.treatment_plan_start_date)}
          {plan.treatment_plan_end_date ? ` — expected ${formatDate(plan.treatment_plan_end_date)}` : ' onwards'}
        </p>
        <div className="border-t border-[var(--color-border)] pt-4">
          {!count ? (
            <p className="text-sm text-muted">Working out your progress…</p>
          ) : count.percentage === null ? (
            <p className="text-sm text-muted">No activities yet</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-medium text-heading">Overall progress</p>
                <p className="text-headline-md text-heading" data-numeric>
                  {count.percentage}%
                </p>
              </div>
              <ProgressBar
                className="mt-2"
                value={count.percentage}
                tone="accent"
                label="Roadmap progress"
                valueText={`${count.done} of ${count.total} done`}
              />
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">Completed</dt>
                  <dd className="font-semibold text-heading" data-numeric>
                    {count.done} of {count.total}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Remaining</dt>
                  <dd className="font-semibold text-heading" data-numeric>
                    {count.remaining}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted">
                Counts the activities your doctor assigned and the goals placed in a phase. Medicines,
                appointments and check-ins have their own charts.
              </p>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

/** The plan's goals, as the doctor has marked them. */
function GoalsCard({ plan, roadmap }: { plan: PlanWithGoals; roadmap: PlanRoadmap | null }) {
  const goals = [...plan.treatment_goal].sort(byTargetDate)
  const summary = summariseGoals(plan.treatment_goal)
  const phaseOf = new Map(
    (roadmap?.phases ?? []).flatMap((phase) => phase.goals.map((goal) => [goal.treatment_goal_id, phase.number] as const)),
  )
  return (
    <Card>
      <CardHeader title="Treatment goals" as="h2" />
      <CardBody>
        {goals.length === 0 ? (
          <p className="text-sm text-muted">No goals have been set for this plan yet.</p>
        ) : (
          <>
            <p className="text-sm text-muted" data-numeric>
              {summary.achieved} of {summary.total} achieved
            </p>
            {/* A goal is achieved or not; the bar counts the achieved ones. */}
            <ProgressBar
              className="mt-2"
              value={summary.percentage ?? 0}
              tone="success"
              label="Goals achieved in this plan"
              valueText={`${summary.achieved} of ${summary.total} goals achieved`}
            />
            <ul className="mt-4 space-y-3">
              {goals.map((goal) => (
                <li key={goal.treatment_goal_id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-body">{goal.treatment_goal_description}</p>
                    <p className="mt-0.5 text-xs text-muted" data-numeric>
                      {goal.treatment_goal_target_date ? `By ${formatDate(goal.treatment_goal_target_date)}` : 'No target date'}
                      {phaseOf.has(goal.treatment_goal_id) ? ` · Phase ${phaseOf.get(goal.treatment_goal_id)}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={treatmentGoalStatus[goal.treatment_goal_status]} className="shrink-0" />
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === addDays(today, 1)) return 'Tomorrow'
  return formatDate(day)
}

/** What is coming up in the next two weeks, each linked to where it is done. */
function UpcomingCard({
  tasks,
  isPending,
  error,
  onRetry,
}: {
  tasks: UpcomingTask[] | null
  isPending: boolean
  error: unknown
  onRetry: () => void
}) {
  const now = useNow()
  const queryKeys = useQueryKeys()
  const zoneQuery = useQuery({ queryKey: queryKeys.ownClinic.timeZone(), queryFn: fetchOwnClinicTimeZone })
  const today = todayIn(zoneQuery.data ?? deviceTimeZone(), new Date(now))
  return (
    <Card>
      <CardHeader title="Upcoming tasks" description="The next two weeks." as="h2" />
      <CardBody>
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : isPending || !tasks ? (
          <LoadingState label="Loading what is coming up…" />
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted">Nothing is due in the next two weeks.</p>
        ) : (
          <ul className="space-y-3">
            {tasks.map((task) => {
              const Icon = TASK_ICON[task.kind]
              const inner = (
                <>
                  <Icon className="mt-0.5 size-4 shrink-0 text-brand-700" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-body">{task.title}</span>
                    <span className="mt-0.5 block text-xs text-muted" data-numeric>
                      {dayLabel(task.day, today)}
                      {task.time ? `, ${task.time}` : ''}
                    </span>
                  </span>
                  <StatusBadge status={task.status} className="shrink-0" />
                </>
              )
              const className =
                'flex items-start gap-3 rounded-[var(--radius-sm)] p-1 -m-1 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2'
              return (
                <li key={task.id}>
                  {task.href.startsWith('#') ? (
                    <a href={task.href} className={className}>
                      {inner}
                    </a>
                  ) : (
                    <Link to={task.href} className={className}>
                      {inner}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <Link
          to="/patient/calendar"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          <CalendarRange className="size-4" aria-hidden="true" />
          View Calendar
        </Link>
      </CardBody>
    </Card>
  )
}
