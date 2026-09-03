import {
  ArrowRight,
  CalendarDays,
  Flame,
  NotebookPen,
  Pill,
  Target,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { endOfToday, startOfToday } from 'date-fns'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { ProgressBar } from '@/components/ui/progress'
import { useAppointments, useSetAppointmentStatus } from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useDoses, useSetDoseStatus } from '@/features/medications/hooks'
import { calculateStreak } from '@/features/recovery-logs/api'
import { useRecoveryLogs } from '@/features/recovery-logs/hooks'
import { summariseGoals } from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { formatDateTime, formatTime, toDateKey } from '@/lib/format'
import { appointmentStatus, medicationLogStatus } from '@/lib/status'

function greeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Module 5.6 "View Personal Recovery Dashboard".
 *
 * Ordered by what the patient has to DO today, not by what is easiest to
 * display. Doses due, then today's log, then the next appointment. Progress
 * and streaks sit to the side: they are encouragement, not instructions.
 *
 * That ordering is also the mobile ordering, and it is the reason the
 * encouragement column is second in the document rather than first. On a
 * phone the columns become one, and whatever is first is what a patient sees
 * when they open the app one-handed — which should be the dose that is due,
 * not a streak counter.
 *
 * There are no summary tiles showing numbers the patient cannot act on.
 */
export function PatientDashboard() {
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
  const setAppointmentStatus = useSetAppointmentStatus()

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

  return (
    <>
      <PageHeader
        eyebrow="Today"
        title={`${greeting()}, ${firstName}`}
        description="Here is what your recovery asks of you today."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* --- Main column ---------------------------------------------- */}
        <div className="space-y-5 lg:col-span-2">
          {/* Today's medication */}
          <Card>
            <CardHeader
              icon={Pill}
              title="Today’s medication"
              description="Mark each dose once you have taken it."
              action={
                <Link
                  to="/patient/medications"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  All medication
                  <ArrowRight aria-hidden="true" />
                </Link>
              }
            />
            <CardBody className="p-0">
              <StateView
                isPending={dosesQuery.isPending}
                error={dosesQuery.error}
                data={dosesQuery.data}
                onRetry={() => void dosesQuery.refetch()}
                loadingLabel="Loading today’s doses…"
                empty={
                  <div className="px-4 py-10 text-center sm:px-5">
                    <Pill
                      className="mx-auto size-6 text-neutral-400"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-medium text-heading">
                      No doses scheduled today
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      When your doctor sets a medication schedule, the doses
                      will appear here.
                    </p>
                  </div>
                }
              >
                {(doses) => (
                  <ListRows>
                    {doses.map((dose) => {
                      const status =
                        medicationLogStatus[dose.medication_log_status]
                      const isDone = dose.medication_log_status === 'taken'
                      const name =
                        dose.medication_schedule?.medication_schedule_name ??
                        'Medication'
                      const time = formatTime(dose.medication_log_scheduled_at)

                      return (
                        <ListRow
                          key={dose.medication_log_id}
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
                          status={<StatusBadge status={status} />}
                          actions={
                            !isDone ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                isLoading={
                                  setDoseStatus.isPending &&
                                  setDoseStatus.variables?.doseId ===
                                    dose.medication_log_id
                                }
                                onClick={() =>
                                  setDoseStatus.mutate({
                                    doseId: dose.medication_log_id,
                                    status: 'taken',
                                  })
                                }
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
            </CardBody>
          </Card>

          {/* Today's recovery log */}
          <Card>
            <CardHeader
              icon={NotebookPen}
              title="Today’s recovery entry"
              description="A short note each day is what your doctor reviews before your next appointment."
            />
            <CardBody>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <p className="text-body">
                  {loggedToday
                    ? 'You have recorded today’s entry. Thank you.'
                    : 'You have not logged today yet.'}
                </p>
                <Link
                  to="/patient/recovery"
                  className={buttonVariants({
                    variant: loggedToday ? 'secondary' : 'primary',
                    size: 'sm',
                    className: 'max-sm:w-full',
                  })}
                >
                  {loggedToday ? null : <NotebookPen aria-hidden="true" />}
                  {loggedToday ? 'Edit today’s entry' : 'Log today'}
                </Link>
              </div>
            </CardBody>
          </Card>

          {/* Next appointment */}
          <Card>
            <CardHeader
              icon={CalendarDays}
              title="Next appointment"
              action={
                <Link
                  to="/patient/appointments"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  All appointments
                  <ArrowRight aria-hidden="true" />
                </Link>
              }
            />
            <CardBody>
              {appointmentsQuery.isPending ? (
                <p className="text-muted">Loading…</p>
              ) : nextAppointment ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex items-start gap-2 font-medium text-heading">
                      <CalendarDays
                        className="mt-0.5 size-4 shrink-0 text-brand-700"
                        aria-hidden="true"
                      />
                      {formatDateTime(nextAppointment.appointment_date)}
                    </p>
                    <div className="mt-2">
                      <StatusBadge
                        status={
                          appointmentStatus[nextAppointment.appointment_status]
                        }
                      />
                    </div>
                  </div>

                  {nextAppointment.appointment_status === 'scheduled' ? (
                    <Button
                      size="sm"
                      className="max-sm:w-full"
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
                </div>
              ) : (
                <p className="text-muted">
                  You have no upcoming appointments.{' '}
                  <Link
                    to="/patient/appointments"
                    className="font-medium text-brand-700 hover:underline"
                  >
                    Book a follow-up
                  </Link>
                  .
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        {/* --- Side column ------------------------------------------------ */}
        <div className="space-y-5">
          {/* Streak — module 5.12 */}
          <Card>
            <CardBody className="flex items-center gap-4 sm:flex-col sm:text-center">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-warning-50">
                <Flame className="size-6 text-warning-700" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p
                  className="text-headline-lg font-bold text-heading"
                  data-numeric
                >
                  {streak}
                </p>
                <p className="text-sm text-muted">
                  {streak === 1
                    ? 'day logged in a row'
                    : 'days logged in a row'}
                </p>
                {streak === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    Log today to start a streak.
                  </p>
                ) : null}
              </div>
            </CardBody>
          </Card>

          {/* Goals — module 5.8 */}
          <Card>
            <CardHeader
              title="Treatment goals"
              as="h2"
              action={
                <Link
                  to="/patient/treatment"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  View plan
                </Link>
              }
            />
            <CardBody>
              {plansQuery.isPending ? (
                <p className="text-muted">Loading…</p>
              ) : goalProgress && goalProgress.total > 0 ? (
                <>
                  <p className="text-sm text-muted">
                    <span className="font-medium text-heading" data-numeric>
                      {goalProgress.achieved} of {goalProgress.total}
                    </span>{' '}
                    achieved
                  </p>
                  {/* The bar repeats the sentence above rather than replacing
                      it, so the information does not depend on seeing it. */}
                  <ProgressBar
                    className="mt-2"
                    value={goalProgress.percentage ?? 0}
                    tone="accent"
                    label="Treatment goals achieved"
                    valueText={`${goalProgress.achieved} of ${goalProgress.total} goals achieved`}
                  />
                </>
              ) : (
                <p className="flex items-start gap-2 text-sm text-muted">
                  <Target className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Your doctor has not set any goals yet.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}
