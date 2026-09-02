import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'

import {
  createAppointment,
  createRescheduleRequest,
  decideRescheduleRequest,
  fetchAppointments,
  fetchRescheduleRequests,
  setAppointmentStatus,
  type AppointmentStatus,
} from './api'

export function useAppointments(patientId?: string) {
  return useQuery({
    queryKey: patientId
      ? queryKeys.appointments.forPatient(patientId)
      : queryKeys.appointments.forDoctor(),
    queryFn: () => fetchAppointments(patientId),
  })
}

export function useRescheduleRequests() {
  return useQuery({
    queryKey: queryKeys.appointments.rescheduleRequests(),
    queryFn: fetchRescheduleRequests,
  })
}

export function useCreateAppointment() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createAppointment,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.appointments.all,
      })
    },
  })
}

export function useSetAppointmentStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      appointmentId: string
      status: AppointmentStatus
    }) => setAppointmentStatus(input.appointmentId, input.status),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.appointments.all,
      })
    },
  })
}

export function useCreateRescheduleRequest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createRescheduleRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.appointments.all,
      })
    },
  })
}

export function useDecideRescheduleRequest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      requestId: string
      decision: 'approved' | 'declined'
    }) => decideRescheduleRequest(input.requestId, input.decision),
    onSuccess: () => {
      // Approving moves the appointment via a database trigger, so the
      // appointment list is stale too, not just the request list.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.appointments.all,
      })
    },
  })
}
