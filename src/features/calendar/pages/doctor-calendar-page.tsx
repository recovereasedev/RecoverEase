import { useQuery } from '@tanstack/react-query'
import { CalendarCog } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { useAppointments } from '@/features/appointments/hooks'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  appointmentEvents,
  deviceTimeZone,
  eventsByDay,
  monthOf,
  monthWeeks,
  todayIn,
  type MonthKey,
} from '@/features/calendar/calendar-model'
import {
  CalendarLegend,
  DayAgenda,
  MonthCalendar,
} from '@/features/calendar/components/month-calendar'
import { TimeZoneNote } from '@/features/calendar/pages/patient-calendar-page'
import { fetchOwnClinicTimeZone } from '@/features/patients/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'

/**
 * Module 6.2 "View Appointment Calendar", for the doctor: their own
 * appointments by day, with whom, and in what state - the month at a glance,
 * the chosen day in full.
 *
 * It reads the appointments the doctor's access already returns - their
 * assigned patients' - and shows the ones that are the doctor's own. A
 * patient's doses and check-ins are theirs to see on the patient's record,
 * not on the doctor's schedule. Scheduling, confirming, rescheduling and
 * cancelling stay on the Appointments page, where each has its checks; each
 * day here links to it and to the patient's record.
 */
export function DoctorCalendarPage() {
  useDocumentTitle('Calendar')
  const user = useCurrentUser()
  const queryKeys = useQueryKeys()
  const doctorId = user.profile.kind === 'doctor' ? user.profile.doctor.doc_id : ''

  const zoneQuery = useQuery({
    queryKey: queryKeys.ownClinic.timeZone(),
    queryFn: fetchOwnClinicTimeZone,
  })
  const device = deviceTimeZone()
  const zone = zoneQuery.data ?? device
  const now = useNow()
  const today = todayIn(zone, new Date(now))

  const [month, setMonth] = useState<MonthKey | null>(null)
  const [chosenDay, setChosenDay] = useState<string | null>(null)
  const shownMonth = month ?? monthOf(today)
  const selectedDay = chosenDay ?? today

  const appointmentsQuery = useAppointments()

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your appointments, day by day."
        actions={
          <Link
            to="/doctor/appointments"
            className={cn(buttonVariants({ variant: 'outline' }), 'max-sm:w-full')}
          >
            <CalendarCog aria-hidden="true" />
            Manage appointments
          </Link>
        }
      />

      <StateView
        isPending={zoneQuery.isPending || appointmentsQuery.isPending}
        error={appointmentsQuery.error}
        data={appointmentsQuery.data}
        onRetry={() => void appointmentsQuery.refetch()}
        loadingLabel="Loading your calendar…"
      >
        {(appointments) => {
          const mine = appointments.filter((appointment) => appointment.doc_id === doctorId)
          const byDay = eventsByDay(
            appointmentEvents(mine, zone, 'patient'),
            monthWeeks(shownMonth).flat(),
          )
          return (
            <div className="grid gap-section lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
              <Card>
                <CardBody className="space-y-4">
                  <MonthCalendar
                    month={shownMonth}
                    selectedDay={selectedDay}
                    today={today}
                    eventsByDay={byDay}
                    onSelectDay={setChosenDay}
                    onMonthChange={setMonth}
                  />
                  <CalendarLegend kinds={['appointment']} />
                  <TimeZoneNote zone={zone} device={device} clinicKnown={Boolean(zoneQuery.data)} />
                </CardBody>
              </Card>
              <Card className="lg:sticky lg:top-28">
                <CardBody>
                  <DayAgenda
                    day={selectedDay}
                    today={today}
                    events={byDay.get(selectedDay) ?? []}
                    renderAction={(event) =>
                      event.patientId ? (
                        <Link
                          to={`/doctor/patients/${event.patientId}`}
                          className="text-sm font-medium text-role-strong underline underline-offset-2 hover:no-underline"
                        >
                          Open patient record
                        </Link>
                      ) : null
                    }
                  />
                </CardBody>
              </Card>
            </div>
          )
        }}
      </StateView>
    </>
  )
}
