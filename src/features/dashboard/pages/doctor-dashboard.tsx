import { endOfToday, startOfToday } from 'date-fns'
import {
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  Inbox,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
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
 * That order survives the collapse to one column on a phone, which is the
 * point of putting the caseload in the second column rather than the first:
 * on a ward round the first thing on screen should be the thing somebody is
 * waiting on, not a count.
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
        eyebrow="Today"
        title={`Good day, ${doctor?.doc_first_name ?? ''}`}
        description="What needs your attention today."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* --- Pending decisions — modules 6.3, 6.4 -------------------- */}
          <Card>
            <CardHeader
              icon={Inbox}
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
                  <div className="px-4 py-10 text-center sm:px-5">
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
                  <ListRows>
                    {requests.map((request) => {
                      const patient = request.appointment?.patient
                      const isDeciding =
                        decide.isPending &&
                        decide.variables?.requestId ===
                          request.reschedule_request_id

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

                          {/* Two decisions, side by side on a phone rather
                              than stacked: they are alternatives to each
                              other, and stacking reads as a sequence. */}
                          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
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
                        </ListRow>
                      )
                    })}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>

          {/* --- Today's clinic --------------------------------------------- */}
          <Card>
            <CardHeader
              icon={CalendarClock}
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
                  <div className="px-4 py-10 text-center sm:px-5">
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
            </CardBody>
          </Card>
        </div>

        {/* --- Caseload ---------------------------------------------------- */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              icon={Users}
              title="Your patients"
              as="h2"
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
                  <p
                    className="text-headline-lg font-bold text-heading"
                    data-numeric
                  >
                    {activePatients.length}
                  </p>
                  <p className="mt-1 text-sm text-muted">
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
                          className="flex min-h-11 items-center rounded-[var(--radius-md)] px-2 -mx-2 text-sm text-body transition-colors hover:bg-neutral-100 hover:text-brand-800"
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
