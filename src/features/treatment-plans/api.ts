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

export async function updateTreatmentGoalStatus(
  goalId: string,
  status: TreatmentGoalStatus,
): Promise<void> {
  const { error } = await supabase
    .from('treatment_goal')
    .update({ treatment_goal_status: status })
    .eq('treatment_goal_id', goalId)

  if (error) throw error
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
