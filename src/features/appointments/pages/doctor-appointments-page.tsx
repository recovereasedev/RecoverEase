import { CalendarPlus, CalendarX } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { FormError } from '@/components/feedback/form-error'
import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { isActiveAppointment } from '@/features/appointments/appointment-rules'
import { RescheduleRequestDecision } from '@/features/appointments/components/reschedule-request-decision'
import { ScheduleAppointmentDialog } from '@/features/appointments/components/schedule-appointment-dialog'
import {
  useAppointments,
  useDecideRescheduleRequest,
  useRescheduleRequests,
  useSetAppointmentStatus,
} from '@/features/appointments/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { formatDateTime } from '@/lib/format'
import { appointmentStatus, rescheduleRequestStatus } from '@/lib/status'
import { fullName } from '@/lib/utils'

/**
 * Modules 6.1 "Schedule Follow-up Appointment", 6.2 "View Appointment
 * Calendar", 6.3 "Review Appointment Reschedule Request" and 6.4 "Approve or
 * Decline Reschedule Request".
 *
 * Pending requests are placed above the calendar because each one has a
 * patient waiting on it.
 *
 * What the clinician can do follows the appointment's time and status. Ahead
 * of it, an open appointment can be called off. Once its time has passed it
 * is closed out instead, as completed or as a no-show (NA-01) — an outcome
 * recorded before the visit would be a guess. A closed appointment is
 * offered nothing: the database keeps it closed (migration 21).
 */
export function DoctorAppointmentsPage() {
  useDocumentTitle('Appointments')
  const appointmentsQuery = useAppointments()
  const requestsQuery = useRescheduleRequests()
  const decide = useDecideRescheduleRequest()
  const setStatus = useSetAppointmentStatus()
  // "Mark completed", "Mark no-show", "Approve and move" and "Decline" leave
  // with the row they decide, as does a cancelled appointment's "Cancel" once
  // its dialog has handed focus back to it: keyboard focus moves on to the
  // next action rather than to the top of the page.
  const focusRecovery = useFocusRecovery()
  const [isSchedulingOpen, setSchedulingOpen] = useState(false)
  // Cancelling is not undoable from this screen, so it is confirmed first.
  // Held as the appointment itself rather than a boolean, so the dialog can
  // name who and when — "are you sure" about nothing in particular is how
  // the wrong appointment gets cancelled.
  const [cancelling, setCancelling] = useState<{
    id: string
    name: string
    when: string
  } | null>(null)

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

  /** The status write last attempted on this appointment, if it failed. */
  const failedStatusFor = (appointmentId: string) =>
    setStatus.isError && setStatus.variables?.appointmentId === appointmentId
      ? setStatus.variables.status
      : null

  const isSettingStatus = (appointmentId: string, status: string) =>
    setStatus.isPending &&
    setStatus.variables?.appointmentId === appointmentId &&
    setStatus.variables.status === status

  return (
    <>
      <PageHeader
        title="Appointments"
        description="Your clinic schedule and reschedule requests."
        actions={
          <Button onClick={() => setSchedulingOpen(true)}>
            <CalendarPlus aria-hidden="true" />
            Schedule appointment
          </Button>
        }
      />

      {cancelling ? (
        <Dialog
          isOpen
          onClose={() => setCancelling(null)}
          title="Cancel this appointment?"
          description={`${cancelling.name}, ${cancelling.when}. The patient is notified, and no reminder is sent.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCancelling(null)}>
                Keep appointment
              </Button>
              <Button
                variant="danger"
                isLoading={setStatus.isPending}
                loadingLabel="Cancelling…"
                onClick={() =>
                  setStatus.mutate(
                    { appointmentId: cancelling.id, status: 'cancelled' },
                    // Closed only once it has worked. A failure stays on
                    // screen, with the reason, to be tried again (NA-02).
                    { onSuccess: () => setCancelling(null) },
                  )
                }
              >
                Cancel appointment
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-body">
              This cannot be undone from here. Book a new appointment if the
              patient still needs to be seen.
            </p>
            {failedStatusFor(cancelling.id) === 'cancelled' ? (
              <FormError
                error={setStatus.error}
                title="The appointment was not cancelled"
              />
            ) : null}
          </div>
        </Dialog>
      ) : null}

      <ScheduleAppointmentDialog
        isOpen={isSchedulingOpen}
        onClose={() => setSchedulingOpen(false)}
      />

      <div ref={focusRecovery} className="space-y-section">
        {/* --- Pending requests ------------------------------------------ */}
        <PageSection
          title="Reschedule requests"
          description="Approving moves the appointment automatically."
        >
          <Card>
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

                          <RescheduleRequestDecision
                            request={request}
                            decide={decide}
                          />
                        </ListRow>
                      )
                    })}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>
        </PageSection>

        {/* --- Upcoming --------------------------------------------------- */}
        <PageSection title="Upcoming appointments">
          <Card>
            <CardBody className="p-0">
              <StateView
                isPending={appointmentsQuery.isPending}
                error={appointmentsQuery.error}
                data={upcoming}
                onRetry={() => void appointmentsQuery.refetch()}
                empty={
                  <EmptyState icon={CalendarX} title="No upcoming appointments" />
                }
              >
                {(items) => (
                  <ListRows>
                    {items.map((appointment) => {
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
                            // Ahead of the visit the only thing to do is call
                            // it off. Completed or no-show waits until it has
                            // happened (NA-01).
                            isActiveAppointment(appointment.appointment_status) ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setCancelling({
                                    id: appointment.appointment_id,
                                    name,
                                    when: formatDateTime(
                                      appointment.appointment_date,
                                    ),
                                  })
                                }
                              >
                                Cancel
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
        </PageSection>

        {/* --- History ----------------------------------------------------- */}
        <PageSection title="Past appointments">
          <Card>
            <CardBody className="p-0">
              {past.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                  No past appointments.
                </p>
              ) : (
                <ListRows>
                  {past.slice(0, 30).map((appointment) => {
                    const failed = failedStatusFor(appointment.appointment_id)
                    return (
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
                        actions={
                          // A visit whose time has passed and that is still
                          // open is waiting to be closed out (NA-01).
                          isActiveAppointment(appointment.appointment_status) ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                isLoading={isSettingStatus(
                                  appointment.appointment_id,
                                  'completed',
                                )}
                                onClick={() =>
                                  setStatus.mutate({
                                    appointmentId: appointment.appointment_id,
                                    status: 'completed',
                                  })
                                }
                              >
                                Mark completed
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                isLoading={isSettingStatus(
                                  appointment.appointment_id,
                                  'no_show',
                                )}
                                onClick={() =>
                                  setStatus.mutate({
                                    appointmentId: appointment.appointment_id,
                                    status: 'no_show',
                                  })
                                }
                              >
                                Mark no-show
                              </Button>
                            </>
                          ) : null
                        }
                      >
                        {failed === 'completed' || failed === 'no_show' ? (
                          <FormError
                            error={setStatus.error}
                            title={
                              failed === 'completed'
                                ? 'The visit was not marked completed'
                                : 'The visit was not marked as a no-show'
                            }
                          />
                        ) : null}
                      </ListRow>
                    )
                  })}
                </ListRows>
              )}
            </CardBody>
          </Card>
        </PageSection>

        {/* --- Decided requests -------------------------------------------- */}
        {decidedRequests.length > 0 ? (
          <PageSection title="Past reschedule decisions">
            <Card>
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
          </PageSection>
        ) : null}
      </div>
    </>
  )
}
