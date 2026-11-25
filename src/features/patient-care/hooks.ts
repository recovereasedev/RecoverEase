import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import type { ClosureReason } from '@/features/treatment-plans/api'

import { dischargePatientCare, fetchPatientCare, reopenPatientCare } from './api'

/**
 * The patient's care, read fresh whenever a screen that depends on it opens:
 * the doctor may have discharged or reopened it since, and the check-in form
 * and notices follow it.
 */
export function usePatientCare(patientId: string) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.patients.care(patientId),
    queryFn: () => fetchPatientCare(patientId),
    enabled: Boolean(patientId),
    staleTime: 0,
  })
}

/**
 * A change of care changes what the patient may do everywhere, so the care,
 * the patient lists, the plans, the roadmap and the appointments are read
 * again.
 */
function useCareChange<TInput>(patientId: string, change: (input: TInput) => Promise<unknown>) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patients.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.treatment.plansFor(patientId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.roadmap.forPatient(patientId) })
    },
  })
}

export const useDischargePatientCare = (patientId: string) =>
  useCareChange(patientId, (reason: ClosureReason) => dischargePatientCare(patientId, reason))

export const useReopenPatientCare = (patientId: string) =>
  useCareChange(patientId, () => reopenPatientCare(patientId))
