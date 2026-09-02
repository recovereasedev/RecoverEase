import { CalendarX } from 'lucide-react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
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
        title="Appointments"
        description="Your clinic schedule and reschedule requests."
      />

      <div className="space-y-5">
        {/* --- Pending requests ------------------------------------------ */}
        <Card>
          <CardHeader
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
                <p className="px-5 py-8 text-center text-sm text-muted">
                  No requests are waiting for a decision.
                </p>
              }
            >
              {(requests) => (
                <ul className="divide-y divide-[var(--color-border)]">
                  {requests.map((request) => {
                    const patient = request.appointment?.patient
                    return (
                      <li key={request.reschedule_request_id} className="px-5 py-4">
                        <p className="font-medium text-heading">
                          {patient
                            ? fullName(
                                patient.pat_first_name,
                                patient.pat_last_name,
                              )
                            : 'A patient'}
                        </p>
                        <p className="mt-1 text-sm text-body">
                          {request.appointment
                            ? formatDateTime(
                                request.appointment.appointment_date,
                              )
                            : 'Appointment'}{' '}
                          →{' '}
                          <span className="font-medium text-heading">
                            {formatDateTime(request.reschedule_request_date)}
                          </span>
                        </p>
                        {request.reschedule_request_reason ? (
                          <p className="mt-2 rounded-[var(--radius-sm)] bg-surface-sunken px-3 py-2 text-sm text-body">
                            “{request.reschedule_request_reason}”
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
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
                      </li>
                    )
                  })}
                </ul>
              )}
            </StateView>
          </CardBody>
        </Card>

        {/* --- Upcoming --------------------------------------------------- */}
        <Card>
          <CardHeader title="Upcoming appointments" />
          <CardBody className="p-0">
            <StateView
              isPending={appointmentsQuery.isPending}
              error={appointmentsQuery.error}
              data={upcoming}
              onRetry={() => void appointmentsQuery.refetch()}
              empty={
                <div className="px-5 py-10 text-center">
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
                <ul className="divide-y divide-[var(--color-border)]">
                  {items.map((appointment) => (
                    <li
                      key={appointment.appointment_id}
                      className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                    >
                      <div className="min-w-0 flex-1">
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
                          <span className="font-medium text-heading">
                            Patient
                          </span>
                        )}
                        <p className="text-sm text-muted">
                          {formatDateTime(appointment.appointment_date)}
                        </p>
                      </div>

                      <StatusBadge
                        status={
                          appointmentStatus[appointment.appointment_status]
                        }
                      />

                      {appointment.appointment_status !== 'completed' &&
                      appointment.appointment_status !== 'cancelled' ? (
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
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </StateView>
          </CardBody>
        </Card>

        {/* --- History ----------------------------------------------------- */}
        <Card>
          <CardHeader title="Past appointments" />
          <CardBody className="p-0">
            {past.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">
                No past appointments.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {past.slice(0, 30).map((appointment) => (
                  <li
                    key={appointment.appointment_id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-heading">
                        {appointment.patient
                          ? fullName(
                              appointment.patient.pat_first_name,
                              appointment.patient.pat_last_name,
                            )
                          : 'Patient'}
                      </p>
                      <p className="text-sm text-muted">
                        {formatDateTime(appointment.appointment_date)}
                      </p>
                    </div>
                    <StatusBadge
                      status={appointmentStatus[appointment.appointment_status]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* --- Decided requests -------------------------------------------- */}
        {decidedRequests.length > 0 ? (
          <Card>
            <CardHeader title="Past reschedule decisions" />
            <CardBody className="p-0">
              <ul className="divide-y divide-[var(--color-border)]">
                {decidedRequests.slice(0, 20).map((request) => (
                  <li
                    key={request.reschedule_request_id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <p className="text-body">
                        {request.appointment?.patient
                          ? fullName(
                              request.appointment.patient.pat_first_name,
                              request.appointment.patient.pat_last_name,
                            )
                          : 'Patient'}
                      </p>
                      <p className="text-sm text-muted">
                        Requested {formatDateTime(request.reschedule_request_date)}
                      </p>
                    </div>
                    <StatusBadge
                      status={
                        rescheduleRequestStatus[
                          request.reschedule_request_status
                        ]
                      }
                    />
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  )
}
