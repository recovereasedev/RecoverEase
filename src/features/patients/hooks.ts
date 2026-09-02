import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'
import type { TablesUpdate } from '@/types/database.types'

import {
  fetchAllDoctors,
  fetchMyDoctor,
  fetchMyPatients,
  fetchPatient,
  setDoctorActive,
  updateDoctor,
  updatePatient,
} from './api'

export function useMyPatients() {
  return useQuery({
    queryKey: queryKeys.patients.list(),
    queryFn: fetchMyPatients,
  })
}

export function usePatient(patientId: string) {
  return useQuery({
    queryKey: queryKeys.patients.detail(patientId),
    queryFn: () => fetchPatient(patientId),
    enabled: Boolean(patientId),
  })
}

export function useMyDoctor(doctorId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.doctors.mine(),
    queryFn: () => fetchMyDoctor(doctorId as string),
    enabled: Boolean(doctorId),
  })
}

export function useUpdatePatient(patientId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (changes: TablesUpdate<'patient'>) =>
      updatePatient(patientId, changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patients.all })
    },
  })
}

export function useAllDoctors() {
  return useQuery({
    queryKey: queryKeys.doctors.list(),
    queryFn: fetchAllDoctors,
  })
}

export function useSetDoctorActive() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { doctorId: string; isActive: boolean }) =>
      setDoctorActive(input.doctorId, input.isActive),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctors.all })
    },
  })
}

export function useUpdateDoctor(doctorId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (changes: TablesUpdate<'doctor'>) =>
      updateDoctor(doctorId, changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctors.all })
    },
  })
}
