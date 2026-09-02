import { endOfToday, startOfToday } from 'date-fns'
import { ArrowRight, CalendarCheck, Inbox, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import {
  useAppointments,
  useDecideRescheduleRequest,
  useRescheduleRequests,
} from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useMyPatients } from '@/features/patients/hooks'
import { formatDateTime, formatTime } from '@/lib/format'
import { appointmentStatus } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * The clinician's landing screen.
 *
 * Ordered by what needs a decision. Reschedule requests come first because
 * they are the only thing on the page blocking somebody else — a patient is
 * waiting on each one. Today's clinic list follows, then the caseload.
 *
 * There is no "total patients seen" tile or similar: a number the clinician
 * cannot act on is display, not information.
 */
export function DoctorDashboard() {
  const user = useCurrentUser()
  const doctor = user.profile.kind === 'doctor' ? user.profile.doctor : null

  const patientsQuery = useMyPatients()
  const appointmentsQuery = useAppointments()
  const requestsQuery = useRescheduleRequests()
  const decide = useDecideRescheduleRequest()

  const todayStart = startOfToday()
  const todayEnd = endOfToday()

  const todaysAppointments = (appointmentsQuery.data ?? [])
    .filter((appointment) => {
      const when = new Date(appointment.appointment_date)
      return when >= todayStart && when <= todayEnd
    })
    .sort(
      (a, b) =>
        new Date(a.appointment_date).getTime() -
        new Date(b.appointment_date).getTime(),
    )

  const pendingRequests = (requestsQuery.data ?? []).filter(
    (request) => request.reschedule_request_status === 'pending',
  )

  const activePatients = (patientsQuery.data ?? []).filter(
    (patient) => patient.pat_status === 'active',
  )

  return (
    <>
      <PageHeader
        title={`Good day, ${doctor?.doc_first_name ?? ''}`}
        description="What needs your attention today."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* --- Pending decisions — modules 6.3, 6.4 -------------------- */}
          <Card>
            <CardHeader
              title="Reschedule requests"
              description="Patients waiting on your decision."
            />
            <CardBody className="p-0">
              <StateView
                isPending={requestsQuery.isPending}
                error={requestsQuery.error}
                data={pendingRequests}
                onRetry={() => void requestsQuery.refetch()}
                empty={
                  <div className="px-5 py-10 text-center">
                    <Inbox
                      className="mx-auto size-6 text-neutral-400"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-medium text-heading">
                      Nothing waiting
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      Reschedule requests from your patients appear here.
                    </p>
                  </div>
                }
              >
                {(requests) => (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {requests.map((request) => {
                      const patient = request.appointment?.patient
                      const isDeciding =
                        decide.isPending &&
                        decide.variables?.requestId ===
                          request.reschedule_request_id

                      return (
                        <li
                          key={request.reschedule_request_id}
                          className="px-5 py-4"
                        >
                          <p className="font-medium text-heading">
                            {patient
                              ? fullName(
                                  patient.pat_first_name,
                                  patient.pat_last_name,
                                )
                              : 'A patient'}
                          </p>
                          <p className="mt-1 text-sm text-body">
                            Asked to move{' '}
                            {request.appointment
                              ? formatDateTime(
                                  request.appointment.appointment_date,
                                )
                              : 'their appointment'}{' '}
                            to{' '}
                            <span className="font-medium text-heading">
                              {formatDateTime(request.reschedule_request_date)}
                            </span>
                            .
                          </p>
                          {request.reschedule_request_reason ? (
                            <p className="mt-2 rounded-[var(--radius-sm)] bg-surface-sunken px-3 py-2 text-sm text-body">
                              “{request.reschedule_request_reason}”
                            </p>
                          ) : null}

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              isLoading={isDeciding}
                              onClick={() =>
                                decide.mutate({
                                  requestId: request.reschedule_request_id,
                                  decision: 'approved',
                                })
                              }
                            >
                              Approve and move
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                decide.mutate({
                                  requestId: request.reschedule_request_id,
                                  decision: 'declined',
                                })
                              }
                            >
                              Decline
                            </Button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </StateView>
            </CardBody>
          </Card>

          {/* --- Today's clinic --------------------------------------------- */}
          <Card>
            <CardHeader
              title="Today’s appointments"
              action={
                <Link
                  to="/doctor/appointments"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  All appointments
                  <ArrowRight aria-hidden="true" />
                </Link>
              }
            />
            <CardBody className="p-0">
              <StateView
                isPending={appointmentsQuery.isPending}
                error={appointmentsQuery.error}
                data={todaysAppointments}
                onRetry={() => void appointmentsQuery.refetch()}
                empty={
                  <div className="px-5 py-10 text-center">
                    <CalendarCheck
                      className="mx-auto size-6 text-neutral-400"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-medium text-heading">
                      No appointments today
                    </p>
                  </div>
                }
              >
                {(items) => (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {items.map((appointment) => (
                      <li
                        key={appointment.appointment_id}
                        className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                      >
                        <span
                          className="w-14 shrink-0 font-medium text-heading"
                          data-numeric
                        >
                          {formatTime(appointment.appointment_date)}
                        </span>
                        <span className="min-w-0 flex-1">
                          {appointment.patient ? (
                            <Link
                              to={`/doctor/patients/${appointment.pat_id}`}
                              className="font-medium text-brand-700 hover:underline"
                            >
                              {fullName(
                                appointment.patient.pat_first_name,
                                appointment.patient.pat_last_name,
                              )}
                            </Link>
                          ) : (
                            <span className="text-muted">Patient</span>
                          )}
                        </span>
                        <StatusBadge
                          status={
                            appointmentStatus[appointment.appointment_status]
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </StateView>
            </CardBody>
          </Card>
        </div>

        {/* --- Caseload ---------------------------------------------------- */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Your patients"
              as="h3"
              action={
                <Link
                  to="/doctor/patients"
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                >
                  View all
                </Link>
              }
            />
            <CardBody>
              {patientsQuery.isPending ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : (
                <>
                  <p className="flex items-baseline gap-2">
                    <Users
                      className="size-5 shrink-0 text-brand-600"
                      aria-hidden="true"
                    />
                    <span
                      className="text-3xl font-semibold text-heading"
                      data-numeric
                    >
                      {activePatients.length}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    active {activePatients.length === 1 ? 'patient' : 'patients'}
                    {patientsQuery.data &&
                    patientsQuery.data.length !== activePatients.length
                      ? ` of ${patientsQuery.data.length} on record`
                      : ''}
                  </p>

                  <ul className="mt-4 space-y-1 border-t border-[var(--color-border)] pt-4">
                    {activePatients.slice(0, 6).map((patient) => (
                      <li key={patient.pat_id}>
                        <Link
                          to={`/doctor/patients/${patient.pat_id}`}
                          className="block rounded-[var(--radius-sm)] py-1.5 text-sm text-body hover:text-brand-700 hover:underline"
                        >
                          {fullName(
                            patient.pat_first_name,
                            patient.pat_last_name,
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}
