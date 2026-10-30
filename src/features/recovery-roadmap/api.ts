import { supabase } from '@/lib/supabase/client'
import type { Tables, TablesInsert, TablesUpdate } from '@/types/database.types'

/**
 * Module 5.7 "View Recovery Roadmap", enhanced (migration 45).
 *
 * A treatment plan is the roadmap's parent. Its phases and the activities a
 * doctor assigns in them are read here; everything else on the roadmap is
 * read from where it already lives - goals with their plans
 * (`fetchTreatmentPlans`), doses (`fetchAllDoses`), appointments
 * (`fetchAppointments`) - and is never copied.
 *
 * Archived phases and activities are not read: archiving is how a doctor
 * takes one off the roadmap while its history stays in the database.
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
// The doctor: build and change the roadmap
// ---------------------------------------------------------------------------
// The database decides who may (`is_my_patient`: the patient's assigned,
// active doctor), numbers new rows at the end, and checks every date
// against the plan's.

export type PhaseInput = {
  title: string
  description: string | null
  startDate: string | null
  targetEndDate: string | null
}

export async function createPhase(planId: string, input: PhaseInput): Promise<RecoveryPhase> {
  // No place in the order: the database puts it last (`recovery_phase_prepare`).
  const row: Omit<TablesInsert<'recovery_phase'>, 'recovery_phase_order'> = {
    treatment_plan_id: planId,
    recovery_phase_title: input.title,
    recovery_phase_description: input.description,
    recovery_phase_start_date: input.startDate,
    recovery_phase_target_end_date: input.targetEndDate,
  }
  const { data, error } = await supabase
    .from('recovery_phase')
    .insert(row as TablesInsert<'recovery_phase'>)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updatePhase(phaseId: string, input: PhaseInput): Promise<RecoveryPhase> {
  return changePhase(phaseId, {
    recovery_phase_title: input.title,
    recovery_phase_description: input.description,
    recovery_phase_start_date: input.startDate,
    recovery_phase_target_end_date: input.targetEndDate,
  })
}

/** Takes a phase off the roadmap; its goals stay in the plan, unlinked. */
export async function archivePhase(phaseId: string): Promise<RecoveryPhase> {
  // The database stamps its own time; any non-null value asks for it.
  return changePhase(phaseId, { recovery_phase_archived_at: new Date().toISOString() })
}

async function changePhase(
  phaseId: string,
  changes: TablesUpdate<'recovery_phase'>,
): Promise<RecoveryPhase> {
  const { data, error } = await supabase
    .from('recovery_phase')
    .update(changes)
    .eq('recovery_phase_id', phaseId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function reorderPhases(planId: string, phaseIds: readonly string[]): Promise<void> {
  const { error } = await supabase.rpc('doctor_reorder_recovery_phases', {
    target_plan_id: planId,
    phase_ids: [...phaseIds],
  })
  if (error) throw error
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
 * Puts an archived phase back on the roadmap, at the end of its plan's order,
 * with its activities and whatever was done in them; its goals were taken
 * out when it was archived and stay out until placed again.
 */
export async function restorePhase(phaseId: string): Promise<RecoveryPhase> {
  return changePhase(phaseId, { recovery_phase_archived_at: null })
}

/**
 * Puts an archived activity back, at the end of its phase, done or not as it
 * was. The database refuses it while the phase itself is archived.
 */
export async function restoreActivity(activityId: string): Promise<RecoveryActivity> {
  return changeActivity(activityId, { recovery_activity_archived_at: null })
}

export type ArchivedRoadmap = {
  /** The plan's archived phases. */
  phases: RecoveryPhase[]
  /** Archived activities in the plan's current phases; one in an archived phase comes back with it. */
  activities: RecoveryActivity[]
}

/** What the doctor has archived in a plan, for restoring. */
export async function fetchArchived(planId: string): Promise<ArchivedRoadmap> {
  // Read whole and sorted here, where the archive is told apart.
  const { data: phases, error: phaseError } = await supabase
    .from('recovery_phase')
    .select('*')
    .eq('treatment_plan_id', planId)
  if (phaseError) throw phaseError
  const current = new Set(
    phases.filter((phase) => phase.recovery_phase_archived_at === null).map((phase) => phase.recovery_phase_id),
  )
  let activities: RecoveryActivity[] = []
  if (current.size > 0) {
    const { data, error } = await supabase
      .from('recovery_activity')
      .select('*')
      .in('recovery_phase_id', [...current])
    if (error) throw error
    activities = data.filter((activity) => activity.recovery_activity_archived_at !== null)
  }
  const newestFirst = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '')
  return {
    phases: phases
      .filter((phase) => phase.recovery_phase_archived_at !== null)
      .sort((a, b) => newestFirst(a.recovery_phase_archived_at, b.recovery_phase_archived_at)),
    activities: activities.sort((a, b) => newestFirst(a.recovery_activity_archived_at, b.recovery_activity_archived_at)),
  }
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

/** Places an existing goal in a phase of its own plan, or takes it out (null). */
export async function linkGoalToPhase(goalId: string, phaseId: string | null): Promise<void> {
  const { data, error } = await supabase
    .from('treatment_goal')
    .update({ recovery_phase_id: phaseId })
    .eq('treatment_goal_id', goalId)
    .select('treatment_goal_id')
  if (error) throw error
  // Row-level security returns no row rather than an error.
  if (data.length === 0) throw new Error('The goal was not moved.')
}
