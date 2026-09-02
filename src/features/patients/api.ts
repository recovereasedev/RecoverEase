import { supabase } from '@/lib/supabase/client'
import type { Tables, TablesUpdate } from '@/types/database.types'

export type Patient = Tables<'patient'>
export type Doctor = Tables<'doctor'>

/**
 * Module 2.3 "View Patient List".
 *
 * No `.eq('doc_id', …)` filter: the patient RLS policy already restricts rows
 * to the caller's own patients. Filtering here as well would suggest the
 * client is what keeps other doctors' patients out, and would silently
 * diverge if the policy ever changed.
 */
export async function fetchMyPatients(): Promise<Patient[]> {
  const { data, error } = await supabase
    .from('patient')
    .select('*')
    .order('pat_last_name', { ascending: true })

  if (error) throw error
  return data
}

/** Module 2.4 "View Patient Profile". */
export async function fetchPatient(patientId: string): Promise<Patient> {
  const { data, error } = await supabase
    .from('patient')
    .select('*')
    .eq('pat_id', patientId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    // Distinguishable from a network failure: either it does not exist or the
    // policy denied it, and the UI shows a "not found" state for both. Saying
    // which would confirm the existence of records the caller cannot read.
    throw new Error('That patient record could not be found.')
  }
  return data
}

/**
 * Modules 2.5 (doctor updates patient information) and 2.7 (patient updates
 * their own profile).
 *
 * The columns a patient must not change — doc_id, user_id, pat_status — are
 * refused by a database trigger, not by omitting them here. Client-side
 * omission is a convenience; the trigger is the control.
 */
export async function updatePatient(
  patientId: string,
  changes: TablesUpdate<'patient'>,
): Promise<Patient> {
  const { data, error } = await supabase
    .from('patient')
    .update(changes)
    .eq('pat_id', patientId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** The patient's own assigned clinician, for "who is treating me". */
export async function fetchMyDoctor(doctorId: string): Promise<Doctor | null> {
  const { data, error } = await supabase
    .from('doctor')
    .select('*')
    .eq('doc_id', doctorId)
    .maybeSingle()

  if (error) throw error
  return data
}

/** Module 2.6 "View and Update Doctor Profile". */
export async function updateDoctor(
  doctorId: string,
  changes: TablesUpdate<'doctor'>,
): Promise<Doctor> {
  const { data, error } = await supabase
    .from('doctor')
    .update(changes)
    .eq('doc_id', doctorId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Module 11.1 "View Doctor List" — administrators only. */
export async function fetchAllDoctors(): Promise<Doctor[]> {
  const { data, error } = await supabase
    .from('doctor')
    .select('*')
    .order('doc_last_name', { ascending: true })

  if (error) throw error
  return data
}

/** Module 11.3 "Deactivate / Reactivate Doctor Account". */
export async function setDoctorActive(
  doctorId: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('doctor')
    .update({ doc_is_active: isActive })
    .eq('doc_id', doctorId)

  if (error) throw error
}
