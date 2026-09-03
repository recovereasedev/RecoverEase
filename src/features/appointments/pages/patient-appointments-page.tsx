import { CalendarClock, CalendarPlus, CalendarX, History } from 'lucide-react'
import { useState } from 'react'

import { ErrorState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/field'
import { ListRow, ListRows } from '@/components/ui/list-row'
import {
  useAppointments,
  useCreateAppointment,
  useCreateRescheduleRequest,
  useSetAppointmentStatus,
} from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
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
  const [reschedulingId, setReschedulingId] = useState<string | null>(null)
  const [rescheduleValue, setRescheduleValue] = useState('')
  const [rescheduleReason, setRescheduleReason] = useState('')

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

  const submitBooking = () => {
    if (!patient) return
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
      },
    )
  }

  const submitReschedule = () => {
    if (!reschedulingId) return
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
          <Button
            className="max-sm:w-full"
            onClick={() => setBookingOpen(true)}
          >
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
                            {pending ? (
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

                          {!pending ? (
                            <Button
                              size="sm"
                              variant="secondary"
                             
                              onClick={() => {
                                setReschedulingId(appointment.appointment_id)
                                setRescheduleValue('')
                                setRescheduleReason('')
                              }}
                            >
                              Request new time
                            </Button>
                          ) : null}

                          <Button
                            size="sm"
                            variant="ghost"
                           
                            onClick={() =>
                              setStatus.mutate({
                                appointmentId: appointment.appointment_id,
                                status: 'cancelled',
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </div>

                        {pending ? (
                          <p className="mt-3 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-body">
                            You asked to move this to{' '}
                            {formatDateTime(pending.reschedule_request_date)}.
                            Your doctor has not responded yet.
                          </p>
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
            required
          >
            <Input
              type="datetime-local"
              min={minimumBookingValue()}
              value={bookingValue}
              onChange={(event) => setBookingValue(event.target.value)}
            />
          </Field>

          {createAppointment.isError ? (
            <ErrorState error={createAppointment.error} />
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
          <Field label="Preferred new date and time" required>
            <Input
              type="datetime-local"
              min={minimumBookingValue()}
              value={rescheduleValue}
              onChange={(event) => setRescheduleValue(event.target.value)}
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
            <ErrorState error={createReschedule.error} />
          ) : null}
        </div>
      </Dialog>
    </>
  )
}
