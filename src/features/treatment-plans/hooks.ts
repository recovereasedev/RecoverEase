import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import type { TablesUpdate } from '@/types/database.types'

import {
  createTreatmentGoal,
  createTreatmentPlan,
  dischargeTreatmentPlan,
  fetchTreatmentPlans,
  reopenTreatmentPlan,
  updateTreatmentGoalStatus,
  updateTreatmentPlan,
  type ClosureReason,
  type TreatmentGoalStatus,
} from './api'

export function useTreatmentPlans(patientId: string) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.treatment.plansFor(patientId),
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: Boolean(patientId),
  })
}

export function useCreateTreatmentPlan(patientId: string, doctorId: string) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      title: string
      description: string | null
      startDate: string
      endDate: string | null
    }) => createTreatmentPlan({ patientId, doctorId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.treatment.plansFor(patientId),
      })
    },
  })
}

export function useUpdateTreatmentPlan(patientId: string) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      planId: string
      changes: TablesUpdate<'treatment_plan'>
    }) => updateTreatmentPlan(input.planId, input.changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.treatment.plansFor(patientId),
      })
    },
  })
}

export function useCreateTreatmentGoal(patientId: string) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      planId: string
      description: string
      targetDate: string | null
    }) => createTreatmentGoal(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.treatment.plansFor(patientId),
      })
    },
  })
}

export function useUpdateGoalStatus(patientId: string) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { goalId: string; status: TreatmentGoalStatus }) =>
      updateTreatmentGoalStatus(input.goalId, input.status),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.treatment.plansFor(patientId),
      })
      // The change is recorded in the goal's history (migration 45), which
      // the progress charts' roadmap view reads.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.roadmap.forPatient(patientId),
      })
    },
  })
}

/**
 * Discharging or reopening changes the plan, which roadmap the patient sees
 * and whether they may check in, so the plans and the roadmap are read again.
 */
function useCaseChange<TInput>(patientId: string, change: (input: TInput) => Promise<unknown>) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.treatment.plansFor(patientId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.roadmap.forPatient(patientId) })
    },
  })
}

export const useDischargePlan = (patientId: string) =>
  useCaseChange(patientId, (input: { planId: string; reason: ClosureReason }) =>
    dischargeTreatmentPlan(input.planId, input.reason),
  )
export const useReopenPlan = (patientId: string) =>
  useCaseChange(patientId, (planId: string) => reopenTreatmentPlan(planId))
