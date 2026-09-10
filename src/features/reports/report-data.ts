import { useQuery } from '@tanstack/react-query'
import { endOfToday, isValid, parseISO, startOfToday, subDays } from 'date-fns'

import type { Appointment } from '@/features/appointments/api'
import { useAppointments } from '@/features/appointments/hooks'
import { fetchDoctorNotes, type DoctorNote } from '@/features/doctor-notes/api'
import {
  summariseAdherence,
  type Adherence,
  type ScheduleWithPrescription,
} from '@/features/medications/api'
import { useDoses, useMedicationSchedules } from '@/features/medications/hooks'
import type { Patient } from '@/features/patients/api'
import { usePatient } from '@/features/patients/hooks'
import type { RecoveryLog } from '@/features/recovery-logs/api'
import { useRecoveryLogs } from '@/features/recovery-logs/hooks'
import {
  summariseGoals,
  type PlanWithGoals,
} from '@/features/treatment-plans/api'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { toDateKey } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * Everything a patient report shows.
 *
 * Read through the hooks the patient record already uses — the same queries
 * under the same keys, so the same RLS. The report adds no data source and
 * makes no request the clinician could not already make from that record.
 */
export type PatientReportData = {
  patient: Patient
  recoveryLogs: RecoveryLog[]
  plans: PlanWithGoals[]
  schedules: ScheduleWithPrescription[]
  appointments: Appointment[]
  /** Doses over the last seven days, the window the patient record shows. */
  weekAdherence: Adherence
  /**
   * Clinical notes. Readable by clinicians only — the table has no patient
   * SELECT policy — and printed only on the clinical copy.
   */
  notes: DoctorNote[]
}

export function usePatientReportData(patientId: string): {
  data: PatientReportData | undefined
  isPending: boolean
  error: unknown
  retry: () => void
} {
  const patient = usePatient(patientId)
  const logs = useRecoveryLogs(patientId)
  const plans = useTreatmentPlans(patientId)
  const schedules = useMedicationSchedules(patientId)
  const appointments = useAppointments(patientId)
  const weekDoses = useDoses(
    patientId,
    subDays(startOfToday(), 6).toISOString(),
    endOfToday().toISOString(),
  )
  const notes = useQuery({
    queryKey: queryKeys.doctorNotes.forPatient(patientId),
    queryFn: () => fetchDoctorNotes(patientId),
    enabled: Boolean(patientId),
  })

  const queries = [patient, logs, plans, schedules, appointments, weekDoses, notes]
  const failed = queries.find((query) => query.error)

  const data: PatientReportData | undefined =
    patient.data &&
    logs.data &&
    plans.data &&
    schedules.data &&
    appointments.data &&
    weekDoses.data &&
    notes.data
      ? {
          patient: patient.data,
          recoveryLogs: logs.data,
          plans: plans.data,
          schedules: schedules.data,
          appointments: appointments.data,
          weekAdherence: summariseAdherence(weekDoses.data),
          notes: notes.data,
        }
      : undefined

  return {
    data,
    // A report with one section silently missing is worse than no report,
    // so it is shown only once every part has arrived.
    isPending: !data && !failed,
    error: failed?.error ?? null,
    retry: () => {
      for (const query of queries) {
        if (query.error) void query.refetch()
      }
    },
  }
}

export type ReportOverview = {
  recoveryEntries: number
  goals: ReturnType<typeof summariseGoals>
  activePlans: number
  totalPlans: number
  /** Schedules running today: started, and not yet ended. */
  currentMedicines: number
  /** Scheduled or confirmed, and still ahead. */
  upcomingAppointments: number
}

/**
 * The report's overview figures. Each one is a count of records the patient
 * actually has; nothing is scored, projected or inferred.
 */
export function summariseReport(
  data: PatientReportData,
  now: Date = new Date(),
): ReportOverview {
  const today = toDateKey(now)

  return {
    recoveryEntries: data.recoveryLogs.length,
    goals: summariseGoals(data.plans.flatMap((plan) => plan.treatment_goal)),
    activePlans: data.plans.filter(
      (plan) => plan.treatment_plan_status === 'active',
    ).length,
    totalPlans: data.plans.length,
    currentMedicines: data.schedules.filter(
      (schedule) =>
        schedule.medication_schedule_start_date <= today &&
        (schedule.medication_schedule_end_date === null ||
          schedule.medication_schedule_end_date >= today),
    ).length,
    upcomingAppointments: data.appointments.filter((appointment) => {
      const when = parseISO(appointment.appointment_date)
      return (
        isValid(when) &&
        when >= now &&
        (appointment.appointment_status === 'scheduled' ||
          appointment.appointment_status === 'confirmed')
      )
    }).length,
  }
}
