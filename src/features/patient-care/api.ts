import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

import type { ClosureReason } from '@/features/treatment-plans/api'

/**
 * A patient's care (migration 63): In Care or Discharged. Only the patient's
 * assigned, active doctor moves it, by pressing Discharge patient or Reopen
 * case. It is not the account status (`pat_status`) and not any treatment
 * plan's status, and nothing about plans, goals, dates or jobs decides it.
 */
export type PatientCareStatus = 'in_care' | 'discharged'

export type PatientCare = Pick<
  Tables<'patient'>,
  'pat_id' | 'pat_care_status' | 'pat_care_closure_reason' | 'pat_care_discharged_at'
>

export type PatientCareEvent = Tables<'patient_care_event'>

/** Whether the patient's care has ended. Anything else reads as in care. */
export function isDischarged(care: Pick<PatientCare, 'pat_care_status'> | null | undefined): boolean {
  return care?.pat_care_status === 'discharged'
}

export async function fetchPatientCare(patientId: string): Promise<PatientCare> {
  const { data, error } = await supabase
    .from('patient')
    .select('pat_id, pat_care_status, pat_care_closure_reason, pat_care_discharged_at')
    .eq('pat_id', patientId)
    .single()
  if (error) throw error
  return data
}

/** Every care change for the patient, oldest first. */
export async function fetchPatientCareEvents(patientId: string): Promise<PatientCareEvent[]> {
  const { data, error } = await supabase
    .from('patient_care_event')
    .select('*')
    .eq('pat_id', patientId)
    .order('patient_care_changed_at', { ascending: true })
  if (error) throw error
  return data
}

/**
 * The patient's assigned doctor discharges the patient, with a reason. The
 * database checks who may and from which status; the account, plans,
 * medicines and appointments are untouched.
 */
export async function dischargePatientCare(patientId: string, reason: ClosureReason) {
  const { data, error } = await supabase.rpc('doctor_discharge_patient_care', {
    target_pat_id: patientId,
    closure_reason: reason,
  })
  if (error) throw error
  return data
}

/** The assigned doctor reopens the patient's care; the discharge stays in the history. */
export async function reopenPatientCare(patientId: string) {
  const { data, error } = await supabase.rpc('doctor_reopen_patient_care', { target_pat_id: patientId })
  if (error) throw error
  return data
}
