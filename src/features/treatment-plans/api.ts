import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables, TablesUpdate } from '@/types/database.types'

export type TreatmentPlan = Tables<'treatment_plan'>
export type TreatmentGoal = Tables<'treatment_goal'>
export type TreatmentPlanStatus = Enums<'treatment_plan_status'>
export type TreatmentGoalStatus = Enums<'treatment_goal_status'>

export type PlanWithGoals = TreatmentPlan & {
  treatment_goal: TreatmentGoal[]
}

/**
 * Modules 3.4 "View Treatment Plan" and 5.7 "View Recovery Roadmap".
 *
 * Goals are fetched in the same request as their plans. Loading them
 * separately per plan would be an N+1 query, and the roadmap needs both
 * together to be worth rendering at all.
 */
export async function fetchTreatmentPlans(
  patientId: string,
): Promise<PlanWithGoals[]> {
  const { data, error } = await supabase
    .from('treatment_plan')
    .select(`*, treatment_goal (*)`)
    .eq('pat_id', patientId)
    .order('treatment_plan_start_date', { ascending: false })

  if (error) throw error

  // PostgREST returns embedded rows in an unspecified order; the roadmap
  // reads chronologically, so sort by target date with undated goals last.
  return (data as unknown as PlanWithGoals[]).map((plan) => ({
    ...plan,
    treatment_goal: [...plan.treatment_goal].sort((a, b) => {
      if (!a.treatment_goal_target_date) return 1
      if (!b.treatment_goal_target_date) return -1
      return a.treatment_goal_target_date.localeCompare(
        b.treatment_goal_target_date,
      )
    }),
  }))
}

/** Module 3.1 "Create Treatment Plan". */
export async function createTreatmentPlan(input: {
  patientId: string
  doctorId: string
  title: string
  description: string | null
  startDate: string
  endDate: string | null
}): Promise<TreatmentPlan> {
  const { data, error } = await supabase
    .from('treatment_plan')
    .insert({
      pat_id: input.patientId,
      doc_id: input.doctorId,
      treatment_plan_title: input.title,
      treatment_plan_description: input.description,
      treatment_plan_start_date: input.startDate,
      treatment_plan_end_date: input.endDate,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/** Module 3.2 "Update Treatment Plan". */
export async function updateTreatmentPlan(
  planId: string,
  changes: TablesUpdate<'treatment_plan'>,
): Promise<TreatmentPlan> {
  const { data, error } = await supabase
    .from('treatment_plan')
    .update(changes)
    .eq('treatment_plan_id', planId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Module 3.3 "Define Treatment Goals". */
export async function createTreatmentGoal(input: {
  planId: string
  description: string
  targetDate: string | null
}): Promise<TreatmentGoal> {
  const { data, error } = await supabase
    .from('treatment_goal')
    .insert({
      treatment_plan_id: input.planId,
      treatment_goal_description: input.description,
      treatment_goal_target_date: input.targetDate,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/** The progress a patient may record; only the system marks a goal missed. */
export type PatientGoalProgress = Extract<TreatmentGoalStatus, 'in_progress' | 'achieved'>

/**
 * Module 5.8: the patient records progress on their own goal (migration 55).
 * The database checks whose goal it is and which moves are allowed, and
 * keeps the change in the goal's history; nothing else on the goal changes.
 */
export async function updateTreatmentGoalStatus(
  goalId: string,
  status: PatientGoalProgress,
): Promise<TreatmentGoal> {
  const { data, error } = await supabase.rpc('patient_update_treatment_goal_status', {
    target_goal_id: goalId,
    new_status: status,
  })

  if (error) throw error
  return data
}

/**
 * Goals in the order they are due. A goal with no target date goes last,
 * after everything that has one, in the order the doctor added it. Shared by
 * the roadmap and the downloaded plan, so both list the goals alike.
 */
export function byTargetDate(a: TreatmentGoal, b: TreatmentGoal): number {
  return (a.treatment_goal_target_date ?? '9999-12-31').localeCompare(
    b.treatment_goal_target_date ?? '9999-12-31',
  )
}

/** Progress across a plan's goals, for the roadmap summary. */
export function summariseGoals(goals: TreatmentGoal[]): {
  total: number
  achieved: number
  percentage: number | null
} {
  const total = goals.length
  const achieved = goals.filter(
    (goal) => goal.treatment_goal_status === 'achieved',
  ).length

  return {
    total,
    achieved,
    percentage: total === 0 ? null : Math.round((achieved / total) * 100),
  }
}

// ---------------------------------------------------------------------------
// The care-plan lifecycle (migration 61)
// ---------------------------------------------------------------------------

/** Why a doctor discharged a plan; the database refuses any other value. */
export type ClosureReason =
  | 'completed_recovery'
  | 'transferred'
  | 'withdrew'
  | 'lost_to_follow_up'
  | 'referred'

/** The reasons, in the order the dialog lists them. */
export const CLOSURE_REASONS: readonly { value: ClosureReason; label: string }[] = [
  { value: 'completed_recovery', label: 'Completed recovery' },
  { value: 'transferred', label: 'Transferred' },
  { value: 'withdrew', label: 'Withdrew' },
  { value: 'lost_to_follow_up', label: 'Lost to follow-up' },
  { value: 'referred', label: 'Referred' },
]

export function closureReasonLabel(reason: string | null): string | null {
  return CLOSURE_REASONS.find((item) => item.value === reason)?.label ?? null
}

/**
 * Care still going on: an active plan. A plan is Active or Discharged
 * (migration 61); only the doctor ends it, by discharging.
 */
export function isOpenCare(status: TreatmentPlanStatus): boolean {
  return status === 'active'
}

/**
 * The patient's care has ended: a plan was discharged and none is active.
 * The database applies the same rule to new daily check-ins and marks an
 * appointment booked then as a follow-up (migration 61).
 */
export function careHasEnded(plans: readonly Pick<TreatmentPlan, 'treatment_plan_status'>[]): boolean {
  return (
    plans.some((plan) => plan.treatment_plan_status === 'discharged') &&
    !plans.some((plan) => isOpenCare(plan.treatment_plan_status))
  )
}

/**
 * The patient's assigned doctor discharges an active plan, with a reason.
 * The database checks who may and from which status; the patient's account
 * and records are untouched.
 */
export async function dischargeTreatmentPlan(planId: string, reason: ClosureReason): Promise<TreatmentPlan> {
  const { data, error } = await supabase.rpc('doctor_discharge_treatment_plan', {
    target_plan_id: planId,
    closure_reason: reason,
  })
  if (error) throw error
  return data
}

/** The assigned doctor reopens a discharged plan; the discharge stays in its history. */
export async function reopenTreatmentPlan(planId: string): Promise<TreatmentPlan> {
  const { data, error } = await supabase.rpc('doctor_reopen_treatment_plan', { target_plan_id: planId })
  if (error) throw error
  return data
}
