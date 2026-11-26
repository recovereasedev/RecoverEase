import type {
  AppointmentRecord,
  MedicationRecord,
  PatientRecordStore,
  PhaseRecord,
  PlanRecord,
  RescheduleRecord,
} from './patient-context.ts'

/**
 * The database side of `patient-context.ts`, for one patient.
 *
 * `client` must be the patient's own client (`callerClient` in auth.ts) -
 * NEVER the service-role client. Reading as the patient means Row Level
 * Security admits only rows `app_private.can_access_patient` allows them,
 * exactly as in the app's own pages (migration 6 and 45 policies on
 * medication_schedule, prescription, appointment, reschedule_request,
 * treatment_plan, treatment_goal, treatment_goal_status_event,
 * recovery_phase and recovery_activity). On top of that, every query names
 * `patId` - the conversation's patient, proved to be the caller - and every
 * row that comes back is checked against it; a row for anyone else fails the
 * whole read rather than being quietly dropped, since it would mean a lock
 * had failed.
 *
 * Only the columns an answer needs are selected. No ids leave this file
 * except the ones `patient-context.ts` needs to join rows, and it does not
 * pass them on to the model.
 *
 * The client is typed structurally, so this file has no Deno import and its
 * queries can be checked in Node with a recording fake.
 */

/** The part of a PostgREST query builder used here; each call returns the builder. */
export type QueryBuilder = PromiseLike<{ data: unknown; error: unknown }> & {
  select(columns: string): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  lt(column: string, value: unknown): QueryBuilder
  in(column: string, values: readonly unknown[]): QueryBuilder
  is(column: string, value: null): QueryBuilder
  order(column: string, options: { ascending: boolean }): QueryBuilder
  limit(count: number): QueryBuilder
  abortSignal(signal: AbortSignal): QueryBuilder
}

export type RecordClient = { from(table: string): QueryBuilder }

export class RecordOwnershipError extends Error {
  constructor() {
    super('A record that does not belong to this patient was returned')
    this.name = 'RecordOwnershipError'
  }
}

/** How many rows of each kind are read, at most. */
export const RECORD_LIMITS = {
  medications: 50,
  upcomingAppointments: 10,
  recentAppointments: 3,
  rescheduleRequests: 10,
  plans: 5,
  phases: 60,
} as const

type Row = Record<string, unknown>

async function rows(query: QueryBuilder): Promise<Row[]> {
  const { data, error } = await query
  if (error) throw new Error('records could not be read')
  return (Array.isArray(data) ? data : []) as Row[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const embedded = (value: unknown): Row | null =>
  Array.isArray(value) ? ((value[0] as Row | undefined) ?? null) : ((value as Row | null) ?? null)

export function patientRecordStore(
  client: RecordClient,
  patId: string,
  deadline: () => AbortSignal,
): PatientRecordStore {
  const owned = (value: unknown) => {
    if (value !== patId) throw new RecordOwnershipError()
  }

  return {
    async clinicTimeZone() {
      // The patient reads their own clinic only (clinic_select_member).
      const found = await rows(
        client.from('clinic').select('clinic_timezone').limit(2).abortSignal(deadline()),
      )
      if (found.length !== 1) throw new Error('clinic not found')
      return text(found[0]!.clinic_timezone)
    },

    async medications(): Promise<MedicationRecord[]> {
      const found = await rows(
        client
          .from('medication_schedule')
          .select(
            'medication_schedule_name, medication_schedule_dosage, medication_schedule_frequency, ' +
              'medication_schedule_times, medication_schedule_instructions, ' +
              'medication_schedule_start_date, medication_schedule_end_date, ' +
              'medication_schedule_reminders_is_enabled, prescription!inner ( pat_id )',
          )
          .eq('prescription.pat_id', patId)
          .order('medication_schedule_start_date', { ascending: false })
          .limit(RECORD_LIMITS.medications)
          .abortSignal(deadline()),
      )
      return found.map((row) => {
        owned(embedded(row.prescription)?.pat_id)
        return {
          name: text(row.medication_schedule_name),
          dosage: text(row.medication_schedule_dosage),
          timesPerDay: Number(row.medication_schedule_frequency) || 0,
          times: Array.isArray(row.medication_schedule_times)
            ? (row.medication_schedule_times as unknown[]).map(text)
            : [],
          instructions: textOrNull(row.medication_schedule_instructions),
          startDate: text(row.medication_schedule_start_date),
          endDate: textOrNull(row.medication_schedule_end_date),
          remindersOn: row.medication_schedule_reminders_is_enabled !== false,
        }
      })
    },

    async appointments(nowIso) {
      const columns = 'appointment_id, appointment_date, appointment_status, pat_id'
      const [upcoming, recent] = await Promise.all([
        rows(
          client
            .from('appointment')
            .select(columns)
            .eq('pat_id', patId)
            .gte('appointment_date', nowIso)
            .order('appointment_date', { ascending: true })
            .limit(RECORD_LIMITS.upcomingAppointments)
            .abortSignal(deadline()),
        ),
        rows(
          client
            .from('appointment')
            .select(columns)
            .eq('pat_id', patId)
            .lt('appointment_date', nowIso)
            .order('appointment_date', { ascending: false })
            .limit(RECORD_LIMITS.recentAppointments)
            .abortSignal(deadline()),
        ),
      ])
      const toRecord = (row: Row): AppointmentRecord => {
        owned(row.pat_id)
        return {
          appointmentId: text(row.appointment_id),
          at: text(row.appointment_date),
          status: text(row.appointment_status),
        }
      }
      return { upcoming: upcoming.map(toRecord), recent: recent.map(toRecord) }
    },

    async rescheduleRequests(): Promise<RescheduleRecord[]> {
      // Not the reason the patient gave: it is not needed to answer, and it
      // is free text the patient wrote.
      const found = await rows(
        client
          .from('reschedule_request')
          .select(
            'appointment_id, reschedule_request_date, reschedule_request_status, ' +
              'reschedule_request_created_at, reschedule_request_responded_at, ' +
              'appointment!inner ( pat_id )',
          )
          .eq('appointment.pat_id', patId)
          .order('reschedule_request_created_at', { ascending: false })
          .limit(RECORD_LIMITS.rescheduleRequests)
          .abortSignal(deadline()),
      )
      return found.map((row) => {
        owned(embedded(row.appointment)?.pat_id)
        return {
          appointmentId: text(row.appointment_id),
          requestedFor: text(row.reschedule_request_date),
          status: text(row.reschedule_request_status),
          createdAt: text(row.reschedule_request_created_at),
          respondedAt: textOrNull(row.reschedule_request_responded_at),
        }
      })
    },

    async treatmentPlans(): Promise<PlanRecord[]> {
      const found = await rows(
        client
          .from('treatment_plan')
          .select(
            'treatment_plan_id, pat_id, treatment_plan_title, treatment_plan_description, ' +
              'treatment_plan_status, treatment_plan_start_date, treatment_plan_end_date, ' +
              'treatment_plan_discharged_at, ' +
              'treatment_goal ( treatment_goal_id, treatment_goal_description, ' +
              'treatment_goal_status, treatment_goal_target_date, ' +
              'treatment_goal_status_event ( treatment_goal_new_status, treatment_goal_changed_at ) )',
          )
          .eq('pat_id', patId)
          .order('treatment_plan_start_date', { ascending: false })
          .limit(RECORD_LIMITS.plans)
          .abortSignal(deadline()),
      )
      return found.map((row) => {
        owned(row.pat_id)
        const goals = Array.isArray(row.treatment_goal) ? (row.treatment_goal as Row[]) : []
        return {
          planId: text(row.treatment_plan_id),
          title: text(row.treatment_plan_title),
          description: textOrNull(row.treatment_plan_description),
          status: text(row.treatment_plan_status),
          startDate: text(row.treatment_plan_start_date),
          endDate: textOrNull(row.treatment_plan_end_date),
          dischargedAt: textOrNull(row.treatment_plan_discharged_at),
          goals: goals.map((goal) => {
            const status = text(goal.treatment_goal_status)
            const events = Array.isArray(goal.treatment_goal_status_event)
              ? (goal.treatment_goal_status_event as Row[])
              : []
            // When it last reached the status it has now.
            const since = events
              .filter((event) => event.treatment_goal_new_status === status)
              .map((event) => text(event.treatment_goal_changed_at))
              .sort()
              .at(-1)
            return {
              goalId: text(goal.treatment_goal_id),
              description: text(goal.treatment_goal_description),
              status,
              targetDate: textOrNull(goal.treatment_goal_target_date),
              statusSince: since ?? null,
            }
          }),
        }
      })
    },

    async roadmapPhases(planIds): Promise<PhaseRecord[]> {
      // The plan ids come from `treatmentPlans`, whose rows were each checked
      // to be this patient's; each phase is checked to be in one of them.
      if (planIds.length === 0) return []
      const plans = new Set(planIds)
      const found = await rows(
        client
          .from('recovery_phase')
          .select(
            'treatment_plan_id, recovery_phase_title, recovery_phase_description, ' +
              'recovery_phase_kind, recovery_phase_order, recovery_phase_start_date, ' +
              'recovery_phase_target_end_date, treatment_goal_id, ' +
              'recovery_activity ( recovery_activity_title, recovery_activity_target_date, ' +
              'recovery_activity_order, recovery_activity_completed_at, recovery_activity_archived_at )',
          )
          .in('treatment_plan_id', planIds)
          .is('recovery_phase_archived_at', null)
          .order('recovery_phase_order', { ascending: true })
          .limit(RECORD_LIMITS.phases)
          .abortSignal(deadline()),
      )
      return found.map((row) => {
        if (!plans.has(text(row.treatment_plan_id))) throw new RecordOwnershipError()
        const activities = Array.isArray(row.recovery_activity)
          ? (row.recovery_activity as Row[])
          : []
        return {
          planId: text(row.treatment_plan_id),
          title: text(row.recovery_phase_title),
          description: textOrNull(row.recovery_phase_description),
          kind: textOrNull(row.recovery_phase_kind),
          order: Number(row.recovery_phase_order) || 0,
          startDate: textOrNull(row.recovery_phase_start_date),
          targetEndDate: textOrNull(row.recovery_phase_target_end_date),
          goalId: textOrNull(row.treatment_goal_id),
          activities: activities
            .filter((activity) => activity.recovery_activity_archived_at == null)
            .map((activity) => ({
              title: text(activity.recovery_activity_title),
              targetDate: textOrNull(activity.recovery_activity_target_date),
              order: Number(activity.recovery_activity_order) || 0,
              completedAt: textOrNull(activity.recovery_activity_completed_at),
            })),
        }
      })
    },
  }
}
