import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import { todayIn } from '@/features/calendar/calendar-model'
import { fetchOwnClinicTimeZone } from '@/features/patients/api'
import { useNow } from '@/hooks/use-now'
import type { TablesUpdate } from '@/types/database.types'

import {
  createTreatmentGoal,
  createTreatmentPlan,
  fetchTreatmentPlans,
  updateTreatmentGoalStatus,
  updateTreatmentPlan,
  type PatientGoalProgress,
} from './api'

/**
 * Today in the signed-in member's clinic - the day the database judges a
 * goal's target date against (migration 55) - read the way the calendar and
 * the roadmap read it. Null until the clinic's time zone is known: no
 * device's day stands in for it.
 */
export function useClinicToday(): string | null {
  const queryKeys = useQueryKeys()
  const zone = useQuery({
    queryKey: queryKeys.ownClinic.timeZone(),
    queryFn: fetchOwnClinicTimeZone,
  })
  const now = useNow()
  return zone.data ? todayIn(zone.data, new Date(now)) : null
}

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
      // The plan's dates are its roadmap's fixed phases' (migration 56).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.roadmap.forPatient(patientId),
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
      // A new goal has a new roadmap phase, generated with it (migration 56).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.roadmap.forPatient(patientId),
      })
    },
  })
}

export function useUpdateGoalStatus(patientId: string) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { goalId: string; status: PatientGoalProgress }) =>
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
