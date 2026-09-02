import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type DoctorNote = Tables<'doctor_note'>

/**
 * Modules 5.4 "Add Doctor's Notes" and 5.5 "View Doctor's Notes History".
 *
 * Both are clinician-only in the module specification, and no patient module
 * grants access to notes. The `doctor_note` table has no patient SELECT
 * policy at all, so a patient querying it receives zero rows rather than a
 * filtered view — this module is simply never reachable from patient screens.
 */
export async function fetchDoctorNotes(
  patientId: string,
): Promise<DoctorNote[]> {
  const { data, error } = await supabase
    .from('doctor_note')
    .select('*')
    .eq('pat_id', patientId)
    .order('doctor_note_created_at', { ascending: false })

  if (error) throw error
  return data
}

export async function createDoctorNote(input: {
  patientId: string
  doctorId: string
  text: string
}): Promise<DoctorNote> {
  const { data, error } = await supabase
    .from('doctor_note')
    .insert({
      pat_id: input.patientId,
      doc_id: input.doctorId,
      doctor_note_text: input.text,
    })
    .select()
    .single()

  if (error) throw error
  return data
}
