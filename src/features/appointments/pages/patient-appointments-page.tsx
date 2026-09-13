import { CalendarClock, CalendarPlus, CalendarX, History } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/field'
import { ListRow, ListRows } from '@/components/ui/list-row'
import {
  appointmentTimeError,
  closedAppointmentPhrase,
  isActiveAppointment,
} from '@/features/appointments/appointment-rules'
import {
  useAppointments,
  useCreateAppointment,
  useCreateRescheduleRequest,
  useSetAppointmentStatus,
} from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateTime } from '@/lib/format'
import { appointmentStatus, rescheduleRequestStatus } from '@/lib/status'
import { supabase } from '@/lib/supabase/client'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

/** The earliest value the datetime picker accepts: now, rounded to a minute. */
function minimumBookingValue(): string {
  const now = new Date()
  now.setSeconds(0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * Modules 6.1 "Schedule Follow-up Appointment", 6.2 "View Appointment
 * Calendar", 6.5 "Request Appointment Reschedule", 6.6 "Confirm Appointment
 * Attendance" and 6.7 "View Appointment History".
 *
 * There is no doctor picker. Module 6.1 books a follow-up with the patient's
 * own clinician, and a database trigger refuses anything else, so offering a
 * choice would only produce rejected bookings.
 */
export function PatientAppointmentsPage() {
  useDocumentTitle('Appointments')
  const user = useCurrentUser()
  const patient =
    user.profile.kind === 'patient' ? user.profile.patient : null
  const patientId = patient?.pat_id ?? ''

  const appointmentsQuery = useAppointments(patientId)
  const createAppointment = useCreateAppointment()
  const setStatus = useSetAppointmentStatus()
  const createReschedule = useCreateRescheduleRequest()

  const [isBookingOpen, setBookingOpen] = useState(false)
  const [bookingValue, setBookingValue] = useState('')
  const [bookingProblem, setBookingProblem] = useState<string | null>(null)
  const [reschedulingId, setReschedulingId] = useState<string | null>(null)
  const [rescheduleValue, setRescheduleValue] = useState('')
  const [rescheduleReason, setRescheduleReason] = useState('')
  const [rescheduleProblem, setRescheduleProblem] = useState<string | null>(null)
  // Cancelling cannot be undone from this screen, and it tells the doctor, so
  // it is confirmed first — as it is on the clinician's side. Held as the
  // appointment rather than a boolean so the dialog can say which one.
  const [cancelling, setCancelling] = useState<{
    id: string
    when: string
  } | null>(null)

  // Set synchronously, before a mutation is dispatched (NA-04). The disabled
  // state that `isPending` drives is committed on a later render, so two
  // clicks in the same task both got through, and React Query does not
  // deduplicate concurrent `mutate()` calls. The same guard the clinician's
  // scheduling dialog has.
  const bookingInFlight = useRef(false)
  const rescheduleInFlight = useRef(false)

  // The patient's own reschedule requests, so a pending one is visible rather
  // than the patient wondering whether the request went anywhere.
  const requestsQuery = useQuery({
    queryKey: queryKeys.appointments.rescheduleRequests(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reschedule_request')
        .select('*')
        .order('reschedule_request_created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })

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

  const pendingRequestFor = (appointmentId: string) =>
    requestsQuery.data?.find(
      (request) =>
        request.appointment_id === appointmentId &&
        request.reschedule_request_status === 'pending',
    )

  /** The status write last attempted on this appointment, if it failed. */
  const failedStatusFor = (appointmentId: string) =>
    setStatus.isError && setStatus.variables?.appointmentId === appointmentId
      ? setStatus.variables.status
      : null

  const openBooking = () => {
    // A failure from an earlier attempt is not this attempt's.
    createAppointment.reset()
    setBookingProblem(null)
    setBookingOpen(true)
  }

  const submitBooking = () => {
    if (!patient) return

    // Before anything is sent: the picker's `min` does not stop a typed date.
    const problem = appointmentTimeError(bookingValue)
    setBookingProblem(problem)
    if (problem) return

    // Nothing below this line may run twice for one user action.
    if (bookingInFlight.current) return
    bookingInFlight.current = true

    createAppointment.mutate(
      {
        patientId: patient.pat_id,
        doctorId: patient.doc_id,
        scheduledFor: new Date(bookingValue).toISOString(),
      },
      {
        onSuccess: () => {
          setBookingOpen(false)
          setBookingValue('')
        },
        // Released however it ends, so a genuine failure can be retried.
        onSettled: () => {
          bookingInFlight.current = false
        },
      },
    )
  }

  const openReschedule = (appointmentId: string) => {
    createReschedule.reset()
    setRescheduleProblem(null)
    setReschedulingId(appointmentId)
    setRescheduleValue('')
    setRescheduleReason('')
  }

  const submitReschedule = () => {
    if (!reschedulingId) return

    const problem = appointmentTimeError(rescheduleValue)
    setRescheduleProblem(problem)
    if (problem) return

    // Nothing below this line may run twice for one user action.
    if (rescheduleInFlight.current) return
    rescheduleInFlight.current = true

    createReschedule.mutate(
      {
        appointmentId: reschedulingId,
        userId: user.userId,
        proposedFor: new Date(rescheduleValue).toISOString(),
        reason: rescheduleReason.trim() || null,
      },
      {
        onSuccess: () => {
          setReschedulingId(null)
          setRescheduleValue('')
          setRescheduleReason('')
          void requestsQuery.refetch()
        },
        onSettled: () => {
          rescheduleInFlight.current = false
        },
      },
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="Your schedule"
        title="Appointments"
        description="Your upcoming visits and your appointment history."
        actions={
          <Button className="max-sm:w-full" onClick={openBooking}>
            <CalendarPlus aria-hidden="true" />
            Book a follow-up
          </Button>
        }
      />

      <div className="space-y-5">
        <Card>
          <CardHeader
            icon={CalendarClock}
            title="Upcoming"
            description="Confirm that you will attend, or ask for a different time."
          />
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
                  <p className="mt-1 text-sm text-muted">
                    Book a follow-up when you need to see your doctor again.
                  </p>
                </div>
              }
            >
              {(items) => (
                <ListRows>
                  {items.map((appointment) => {
                    const pending = pendingRequestFor(
                      appointment.appointment_id,
                    )
                    // Only an appointment that is still going to happen can
                    // be moved or called off. 'cancelled', 'completed' and
                    // 'no_show' are settled, and offering "Cancel" beside a
                    // cancelled appointment invited a second cancellation of
                    // something already cancelled — while "Request new time"
                    // there was worse than pointless, because approving that
                    // request used to put the appointment back to
                    // 'scheduled'. The database refuses that now; this keeps
                    // the action from being offered in the first place.
                    const isOpen = isActiveAppointment(
                      appointment.appointment_status,
                    )
                    // A request can outlive its appointment (NA-03): it is
                    // not awaiting the doctor once the appointment is closed.
                    const closedPhrase = closedAppointmentPhrase(
                      appointment.appointment_status,
                    )

                    return (
                      <ListRow
                        key={appointment.appointment_id}
                        title={formatDateTime(appointment.appointment_date)}
                        status={
                          <>
                            <StatusBadge
                              status={
                                appointmentStatus[
                                  appointment.appointment_status
                                ]
                              }
                            />
                            {pending && isOpen ? (
                              <StatusBadge
                                status={rescheduleRequestStatus.pending}
                              />
                            ) : null}
                          </>
                        }
                      >
                        {/* Actions live in the row's own block rather than
                            beside the status, because three of them beside a
                            date and two badges is more than a 375px line can
                            carry. Here they get a full-width two-up grid on a
                            phone and sit inline from `sm`. */}
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                          {appointment.appointment_status === 'scheduled' ? (
                            <Button
                              size="sm"

                              isLoading={
                                setStatus.isPending &&
                                setStatus.variables?.appointmentId ===
                                  appointment.appointment_id
                              }
                              onClick={() =>
                                setStatus.mutate({
                                  appointmentId: appointment.appointment_id,
                                  status: 'confirmed',
                                })
                              }
                            >
                              Confirm
                            </Button>
                          ) : null}

                          {isOpen && !pending ? (
                            <Button
                              size="sm"
                              variant="secondary"

                              onClick={() =>
                                openReschedule(appointment.appointment_id)
                              }
                            >
                              Request new time
                            </Button>
                          ) : null}

                          {isOpen ? (
                            <Button
                              size="sm"
                              variant="ghost"

                              onClick={() =>
                                setCancelling({
                                  id: appointment.appointment_id,
                                  when: formatDateTime(
                                    appointment.appointment_date,
                                  ),
                                })
                              }
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>

                        {pending ? (
                          <p className="mt-3 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-body">
                            {closedPhrase ? (
                              <>
                                This appointment {closedPhrase}, so your
                                request to move it to{' '}
                                {formatDateTime(pending.reschedule_request_date)}{' '}
                                will not be acted on.
                              </>
                            ) : (
                              <>
                                You asked to move this to{' '}
                                {formatDateTime(pending.reschedule_request_date)}.
                                Your doctor has not responded yet.
                              </>
                            )}
                          </p>
                        ) : null}

                        {failedStatusFor(appointment.appointment_id) ===
                        'confirmed' ? (
                          <div className="mt-3">
                            <FormError
                              error={setStatus.error}
                              title="Your attendance was not confirmed"
                            />
                          </div>
                        ) : null}
                      </ListRow>
                    )
                  })}
                </ListRows>
              )}
            </StateView>
          </CardBody>
        </Card>

        {/* --- History — module 6.7 -------------------------------------- */}
        <Card>
          <CardHeader icon={History} title="History" />
          <CardBody className="p-0">
            {past.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                You have no past appointments.
              </p>
            ) : (
              <ListRows>
                {past.map((appointment) => (
                  <ListRow
                    key={appointment.appointment_id}
                    className="py-3"
                    title={
                      <span className="font-normal text-body">
                        {formatDateTime(appointment.appointment_date)}
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
          </CardBody>
        </Card>
      </div>

      {/* --- Cancel confirmation ----------------------------------------- */}
      {cancelling ? (
        <Dialog
          isOpen
          onClose={() => setCancelling(null)}
          title="Cancel this appointment?"
          description={`${cancelling.when}. This appointment will be cancelled. Your doctor is notified, and no reminder is sent for it.`}
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
              This cannot be undone from here. Book a follow-up if you still
              need to see your doctor.
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

      {/* --- Booking dialog ---------------------------------------------- */}
      <Dialog
        isOpen={isBookingOpen}
        onClose={() => setBookingOpen(false)}
        title="Book a follow-up"
        description="This books time with your assigned doctor."
        footer={
          <>
            <Button variant="ghost" onClick={() => setBookingOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitBooking}
              disabled={!bookingValue}
              isLoading={createAppointment.isPending}
              loadingLabel="Booking…"
            >
              Book appointment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Date and time"
            description="Choose when you would like to be seen. Your doctor will confirm."
            error={bookingProblem ?? undefined}
            required
          >
            <Input
              type="datetime-local"
              min={minimumBookingValue()}
              value={bookingValue}
              onChange={(event) => {
                setBookingValue(event.target.value)
                setBookingProblem(null)
              }}
            />
          </Field>

          {createAppointment.isError ? (
            <FormError
              error={createAppointment.error}
              title="The appointment was not booked"
            />
          ) : null}
        </div>
      </Dialog>

      {/* --- Reschedule dialog -------------------------------------------- */}
      <Dialog
        isOpen={reschedulingId !== null}
        onClose={() => setReschedulingId(null)}
        title="Request a different time"
        description="Your doctor will approve or decline this request."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReschedulingId(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitReschedule}
              disabled={!rescheduleValue}
              isLoading={createReschedule.isPending}
              loadingLabel="Sending request…"
            >
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Preferred new date and time"
            error={rescheduleProblem ?? undefined}
            required
          >
            <Input
              type="datetime-local"
              min={minimumBookingValue()}
              value={rescheduleValue}
              onChange={(event) => {
                setRescheduleValue(event.target.value)
                setRescheduleProblem(null)
              }}
            />
          </Field>

          <Field
            label="Reason"
            description="Optional, but it helps your doctor decide."
          >
            <Textarea
              rows={3}
              value={rescheduleReason}
              onChange={(event) => setRescheduleReason(event.target.value)}
              placeholder="I have a work commitment that morning."
            />
          </Field>

          {createReschedule.isError ? (
            <FormError
              error={createReschedule.error}
              title="The request was not sent"
            />
          ) : null}
        </div>
      </Dialog>
    </>
  )
}
