import { supabase } from '@/lib/supabase/client'
import type { Tables, TablesInsert, TablesUpdate } from '@/types/database.types'

/**
 * Module 5.7 "View Recovery Roadmap", enhanced (migration 45) and generated
 * (migration 56).
 *
 * A treatment plan is the roadmap's parent. Its phases are made by the
 * database - Initial Recovery, one Recovery and Monitoring phase per goal,
 * Follow-up and Assessment - and no one writes them from here. The phases
 * and the activities a doctor assigns in them are read here; everything else on the roadmap is
 * read from where it already lives - goals with their plans
 * (`fetchTreatmentPlans`), doses (`fetchAllDoses`), appointments
 * (`fetchAppointments`) - and is never copied.
 *
 * Archived phases and activities are not read: an archived activity is one
 * the doctor took off the roadmap, an archived phase a deleted goal's or one
 * made by hand before 56; their history stays in the database.
 */

export type RecoveryPhase = Tables<'recovery_phase'>
export type RecoveryActivity = Tables<'recovery_activity'>
export type GoalStatusEvent = Tables<'treatment_goal_status_event'>

export type Roadmap = {
  phases: RecoveryPhase[]
  activities: RecoveryActivity[]
}

/** The current phases of these plans, and their current activities, in order. */
export async function fetchRoadmap(planIds: readonly string[]): Promise<Roadmap> {
  if (planIds.length === 0) return { phases: [], activities: [] }

  const { data: phases, error: phaseError } = await supabase
    .from('recovery_phase')
    .select('*')
    .in('treatment_plan_id', [...planIds])
    .is('recovery_phase_archived_at', null)
    .order('recovery_phase_order', { ascending: true })
  if (phaseError) throw phaseError
  if (phases.length === 0) return { phases: [], activities: [] }

  const { data: activities, error: activityError } = await supabase
    .from('recovery_activity')
    .select('*')
    .in(
      'recovery_phase_id',
      phases.map((phase) => phase.recovery_phase_id),
    )
    .is('recovery_activity_archived_at', null)
    .order('recovery_activity_order', { ascending: true })
  if (activityError) throw activityError

  return { phases, activities }
}

/**
 * The recorded changes of these goals' statuses from `from` on - what a
 * chart may say about when a goal was achieved. Changes before migration 45
 * were never recorded, so a goal achieved before it has none.
 */
export async function fetchGoalStatusEvents(
  goalIds: readonly string[],
  from: string,
): Promise<GoalStatusEvent[]> {
  if (goalIds.length === 0) return []
  const { data, error } = await supabase
    .from('treatment_goal_status_event')
    .select('*')
    .in('treatment_goal_id', [...goalIds])
    .gte('treatment_goal_changed_at', from)
    .order('treatment_goal_changed_at', { ascending: true })
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// The patient: mark an activity done, or undo it
// ---------------------------------------------------------------------------
// Through the database's functions only: they record who and when at the
// server, refuse a second press, and keep each change as an event.

export async function completeActivity(activityId: string): Promise<RecoveryActivity> {
  const { data, error } = await supabase.rpc('patient_complete_recovery_activity', {
    target_activity_id: activityId,
  })
  if (error) throw error
  return data as unknown as RecoveryActivity
}

export async function reopenActivity(activityId: string): Promise<RecoveryActivity> {
  const { data, error } = await supabase.rpc('patient_reopen_recovery_activity', {
    target_activity_id: activityId,
  })
  if (error) throw error
  return data as unknown as RecoveryActivity
}

// ---------------------------------------------------------------------------
// The doctor: the activities in each phase, and the follow-up appointment
// ---------------------------------------------------------------------------
// The database decides who may (`is_my_patient`: the patient's assigned,
// active doctor), numbers new rows at the end, and checks every date
// against the plan's. Phases themselves are never written here.

/**
 * Chooses which of the patient's appointments the plan's Follow-up and
 * Assessment phase shows, or none (null). The database refuses another
 * patient's appointment.
 */
export async function setFollowUpAppointment(planId: string, appointmentId: string | null): Promise<void> {
  const { data, error } = await supabase
    .from('treatment_plan')
    .update({ treatment_plan_follow_up_appointment_id: appointmentId })
    .eq('treatment_plan_id', planId)
    .select('treatment_plan_id')
  if (error) throw error
  // Row-level security returns no row rather than an error.
  if (data.length === 0) throw new Error('The follow-up appointment was not saved.')
}

export type ActivityInput = {
  title: string
  description: string | null
  targetDate: string | null
}

export async function createActivity(phaseId: string, input: ActivityInput): Promise<RecoveryActivity> {
  // Put last in its phase by the database (`recovery_activity_prepare`).
  const row: Omit<TablesInsert<'recovery_activity'>, 'recovery_activity_order'> = {
    recovery_phase_id: phaseId,
    recovery_activity_title: input.title,
    recovery_activity_description: input.description,
    recovery_activity_target_date: input.targetDate,
  }
  const { data, error } = await supabase
    .from('recovery_activity')
    .insert(row as TablesInsert<'recovery_activity'>)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateActivity(activityId: string, input: ActivityInput): Promise<RecoveryActivity> {
  return changeActivity(activityId, {
    recovery_activity_title: input.title,
    recovery_activity_description: input.description,
    recovery_activity_target_date: input.targetDate,
  })
}

/** Takes an activity off the roadmap; whether and when it was done is kept. */
export async function archiveActivity(activityId: string): Promise<RecoveryActivity> {
  return changeActivity(activityId, { recovery_activity_archived_at: new Date().toISOString() })
}

/**
 * Puts an archived activity back, at the end of its phase, done or not as it
 * was. The database refuses it while the phase itself is archived.
 */
export async function restoreActivity(activityId: string): Promise<RecoveryActivity> {
  return changeActivity(activityId, { recovery_activity_archived_at: null })
}

/** What the doctor has archived in a plan's current phases, newest first, for restoring. */
export async function fetchArchived(planId: string): Promise<RecoveryActivity[]> {
  const { data: phases, error: phaseError } = await supabase
    .from('recovery_phase')
    .select('recovery_phase_id')
    .eq('treatment_plan_id', planId)
    .is('recovery_phase_archived_at', null)
  if (phaseError) throw phaseError
  if (phases.length === 0) return []
  // Read whole and sorted here, where the archive is told apart.
  const { data, error } = await supabase
    .from('recovery_activity')
    .select('*')
    .in(
      'recovery_phase_id',
      phases.map((phase) => phase.recovery_phase_id),
    )
  if (error) throw error
  return data
    .filter((activity) => activity.recovery_activity_archived_at !== null)
    .sort((a, b) => (b.recovery_activity_archived_at ?? '').localeCompare(a.recovery_activity_archived_at ?? ''))
}

async function changeActivity(
  activityId: string,
  changes: TablesUpdate<'recovery_activity'>,
): Promise<RecoveryActivity> {
  const { data, error } = await supabase
    .from('recovery_activity')
    .update(changes)
    .eq('recovery_activity_id', activityId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function reorderActivities(phaseId: string, activityIds: readonly string[]): Promise<void> {
  const { error } = await supabase.rpc('doctor_reorder_recovery_activities', {
    target_phase_id: phaseId,
    activity_ids: [...activityIds],
  })
  if (error) throw error
}
