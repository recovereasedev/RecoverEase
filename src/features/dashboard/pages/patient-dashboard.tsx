import { endOfToday, format, startOfToday } from 'date-fns'
import {
  AlarmClock,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Flame,
  NotebookPen,
  Pill,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { FormError } from '@/components/feedback/form-error'
import { InlineEmpty, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge, StatusBadge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { ProgressBar } from '@/components/ui/progress'
import { PageSection } from '@/components/ui/section-heading'
import { useAppointments, useSetAppointmentStatus } from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
import { patientDoseState } from '@/features/medications/dose-status'
import { useDoses, useSetDoseStatus } from '@/features/medications/hooks'
import { calculateStreak } from '@/features/recovery-logs/api'
import { useRecoveryLogs } from '@/features/recovery-logs/hooks'
import { summariseGoals } from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { useNow } from '@/hooks/use-now'
import { formatDate, formatDateTime, formatTime, toDateKey } from '@/lib/format'
import { appointmentStatus, patientDoseStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

function greeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Module 5.6 "View Personal Recovery Dashboard".
 *
 * RecoverEase 2.0 answers one question first: "what do I need to do today?"
 *
 * - **Today** is the one raised surface on the screen. It holds every action a
 *   patient owes today - each dose, then today's recovery entry - in one list,
 *   so the answer is a single place to look rather than three cards of equal
 *   weight. An overdue dose is tinted, told in words ("Overdue", with its
 *   icon), and given the solid button: it is the most urgent thing a patient
 *   can do here, so it is the easiest thing to see and to press.
 * - **Your recovery** is encouragement, not instruction: the streak, and how
 *   far through the treatment goals they are, with the next goal named.
 * - **Upcoming care** is the next appointment, with the one action it can take.
 *
 * On a phone the three stack in that order, so the first thing on screen is
 * the dose that is due, not a streak counter. There are no summary tiles
 * showing numbers the patient cannot act on.
 */
export function PatientDashboard() {
  useDocumentTitle('Dashboard')
  // "Mark taken" and "Confirm attendance" leave once they have worked: keyboard
  // focus moves on to the next thing on the page rather than to its top.
  const focusRecovery = useFocusRecovery()
  const user = useCurrentUser()
  const patient =
    user.profile.kind === 'patient' ? user.profile.patient : null

  const patientId = patient?.pat_id ?? ''
  const firstName = patient?.pat_first_name ?? ''

  const dosesQuery = useDoses(
    patientId,
    startOfToday().toISOString(),
    endOfToday().toISOString(),
  )
  const logsQuery = useRecoveryLogs(patientId)
  const appointmentsQuery = useAppointments(patientId)
  const plansQuery = useTreatmentPlans(patientId)
  const setDoseStatus = useSetDoseStatus(patientId)
  // Re-evaluated every minute, so a dose turns Overdue while the page is open.
  const now = useNow()
  const setAppointmentStatus = useSetAppointmentStatus()
  // The dose the patient has just marked, so only its badge animates in -
  // never every badge on the page when it loads.
  const [confirmedId, setConfirmedId] = useState<string | null>(null)

  const todayKey = toDateKey()
  const loggedToday = logsQuery.data?.some(
    (log) => log.recovery_log_date === todayKey,
  )
  const streak = logsQuery.data ? calculateStreak(logsQuery.data) : 0

  const nextAppointment = appointmentsQuery.data
    ?.filter(
      (appointment) =>
        new Date(appointment.appointment_date) >= new Date() &&
        appointment.appointment_status !== 'cancelled',
    )
    .sort(
      (a, b) =>
        new Date(a.appointment_date).getTime() -
        new Date(b.appointment_date).getTime(),
    )[0]

  const activePlan = plansQuery.data?.find(
    (plan) => plan.treatment_plan_status === 'active',
  )
  const goalProgress = activePlan
    ? summariseGoals(activePlan.treatment_goal)
    : null
  // The goal to work on next: the earliest target not yet achieved.
  const nextGoal = activePlan?.treatment_goal
    .filter((goal) => goal.treatment_goal_status !== 'achieved')
    .sort((a, b) =>
      (a.treatment_goal_target_date ?? '9999').localeCompare(
        b.treatment_goal_target_date ?? '9999',
      ),
    )[0]

  const doses = dosesQuery.data ?? []
  const takenCount = doses.filter(
    (dose) => dose.medication_log_status === 'taken',
  ).length
  const overdueCount = doses.filter(
    (dose) => patientDoseState(dose, now) === 'overdue',
  ).length

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={format(new Date(now), 'EEEE d MMMM')}
      />

      <div
        ref={focusRecovery}
        className="grid gap-section lg:grid-cols-3 lg:gap-8"
      >
        {/* --- Today ------------------------------------------------------- */}
        <PageSection
          className="lg:col-span-2"
          title="Today"
          description={
            doses.length > 0 ? (
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                <span data-numeric>
                  {takenCount} of {doses.length}{' '}
                  {doses.length === 1 ? 'dose' : 'doses'} taken
                </span>
                {overdueCount > 0 ? (
                  <span className="inline-flex items-center gap-1 font-medium text-warning-800">
                    <AlarmClock className="size-4" aria-hidden="true" />
                    {overdueCount} overdue
                  </span>
                ) : null}
              </span>
            ) : undefined
          }
          action={
            <Link
              to="/patient/medications"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              All medication
              <ArrowRight aria-hidden="true" />
            </Link>
          }
        >
          <Card variant="elevated" className="overflow-hidden">
            <StateView
              isPending={dosesQuery.isPending}
              error={dosesQuery.error}
              data={dosesQuery.data}
              onRetry={() => void dosesQuery.refetch()}
              loadingLabel="Loading today’s doses…"
              empty={
                <InlineEmpty icon={Pill}>
                  No doses scheduled today. When your doctor sets a medication
                  schedule, the doses will appear here.
                </InlineEmpty>
              }
            >
              {(todayDoses) => (
                <ListRows>
                  {todayDoses.map((dose) => {
                    const state = patientDoseState(dose, now)
                    const status = patientDoseStatus[state]
                    const isDone = dose.medication_log_status === 'taken'
                    const isOverdue = state === 'overdue'
                    const name =
                      dose.medication_schedule?.medication_schedule_name ??
                      'Medication'
                    const time = formatTime(dose.medication_log_scheduled_at)
                    return (
                      <ListRow
                        key={dose.medication_log_id}
                        // The tint is a second cue; the word Overdue and its
                        // icon carry the state on their own.
                        className={cn(isOverdue && 'bg-warning-50')}
                        title={name}
                        description={
                          <>
                            {
                              dose.medication_schedule
                                ?.medication_schedule_dosage
                            }{' '}
                            · due <span data-numeric>{time}</span>
                          </>
                        }
                        status={
                          <StatusBadge
                            key={state}
                            status={status}
                            className={cn(
                              isDone &&
                                confirmedId === dose.medication_log_id &&
                                'motion-confirm',
                            )}
                          />
                        }
                        actions={
                          !isDone ? (
                            <Button
                              size="sm"
                              variant={isOverdue ? 'primary' : 'secondary'}
                              isLoading={
                                setDoseStatus.isPending &&
                                setDoseStatus.variables?.doseId ===
                                  dose.medication_log_id
                              }
                              onClick={() => {
                                setConfirmedId(dose.medication_log_id)
                                setDoseStatus.mutate({
                                  doseId: dose.medication_log_id,
                                  status: 'taken',
                                })
                              }}
                            >
                              Mark taken
                              <span className="sr-only">
                                : {name} at {time}
                              </span>
                            </Button>
                          ) : null
                        }
                      />
                    )
                  })}
                </ListRows>
              )}
            </StateView>

            {/* Today's recovery entry - the other thing a patient owes
                today, in the same list of things to do. */}
            <ListRows className="border-t border-[var(--color-border)]">
              <ListRow
                title="Today’s recovery entry"
                description={
                  loggedToday
                    ? 'Recorded. Thank you.'
                    : 'A short note each day is what your doctor reviews before your next appointment.'
                }
                status={
                  loggedToday ? (
                    <Badge tone="success">
                      <CheckCircle2 className="size-3.5" aria-hidden="true" />
                      Recorded
                    </Badge>
                  ) : null
                }
                actions={
                  <Link
                    to="/patient/recovery"
                    className={buttonVariants({
                      variant: loggedToday ? 'ghost' : 'primary',
                      size: 'sm',
                    })}
                  >
                    {loggedToday ? null : <NotebookPen aria-hidden="true" />}
                    {loggedToday ? 'Edit today’s entry' : 'Log today'}
                  </Link>
                }
              />
            </ListRows>
          </Card>
        </PageSection>

        <div className="space-y-section">
          {/* --- Your recovery ----------------------------------------------
              Module 5.12 (streak) and 5.8 (goals). */}
          <PageSection title="Your recovery">
            <Card>
              <CardBody className="space-y-4">
                <div className="flex items-center gap-3">
                  <Flame
                    className="size-6 shrink-0 text-warning-700"
                    aria-hidden="true"
                  />
                  <p className="text-body">
                    <span
                      className="text-headline-md text-heading"
                      data-numeric
                    >
                      {streak}
                    </span>{' '}
                    {streak === 1 ? 'day logged in a row' : 'days logged in a row'}
                  </p>
                </div>
                {streak === 0 ? (
                  <p className="text-sm text-muted">
                    Log today to start a streak.
                  </p>
                ) : null}

                <div className="border-t border-[var(--color-border)] pt-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-base font-semibold text-heading">
                      Treatment goals
                    </h3>
                    <Link
                      to="/patient/treatment"
                      className="inline-flex min-h-11 items-center text-sm font-semibold text-role hover:underline sm:min-h-0"
                    >
                      View plan
                    </Link>
                  </div>
                  {plansQuery.isPending ? (
                    <p className="mt-2 text-sm text-muted">Loading…</p>
                  ) : goalProgress && goalProgress.total > 0 ? (
                    <>
                      <p className="mt-1 text-sm text-muted">
                        <span className="font-medium text-heading" data-numeric>
                          {goalProgress.achieved} of {goalProgress.total}
                        </span>{' '}
                        achieved
                      </p>
                      {/* The bar repeats the sentence above rather than
                          replacing it, so the information does not depend
                          on seeing it. */}
                      <ProgressBar
                        className="mt-2"
                        value={goalProgress.percentage ?? 0}
                        tone="accent"
                        label="Treatment goals achieved"
                        valueText={`${goalProgress.achieved} of ${goalProgress.total} goals achieved`}
                      />
                      {nextGoal ? (
                        <p className="mt-3 flex items-start gap-2 text-sm text-body">
                          <Target
                            className="mt-0.5 size-4 shrink-0 text-muted"
                            aria-hidden="true"
                          />
                          <span>
                            <span className="text-muted">Next: </span>
                            {nextGoal.treatment_goal_description}
                            {nextGoal.treatment_goal_target_date ? (
                              <span className="text-muted">
                                {' '}
                                · by{' '}
                                {formatDate(nextGoal.treatment_goal_target_date)}
                              </span>
                            ) : null}
                          </span>
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-muted">
                      Your doctor has not set any goals yet.
                    </p>
                  )}
                </div>
              </CardBody>
            </Card>
          </PageSection>

          {/* --- Upcoming care --------------------------------------------- */}
          <PageSection
            title="Upcoming care"
            action={
              <Link
                to="/patient/appointments"
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                All appointments
                <ArrowRight aria-hidden="true" />
              </Link>
            }
          >
            <Card>
              {appointmentsQuery.isPending ? (
                <CardBody>
                  <p className="text-muted">Loading…</p>
                </CardBody>
              ) : nextAppointment ? (
                <CardBody className="space-y-3">
                  <div>
                    <p className="text-sm text-muted">Next appointment</p>
                    <p className="mt-0.5 flex items-start gap-2 text-body-lg font-semibold text-heading">
                      <CalendarDays
                        className="mt-1 size-5 shrink-0 text-role"
                        aria-hidden="true"
                      />
                      <span data-numeric>
                        {formatDateTime(nextAppointment.appointment_date)}
                      </span>
                    </p>
                  </div>
                  <StatusBadge
                    status={appointmentStatus[nextAppointment.appointment_status]}
                  />
                  {nextAppointment.appointment_status === 'scheduled' ? (
                    <Button
                      block
                      isLoading={setAppointmentStatus.isPending}
                      onClick={() =>
                        setAppointmentStatus.mutate({
                          appointmentId: nextAppointment.appointment_id,
                          status: 'confirmed',
                        })
                      }
                    >
                      Confirm attendance
                    </Button>
                  ) : null}
                  {/* A confirmation the server refused says so (NA-02). */}
                  {setAppointmentStatus.isError &&
                  setAppointmentStatus.variables?.appointmentId ===
                    nextAppointment.appointment_id ? (
                    <FormError
                      error={setAppointmentStatus.error}
                      title="Your attendance was not confirmed"
                    />
                  ) : null}
                </CardBody>
              ) : (
                <InlineEmpty
                  icon={CalendarDays}
                  action={
                    <Link
                      to="/patient/appointments"
                      className={buttonVariants({
                        variant: 'secondary',
                        size: 'sm',
                      })}
                    >
                      Book a follow-up
                    </Link>
                  }
                >
                  You have no upcoming appointments.
                </InlineEmpty>
              )}
            </Card>
          </PageSection>
        </div>
      </div>
    </>
  )
}
