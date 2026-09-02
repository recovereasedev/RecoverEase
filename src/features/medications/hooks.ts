import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'

import {
  createMedicationSchedule,
  createPrescription,
  fetchDoses,
  fetchSchedules,
  setDoseStatus,
  type MedicationLogStatus,
} from './api'

export function useMedicationSchedules(patientId: string) {
  return useQuery({
    queryKey: queryKeys.medications.schedulesFor(patientId),
    queryFn: () => fetchSchedules(patientId),
    enabled: Boolean(patientId),
  })
}

export function useDoses(patientId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.medications.dosesFor(patientId, from, to),
    queryFn: () => fetchDoses({ patientId, from, to }),
    enabled: Boolean(patientId),
  })
}

export function useSetDoseStatus(patientId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { doseId: string; status: MedicationLogStatus }) =>
      setDoseStatus(input.doseId, input.status),
    onSuccess: () => {
      // Invalidate the whole medication branch: marking a dose changes the
      // day's checklist and the adherence summary, which are separate queries
      // over different date windows.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.medications.all,
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.medications.adherenceFor(patientId),
      })
    },
  })
}

export function useCreatePrescription(patientId: string, doctorId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { notes: string | null }) =>
      createPrescription({ patientId, doctorId, notes: input.notes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.prescriptions.forPatient(patientId),
      })
    },
  })
}

export function useCreateMedicationSchedule(patientId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createMedicationSchedule,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.medications.all,
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.prescriptions.forPatient(patientId),
      })
    },
  })
}
