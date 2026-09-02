import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'

import { fetchRecoveryLogs, saveRecoveryLog } from './api'

export function useRecoveryLogs(patientId: string) {
  return useQuery({
    queryKey: queryKeys.recoveryLogs.forPatient(patientId),
    queryFn: () => fetchRecoveryLogs(patientId),
    enabled: Boolean(patientId),
  })
}

export function useSaveRecoveryLog(patientId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      date: string
      notes: string | null
      moodRating: number | null
    }) => saveRecoveryLog({ patientId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recoveryLogs.forPatient(patientId),
      })
    },
  })
}
