import { endOfToday, format, startOfToday } from 'date-fns'
import { AlertTriangle, ArrowRight, CalendarCheck, Inbox } from 'lucide-react'
import { Link } from 'react-router-dom'

import {
  InlineEmpty,
  LoadingState,
  StateView,
} from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { RescheduleRequestDecision } from '@/features/appointments/components/reschedule-request-decision'
import {
  useAppointments,
  useDecideRescheduleRequest,
  useRescheduleRequests,
} from '@/features/appointments/hooks'
import { useNotifications } from '@/features/notifications/hooks'
import { useMyPatients } from '@/features/patients/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateTime, formatRelative, formatTime } from '@/lib/format'
import { appointmentStatus } from '@/lib/status'
import { cn, fullName } from '@/lib/utils'

/**
 * The clinician's landing screen.
 *
 * RecoverEase 2.0 opens on **Needs attention**: every item waiting on this
 * clinician, in one worklist. A guidance-chat conversation flagged as a
 * possible critical concern comes first - until now it reached the doctor
 * only through the bell - then reschedule requests, each of which a patient
 * is waiting on. Both come from queries the app already makes (the
 * notifications list and the reschedule requests); the worklist adds no new
 * data. Today's clinic list follows, then the caseload.
 *
 * The two sources fail independently. A failed notification check says so on
 * its own line and never hides the reschedule requests, and "nothing needs
 * your attention" is only said once both have loaded and both are empty.
 *
 * That order survives the collapse to one column on a phone, which is the
 * point of putting the caseload in the second column rather than the first:
 * on a ward round the first thing on screen should be the thing somebody is
 * waiting on, not a count.
 *
 * There is no "total patients seen" tile or similar: a number the clinician
 * cannot act on is display, not information.
 */
export function DoctorDashboard() {
  useDocumentTitle('Dashboard')

  const patientsQuery = useMyPatients()
  const appointmentsQuery = useAppointments()
  const requestsQuery = useRescheduleRequests()
  const notificationsQuery = useNotifications()
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

  // Unread critical-chat alerts: module 8.2 raised them, and they stay here
  // until read on the notifications page.
  const flagged = (notificationsQuery.data ?? []).filter(
    (notification) =>
      notification.notification_type === 'chat_critical' &&
      !notification.notification_is_read,
  )
  const nothingWaiting =
    requestsQuery.isSuccess &&
    notificationsQuery.isSuccess &&
    pendingRequests.length === 0 &&
    flagged.length === 0

  return (
    <>
      <PageHeader
        title="Today"
        description={format(new Date(), 'EEEE d MMMM')}
      />

      <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
        <div className="space-y-section lg:col-span-2">
          {/* --- Needs attention — modules 8.2, 6.3, 6.4 ------------------ */}
          <PageSection
            title="Needs attention"
            description={
              nothingWaiting
                ? undefined
                : 'Waiting on your decision or your review.'
            }
          >
            <Card variant="elevated" className="overflow-hidden">
              {nothingWaiting ? (
                <InlineEmpty icon={Inbox}>
                  Nothing needs your attention right now. Flagged
                  conversations and reschedule requests appear here.
                </InlineEmpty>
              ) : null}

              {/* Flagged conversations, first. */}
              {flagged.length > 0 ? (
                <ListRows>
                  {flagged.map((notification) => {
                    // The same rule as the notifications page: a link to the
                    // conversation only when the database lets this reader
                    // see it, which is the patient's own doctor.
                    const patientId = notification.chat_session?.pat_id
                    const path =
                      patientId && notification.chat_session_id
                        ? `/doctor/patients/${patientId}?tab=chat&session=${notification.chat_session_id}`
                        : '/doctor/notifications'
                    return (
                      <ListRow
                        key={notification.notification_id}
                        className="bg-warning-50"
                        title={
                          <span className="inline-flex items-start gap-2">
                            <AlertTriangle
                              className="mt-0.5 size-4 shrink-0 text-warning-700"
                              aria-hidden="true"
                            />
                            Flagged conversation
                          </span>
                        }
                        description={
                          <>
                            {notification.notification_message}{' '}
                            <span className="whitespace-nowrap">
                              · {formatRelative(notification.notification_created_at)}
                            </span>
                          </>
                        }
                        actions={
                          <Link
                            to={path}
                            className={buttonVariants({ size: 'sm' })}
                          >
                            {patientId ? 'View conversation' : 'Open notifications'}
                          </Link>
                        }
                      />
                    )
                  })}
                </ListRows>
              ) : null}
              {notificationsQuery.isError ? (
                <InlineEmpty
                  icon={AlertTriangle}
                  action={
                    <Link
                      to="/doctor/notifications"
                      className={buttonVariants({
                        variant: 'outline',
                        size: 'sm',
                      })}
                    >
                      Open notifications
                    </Link>
                  }
                >
                  Flagged conversations could not be checked just now.
                </InlineEmpty>
              ) : null}

              {/* Reschedule requests. */}
              {requestsQuery.isPending ? (
                <LoadingState label="Loading reschedule requests…" />
              ) : (
                <StateView
                  isPending={false}
                  error={requestsQuery.error}
                  data={pendingRequests}
                  onRetry={() => void requestsQuery.refetch()}
                >
                  {(requests) =>
                    requests.length === 0 ? null : (
                      <ListRows
                        className={cn(
                          flagged.length > 0 &&
                            'border-t border-[var(--color-border)]',
                        )}
                      >
                        {requests.map((request) => {
                          const patient = request.appointment?.patient
                          return (
                            <ListRow
                              key={request.reschedule_request_id}
                              title={
                                <>
                                  <span className="sr-only">
                                    Reschedule request from{' '}
                                  </span>
                                  {patient
                                    ? fullName(
                                        patient.pat_first_name,
                                        patient.pat_last_name,
                                      )
                                    : 'A patient'}
                                </>
                              }
                              description={
                                <>
                                  Asked to move{' '}
                                  {request.appointment
                                    ? formatDateTime(
                                        request.appointment.appointment_date,
                                      )
                                    : 'their appointment'}{' '}
                                  to{' '}
                                  <span className="font-medium text-heading">
                                    {formatDateTime(
                                      request.reschedule_request_date,
                                    )}
                                  </span>
                                  .
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
                    )
                  }
                </StateView>
              )}
            </Card>
          </PageSection>

          {/* --- Today's clinic --------------------------------------------- */}
          <PageSection
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
          >
            <Card className="overflow-hidden">
              <StateView
                isPending={appointmentsQuery.isPending}
                error={appointmentsQuery.error}
                data={todaysAppointments}
                onRetry={() => void appointmentsQuery.refetch()}
                empty={
                  <InlineEmpty icon={CalendarCheck}>
                    No appointments today
                  </InlineEmpty>
                }
              >
                {(items) => (
                  <ListRows>
                    {items.map((appointment) => (
                      <ListRow
                        key={appointment.appointment_id}
                        className="py-3"
                        title={
                          <span className="flex items-baseline gap-3">
                            <span
                              className="shrink-0 tabular-nums text-brand-800"
                              data-numeric
                            >
                              {formatTime(appointment.appointment_date)}
                            </span>
                            {appointment.patient ? (
                              <Link
                                to={`/doctor/patients/${appointment.pat_id}`}
                                className="inline-flex min-h-11 min-w-0 items-center truncate text-brand-700 hover:underline sm:min-h-0"
                              >
                                {fullName(
                                  appointment.patient.pat_first_name,
                                  appointment.patient.pat_last_name,
                                )}
                              </Link>
                            ) : (
                              <span className="font-normal text-muted">
                                Patient
                              </span>
                            )}
                          </span>
                        }
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
              </StateView>
            </Card>
          </PageSection>
        </div>

        {/* --- Caseload ---------------------------------------------------- */}
        <PageSection
          title="Your patients"
          action={
            <Link
              to="/doctor/patients"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              View all
            </Link>
          }
        >
          <Card>
            <CardBody>
              {patientsQuery.isPending ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : (
                <>
                  <p className="text-body">
                    <span
                      className="text-headline-md text-heading"
                      data-numeric
                    >
                      {activePatients.length}
                    </span>{' '}
                    active {activePatients.length === 1 ? 'patient' : 'patients'}
                    {patientsQuery.data &&
                    patientsQuery.data.length !== activePatients.length
                      ? ` of ${patientsQuery.data.length} on record`
                      : ''}
                  </p>

                  <ul className="mt-4 border-t border-[var(--color-border)] pt-2">
                    {activePatients.slice(0, 6).map((patient) => (
                      <li key={patient.pat_id}>
                        <Link
                          to={`/doctor/patients/${patient.pat_id}`}
                          // A full-height row rather than a line of text:
                          // these are the fastest route into a record and on
                          // a phone they were a 20px tap target.
                          className="-mx-2 flex min-h-11 items-center rounded-[var(--radius-md)] px-2 font-medium text-role transition-colors duration-[var(--duration-fast)] hover:bg-role-soft"
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
        </PageSection>
      </div>
    </>
  )
}
