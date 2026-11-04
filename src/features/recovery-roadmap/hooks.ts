import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import type { PlanWithGoals } from '@/features/treatment-plans/api'

import {
  archiveActivity,
  archivePhase,
  completeActivity,
  createActivity,
  createPhase,
  fetchArchived,
  fetchGoalStatusEvents,
  fetchRoadmap,
  linkGoalToPhase,
  reopenActivity,
  reorderActivities,
  reorderPhases,
  restoreActivity,
  restorePhase,
  updateActivity,
  updatePhase,
  type ActivityInput,
  type PhaseInput,
} from './api'

/**
 * The clinician's copy keeps itself current as the progress panel's does
 * (`useRecoveryProgress`): every minute, and when the window regains focus,
 * so an activity the patient marks done shows on the record without a
 * reload. The patient's own copy is refreshed by their own writes.
 */
const LIVE = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const

/** The phases and activities of these plans of the patient. */
export function useRoadmap(
  patientId: string,
  plans: readonly PlanWithGoals[] | undefined,
  { live = false }: { live?: boolean } = {},
) {
  const queryKeys = useQueryKeys()
  const planIds = (plans ?? []).map((plan) => plan.treatment_plan_id).sort()
  return useQuery({
    queryKey: queryKeys.roadmap.ofPlans(patientId, planIds),
    queryFn: () => fetchRoadmap(planIds),
    enabled: Boolean(patientId) && plans !== undefined,
    ...(live ? LIVE : {}),
  })
}

/** A plan's archived phases and activities, read when the doctor opens them. */
export function useArchivedRoadmap(patientId: string, planId: string, enabled: boolean) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.roadmap.archivedOf(patientId, planId),
    queryFn: () => fetchArchived(planId),
    enabled: Boolean(patientId) && enabled,
  })
}

/** Recorded goal status changes from `from` on, for the charts. */
export function useGoalStatusEvents(
  patientId: string,
  goalIds: readonly string[],
  from: string,
  { live = false }: { live?: boolean } = {},
) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: [...queryKeys.roadmap.goalEvents(patientId, from), ...[...goalIds].sort()],
    queryFn: () => fetchGoalStatusEvents(goalIds, from),
    enabled: Boolean(patientId),
    ...(live ? LIVE : {}),
  })
}

/**
 * A change to the roadmap, refreshing everything that shows it: the
 * roadmap itself, and the plans (a goal's phase is part of the goal).
 */
function useRoadmapChange<TInput, TResult>(patientId: string, change: (input: TInput) => Promise<TResult>) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.roadmap.forPatient(patientId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.treatment.plansFor(patientId) })
    },
  })
}

// The patient's two writes.
export const useCompleteActivity = (patientId: string) =>
  useRoadmapChange(patientId, (activityId: string) => completeActivity(activityId))
export const useReopenActivity = (patientId: string) =>
  useRoadmapChange(patientId, (activityId: string) => reopenActivity(activityId))

// The doctor's.
export const useCreatePhase = (patientId: string) =>
  useRoadmapChange(patientId, (input: { planId: string } & PhaseInput) => createPhase(input.planId, input))
export const useUpdatePhase = (patientId: string) =>
  useRoadmapChange(patientId, (input: { phaseId: string } & PhaseInput) => updatePhase(input.phaseId, input))
export const useArchivePhase = (patientId: string) =>
  useRoadmapChange(patientId, (phaseId: string) => archivePhase(phaseId))
export const useReorderPhases = (patientId: string) =>
  useRoadmapChange(patientId, (input: { planId: string; phaseIds: string[] }) =>
    reorderPhases(input.planId, input.phaseIds),
  )
export const useCreateActivity = (patientId: string) =>
  useRoadmapChange(patientId, (input: { phaseId: string } & ActivityInput) => createActivity(input.phaseId, input))
export const useUpdateActivity = (patientId: string) =>
  useRoadmapChange(patientId, (input: { activityId: string } & ActivityInput) =>
    updateActivity(input.activityId, input),
  )
export const useArchiveActivity = (patientId: string) =>
  useRoadmapChange(patientId, (activityId: string) => archiveActivity(activityId))
export const useReorderActivities = (patientId: string) =>
  useRoadmapChange(patientId, (input: { phaseId: string; activityIds: string[] }) =>
    reorderActivities(input.phaseId, input.activityIds),
  )
export const useRestorePhase = (patientId: string) =>
  useRoadmapChange(patientId, (phaseId: string) => restorePhase(phaseId))
export const useRestoreActivity = (patientId: string) =>
  useRoadmapChange(patientId, (activityId: string) => restoreActivity(activityId))
export const useLinkGoal = (patientId: string) =>
  useRoadmapChange(patientId, (input: { goalId: string; phaseId: string | null }) =>
    linkGoalToPhase(input.goalId, input.phaseId),
  )
