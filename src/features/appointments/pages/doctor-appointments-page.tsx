import { CalendarClock, CalendarX, History, Inbox } from 'lucide-react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import {
  useAppointments,
  useDecideRescheduleRequest,
  useRescheduleRequests,
  useSetAppointmentStatus,
} from '@/features/appointments/hooks'
import { formatDateTime } from '@/lib/format'
import { appointmentStatus, rescheduleRequestStatus } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * Modules 6.2 "View Appointment Calendar", 6.3 "Review Appointment Reschedule
 * Request" and 6.4 "Approve or Decline Reschedule Request".
 *
 * Pending requests are placed above the calendar because each one has a
 * patient waiting on it.
 */
export function DoctorAppointmentsPage() {
  const appointmentsQuery = useAppointments()
  const requestsQuery = useRescheduleRequests()
  const decide = useDecideRescheduleRequest()
  const setStatus = useSetAppointmentStatus()

  const now = new Date()
  const upcoming = (appointmentsQuery.data ?? [])
    .filter((a) => new Date(a.appointment_date) >= now)
    .sort(
      (a, b) =>
        new Date(a.appointment_date).getTime() -
        new Date(b.appointment_date).getTime(),
    )
  const past = (appointmentsQuery.data ?? []).filter(
    (a) => new Date(a.appointment_date) < now,
  )

  const pendingRequests = (requestsQuery.data ?? []).filter(
    (request) => request.reschedule_request_status === 'pending',
  )
  const decidedRequests = (requestsQuery.data ?? []).filter(
    (request) => request.reschedule_request_status !== 'pending',
  )

  return (
    <>
      <PageHeader
        eyebrow="Your clinic"
        title="Appointments"
        description="Your clinic schedule and reschedule requests."
      />

      <div className="space-y-5">
        {/* --- Pending requests ------------------------------------------ */}
        <Card>
          <CardHeader
            icon={Inbox}
            title="Reschedule requests"
            description="Approving moves the appointment automatically."
          />
          <CardBody className="p-0">
            <StateView
              isPending={requestsQuery.isPending}
              error={requestsQuery.error}
              data={pendingRequests}
              onRetry={() => void requestsQuery.refetch()}
              empty={
                <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                  No requests are waiting for a decision.
                </p>
              }
            >
              {(requests) => (
                <ListRows>
                  {requests.map((request) => {
                    const patient = request.appointment?.patient
                    return (
                      <ListRow
                        key={request.reschedule_request_id}
                        title={
                          patient
                            ? fullName(
                                patient.pat_first_name,
                                patient.pat_last_name,
                              )
                            : 'A patient'
                        }
                        description={
                          <>
                            {request.appointment
                              ? formatDateTime(
                                  request.appointment.appointment_date,
                                )
                              : 'Appointment'}{' '}
                            <span aria-hidden="true">→</span>
                            <span className="sr-only">moved to</span>{' '}
                            <span className="font-medium text-heading">
                              {formatDateTime(request.reschedule_request_date)}
                            </span>
                          </>
                        }
                      >
                        {request.reschedule_request_reason ? (
                          <p className="mb-3 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-body">
                            “{request.reschedule_request_reason}”
                          </p>
                        ) : null}

                        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                          <Button
                            size="sm"
                            isLoading={
                              decide.isPending &&
                              decide.variables?.requestId ===
                                request.reschedule_request_id
                            }
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
                      </ListRow>
                    )
                  })}
                </ListRows>
              )}
            </StateView>
          </CardBody>
        </Card>

        {/* --- Upcoming --------------------------------------------------- */}
        <Card>
          <CardHeader icon={CalendarClock} title="Upcoming appointments" />
          <CardBody className="p-0">
            <StateView
              isPending={appointmentsQuery.isPending}
              error={appointmentsQuery.error}
              data={upcoming}
              onRetry={() => void appointmentsQuery.refetch()}
              empty={
                <div className="px-4 py-10 text-center sm:px-5">
                  <CalendarX
                    className="mx-auto size-6 text-neutral-400"
                    aria-hidden="true"
                  />
                  <p className="mt-2 font-medium text-heading">
                    No upcoming appointments
                  </p>
                </div>
              }
            >
              {(items) => (
                <ListRows>
                  {items.map((appointment) => {
                    const isOpen =
                      appointment.appointment_status !== 'completed' &&
                      appointment.appointment_status !== 'cancelled'
                    const name = appointment.patient
                      ? fullName(
                          appointment.patient.pat_first_name,
                          appointment.patient.pat_last_name,
                        )
                      : 'Patient'

                    return (
                      <ListRow
                        key={appointment.appointment_id}
                        title={
                          appointment.patient ? (
                            <Link
                              to={`/doctor/patients/${appointment.pat_id}`}
                              className="inline-flex min-h-11 items-center text-brand-700 hover:underline sm:min-h-0"
                            >
                              {name}
                            </Link>
                          ) : (
                            name
                          )
                        }
                        description={formatDateTime(
                          appointment.appointment_date,
                        )}
                        status={
                          <StatusBadge
                            status={
                              appointmentStatus[appointment.appointment_status]
                            }
                          />
                        }
                        actions={
                          isOpen ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                setStatus.mutate({
                                  appointmentId: appointment.appointment_id,
                                  status: 'completed',
                                })
                              }
                            >
                              Mark completed
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

        {/* --- History ----------------------------------------------------- */}
        <Card>
          <CardHeader icon={History} title="Past appointments" />
          <CardBody className="p-0">
            {past.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                No past appointments.
              </p>
            ) : (
              <ListRows>
                {past.slice(0, 30).map((appointment) => (
                  <ListRow
                    key={appointment.appointment_id}
                    className="py-3"
                    title={
                      appointment.patient
                        ? fullName(
                            appointment.patient.pat_first_name,
                            appointment.patient.pat_last_name,
                          )
                        : 'Patient'
                    }
                    description={formatDateTime(appointment.appointment_date)}
                    status={
                      <StatusBadge
                        status={
                          appointmentStatus[appointment.appointment_status]
                        }
                      />
                    }
                  />
                ))}
              </ListRows>
            )}
          </CardBody>
        </Card>

        {/* --- Decided requests -------------------------------------------- */}
        {decidedRequests.length > 0 ? (
          <Card>
            <CardHeader title="Past reschedule decisions" />
            <CardBody className="p-0">
              <ListRows>
                {decidedRequests.slice(0, 20).map((request) => (
                  <ListRow
                    key={request.reschedule_request_id}
                    className="py-3"
                    title={
                      <span className="font-normal text-body">
                        {request.appointment?.patient
                          ? fullName(
                              request.appointment.patient.pat_first_name,
                              request.appointment.patient.pat_last_name,
                            )
                          : 'Patient'}
                      </span>
                    }
                    description={`Requested ${formatDateTime(request.reschedule_request_date)}`}
                    status={
                      <StatusBadge
                        status={
                          rescheduleRequestStatus[
                            request.reschedule_request_status
                          ]
                        }
                      />
                    }
                  />
                ))}
              </ListRows>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  )
}
