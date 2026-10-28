import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Card, CardBody } from '@/components/ui/card'
import { fetchAppointments } from '@/features/appointments/api'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  addDays,
  appointmentEvents,
  deviceTimeZone,
  doseEvents,
  eventsByDay,
  monthOf,
  monthWeeks,
  monthWindow,
  moodEvents,
  todayIn,
  type MonthKey,
} from '@/features/calendar/calendar-model'
import {
  CalendarLegend,
  DayAgenda,
  MonthCalendar,
} from '@/features/calendar/components/month-calendar'
import { fetchAllDoses } from '@/features/medications/api'
import { useMedicationSchedules } from '@/features/medications/hooks'
import { fetchOwnClinicTimeZone } from '@/features/patients/api'
import { useMyDoctor } from '@/features/patients/hooks'
import { fetchRecoveryLogsBetween } from '@/features/recovery-logs/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'

/**
 * How far ahead dose slots exist: the daily job extends every live schedule
 * 30 days (`extend_all_medication_log_slots(30)`, migration 09). Past that,
 * the calendar shows no doses rather than inventing them.
 */
const DOSE_HORIZON_DAYS = 30

/**
 * Module 6.2 "View Appointment Calendar", for the patient: a month of their
 * medicines, appointments and mood check-ins, and the chosen day's in full.
 *
 * Everything shown is a record the patient's own access returns - their
 * dose slots, their appointments, the check-ins they recorded - read for the
 * month on screen (`calendar-model.ts` says what each event means). Days and
 * times are the clinic's, the zone its schedules and reminders are kept in;
 * the page says so where this device is set to another.
 */
export function PatientCalendarPage() {
  useDocumentTitle('Calendar')
  const user = useCurrentUser()
  const queryKeys = useQueryKeys()
  const patient = user.profile.kind === 'patient' ? user.profile.patient : null
  const patientId = patient?.pat_id ?? ''

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
  const range = monthWindow(shownMonth)

  const dosesQuery = useQuery({
    queryKey: queryKeys.medications.allDosesFor(patientId, range.from, range.to),
    queryFn: () => fetchAllDoses({ patientId, from: range.from, to: range.to }),
    enabled: Boolean(patientId),
    // Another month keeps this one on screen until it arrives, so the grid -
    // and the keyboard's place in it - is never torn down for a spinner.
    placeholderData: keepPreviousData,
  })
  const appointmentsQuery = useQuery({
    queryKey: queryKeys.appointments.forPatient(patientId),
    queryFn: () => fetchAppointments(patientId),
    enabled: Boolean(patientId),
  })
  const logsQuery = useQuery({
    queryKey: queryKeys.recoveryLogs.between(patientId, range.fromDay, range.toDay),
    queryFn: () => fetchRecoveryLogsBetween(patientId, range.fromDay, range.toDay),
    enabled: Boolean(patientId),
    placeholderData: keepPreviousData,
  })
  const schedulesQuery = useMedicationSchedules(patientId)
  const doctorQuery = useMyDoctor(patient?.doc_id)

  const queries = [dosesQuery, appointmentsQuery, logsQuery]
  const isPending = zoneQuery.isPending || queries.some((query) => query.isPending)
  const error = queries.find((query) => query.error)?.error ?? null
  const data =
    dosesQuery.data && appointmentsQuery.data && logsQuery.data
      ? { doses: dosesQuery.data, appointments: appointmentsQuery.data, logs: logsQuery.data }
      : undefined

  // A day past the furthest dose slot, while a schedule would still be
  // running then: no doses show, and the page says why.
  const pastHorizon =
    selectedDay > addDays(today, DOSE_HORIZON_DAYS) &&
    (schedulesQuery.data ?? []).some(
      (schedule) =>
        !schedule.medication_schedule_end_date ||
        schedule.medication_schedule_end_date >= selectedDay,
    )

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your medicines, appointments and mood check-ins, day by day."
      />

      <StateView
        isPending={isPending}
        error={error}
        data={data}
        onRetry={() => queries.forEach((query) => void query.refetch())}
        loadingLabel="Loading your calendar…"
      >
        {({ doses, appointments, logs }) => {
          const days = monthWeeks(shownMonth).flat()
          const byDay = eventsByDay(
            [
              ...doseEvents(doses, zone, now),
              ...appointmentEvents(appointments, zone, { doctor: doctorQuery.data }),
              ...moodEvents(logs),
            ],
            days,
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
                    busy={dosesQuery.isPlaceholderData || logsQuery.isPlaceholderData}
                  />
                  <CalendarLegend kinds={['dose', 'appointment', 'mood']} />
                  <TimeZoneNote zone={zone} device={device} clinicKnown={Boolean(zoneQuery.data)} />
                </CardBody>
              </Card>
              <Card className="lg:sticky lg:top-28">
                <CardBody>
                  <DayAgenda
                    day={selectedDay}
                    today={today}
                    events={byDay.get(selectedDay) ?? []}
                    note={
                      pastHorizon
                        ? `Doses are added to your calendar ${DOSE_HORIZON_DAYS} days ahead, so none show for this day yet.`
                        : undefined
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

/** Whose clock the days and times are on, where that could be in doubt. */
export function TimeZoneNote({
  zone,
  device,
  clinicKnown,
}: {
  zone: string
  device: string
  clinicKnown: boolean
}) {
  if (!clinicKnown) {
    return (
      <p className="text-sm text-muted">
        Times are shown in this device&rsquo;s time zone ({device}): your clinic&rsquo;s could
        not be read.
      </p>
    )
  }
  if (zone === device) return null
  return (
    <p className="text-sm text-muted">
      Times are shown in your clinic&rsquo;s time zone ({zone}), which is not this
      device&rsquo;s.
    </p>
  )
}
