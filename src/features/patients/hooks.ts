import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import type { TablesUpdate } from '@/types/database.types'

import {
  fetchAllDoctors,
  fetchMyDoctor,
  fetchMyPatients,
  fetchPatient,
  fetchReassignmentCounts,
  reassignDoctorPatients,
  setDoctorActive,
  updateDoctor,
  updatePatient,
} from './api'

export function useMyPatients() {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.patients.list(),
    queryFn: fetchMyPatients,
  })
}

export function usePatient(patientId: string) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.patients.detail(patientId),
    queryFn: () => fetchPatient(patientId),
    enabled: Boolean(patientId),
  })
}

export function useMyDoctor(doctorId: string | undefined) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.doctors.mine(),
    queryFn: () => fetchMyDoctor(doctorId as string),
    enabled: Boolean(doctorId),
  })
}

export function useUpdatePatient(patientId: string) {
  const queryKeys = useQueryKeys()
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
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.doctors.list(),
    queryFn: fetchAllDoctors,
  })
}

export function useSetDoctorActive() {
  const queryKeys = useQueryKeys()
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
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (changes: TablesUpdate<'doctor'>) =>
      updateDoctor(doctorId, changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctors.all })
    },
  })
}

export function useReassignmentCounts(doctorId: string) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.doctors.reassignmentCounts(doctorId),
    queryFn: () => fetchReassignmentCounts(doctorId),
  })
}

export function useReassignDoctorPatients() {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: reassignDoctorPatients,
    onSuccess: () => {
      // The counts on the doctors page and the dashboard both moved.
      void queryClient.invalidateQueries({ queryKey: queryKeys.doctors.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.dashboard() })
    },
  })
}
