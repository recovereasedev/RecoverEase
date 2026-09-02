import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'
import type { TablesUpdate } from '@/types/database.types'

import {
  createTreatmentGoal,
  createTreatmentPlan,
  fetchTreatmentPlans,
  updateTreatmentGoalStatus,
  updateTreatmentPlan,
  type TreatmentGoalStatus,
} from './api'

export function useTreatmentPlans(patientId: string) {
  return useQuery({
    queryKey: queryKeys.treatment.plansFor(patientId),
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: Boolean(patientId),
  })
}

export function useCreateTreatmentPlan(patientId: string, doctorId: string) {
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
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { goalId: string; status: TreatmentGoalStatus }) =>
      updateTreatmentGoalStatus(input.goalId, input.status),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.treatment.plansFor(patientId),
      })
    },
  })
}
