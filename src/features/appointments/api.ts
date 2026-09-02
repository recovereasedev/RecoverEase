import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

export type Appointment = Tables<'appointment'>
export type AppointmentStatus = Enums<'appointment_status'>
export type RescheduleRequest = Tables<'reschedule_request'>

export type AppointmentWithPatient = Appointment & {
  patient: Pick<Tables<'patient'>, 'pat_id' | 'pat_first_name' | 'pat_last_name'> | null
}

/** Modules 6.2 "View Appointment Calendar" and 6.7 "View Appointment History". */
export async function fetchAppointments(
  patientId?: string,
): Promise<AppointmentWithPatient[]> {
  let query = supabase
    .from('appointment')
    .select(
      `*, patient ( pat_id, pat_first_name, pat_last_name )`,
    )
    .order('appointment_date', { ascending: false })

  // Scoping to one patient is a view choice, not a security boundary: without
  // it the RLS policy still returns only the caller's own appointments (as a
  // patient) or their assigned patients' (as a doctor).
  if (patientId) {
    query = query.eq('pat_id', patientId)
  }

  const { data, error } = await query
  if (error) throw error
  return data as unknown as AppointmentWithPatient[]
}

/**
 * Module 6.1 "Schedule Follow-up Appointment".
 *
 * The doctor is not chosen by the patient: a database trigger rejects any
 * appointment whose doctor is not the patient's assigned clinician, so this
 * passes the assignment through rather than offering a picker that could
 * produce an invalid booking.
 */
export async function createAppointment(input: {
  patientId: string
  doctorId: string
  scheduledFor: string
}): Promise<Appointment> {
  const { data, error } = await supabase
    .from('appointment')
    .insert({
      pat_id: input.patientId,
      doc_id: input.doctorId,
      appointment_date: input.scheduledFor,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/** Module 6.6 "Confirm Appointment Attendance", and cancellation. */
export async function setAppointmentStatus(
  appointmentId: string,
  status: AppointmentStatus,
): Promise<void> {
  const { error } = await supabase
    .from('appointment')
    .update({ appointment_status: status })
    .eq('appointment_id', appointmentId)

  if (error) throw error
}

export type RescheduleRequestWithAppointment = RescheduleRequest & {
  appointment:
    | (Pick<Appointment, 'appointment_id' | 'appointment_date' | 'pat_id'> & {
        patient: Pick<
          Tables<'patient'>,
          'pat_first_name' | 'pat_last_name'
        > | null
      })
    | null
}

/** Module 6.3 "Review Appointment Reschedule Request". */
export async function fetchRescheduleRequests(): Promise<
  RescheduleRequestWithAppointment[]
> {
  const { data, error } = await supabase
    .from('reschedule_request')
    .select(
      `*,
       appointment (
         appointment_id,
         appointment_date,
         pat_id,
         patient ( pat_first_name, pat_last_name )
       )`,
    )
    .order('reschedule_request_created_at', { ascending: false })

  if (error) throw error
  return data as unknown as RescheduleRequestWithAppointment[]
}

/** Module 6.5 "Request Appointment Reschedule". */
export async function createRescheduleRequest(input: {
  appointmentId: string
  userId: string
  proposedFor: string
  reason: string | null
}): Promise<RescheduleRequest> {
  const { data, error } = await supabase
    .from('reschedule_request')
    .insert({
      appointment_id: input.appointmentId,
      user_id: input.userId,
      reschedule_request_date: input.proposedFor,
      reschedule_request_reason: input.reason,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Module 6.4 "Approve or Decline Reschedule Request".
 *
 * Only the status is sent. A database trigger stamps the response time and,
 * on approval, moves the appointment — so the two can never end up
 * inconsistent because a second client call failed.
 */
export async function decideRescheduleRequest(
  requestId: string,
  decision: 'approved' | 'declined',
): Promise<void> {
  const { error } = await supabase
    .from('reschedule_request')
    .update({ reschedule_request_status: decision })
    .eq('reschedule_request_id', requestId)

  if (error) throw error
}
