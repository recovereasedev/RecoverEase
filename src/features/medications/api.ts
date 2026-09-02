import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

export type Prescription = Tables<'prescription'>
export type MedicationSchedule = Tables<'medication_schedule'>
export type MedicationLog = Tables<'medication_log'>
export type MedicationLogStatus = Enums<'medication_log_status'>

export type ScheduleWithPrescription = MedicationSchedule & {
  prescription: Pick<
    Prescription,
    'prescription_id' | 'prescription_issued_date' | 'prescription_notes'
  > | null
}

export type DoseWithSchedule = MedicationLog & {
  medication_schedule: Pick<
    MedicationSchedule,
    'medication_schedule_id' | 'medication_schedule_name' | 'medication_schedule_dosage'
  > | null
}

/** Module 4.5 "View Medication Schedule". */
export async function fetchSchedules(
  patientId: string,
): Promise<ScheduleWithPrescription[]> {
  const { data, error } = await supabase
    .from('medication_schedule')
    .select(
      `*,
       prescription!inner (
         prescription_id,
         prescription_issued_date,
         prescription_notes,
         pat_id
       )`,
    )
    .eq('prescription.pat_id', patientId)
    .order('medication_schedule_start_date', { ascending: false })

  if (error) throw error
  return data as unknown as ScheduleWithPrescription[]
}

/**
 * Doses falling inside a window, newest first.
 *
 * One query joined through to the schedule rather than fetching schedules and
 * then a query per schedule: the N+1 version turns a patient with six
 * medications into seven round trips on every dashboard load.
 */
export async function fetchDoses(input: {
  patientId: string
  from: string
  to: string
}): Promise<DoseWithSchedule[]> {
  const { data, error } = await supabase
    .from('medication_log')
    .select(
      `*,
       medication_schedule!inner (
         medication_schedule_id,
         medication_schedule_name,
         medication_schedule_dosage,
         prescription!inner ( pat_id )
       )`,
    )
    .eq('medication_schedule.prescription.pat_id', input.patientId)
    .gte('medication_log_scheduled_at', input.from)
    .lte('medication_log_scheduled_at', input.to)
    .order('medication_log_scheduled_at', { ascending: true })

  if (error) throw error
  return data as unknown as DoseWithSchedule[]
}

/**
 * Module 4.6 "Mark Medication as Taken".
 *
 * `medication_log_taken_at` is deliberately not sent: a database trigger
 * stamps it from the server clock. Trusting a browser's clock for the time a
 * dose was taken would let a wrong device time corrupt the adherence record.
 */
export async function setDoseStatus(
  doseId: string,
  status: MedicationLogStatus,
): Promise<void> {
  const { error } = await supabase
    .from('medication_log')
    .update({ medication_log_status: status })
    .eq('medication_log_id', doseId)

  if (error) throw error
}

/** Module 4.3 "Create/Issue Prescription". */
export async function createPrescription(input: {
  patientId: string
  doctorId: string
  notes: string | null
}): Promise<Prescription> {
  const { data, error } = await supabase
    .from('prescription')
    .insert({
      pat_id: input.patientId,
      doc_id: input.doctorId,
      prescription_notes: input.notes,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Module 4.1 "Set Medication Schedule".
 *
 * Inserting the schedule is enough: a database trigger generates the
 * individual dose rows for the coming weeks, so the patient's checklist is
 * populated without a second client call that could fail halfway.
 */
export async function createMedicationSchedule(input: {
  prescriptionId: string
  name: string
  dosage: string
  times: string[]
  startDate: string
  endDate: string | null
}): Promise<MedicationSchedule> {
  const { data, error } = await supabase
    .from('medication_schedule')
    .insert({
      prescription_id: input.prescriptionId,
      medication_schedule_name: input.name,
      medication_schedule_dosage: input.dosage,
      medication_schedule_frequency: input.times.length,
      medication_schedule_times: input.times,
      medication_schedule_start_date: input.startDate,
      medication_schedule_end_date: input.endDate,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export type Adherence = {
  taken: number
  missed: number
  skipped: number
  pending: number
  /** Doses that have come due. Pending future doses are excluded. */
  resolved: number
  /** Percentage of resolved doses taken, or null when none are resolved. */
  rate: number | null
}

/**
 * Modules 4.8 (patient, weekly adherence) and 5.3 (doctor, track adherence).
 *
 * Doses still in the future are excluded from the denominator. Counting them
 * as failures would show a patient who has taken every dose so far an
 * adherence figure that falls as the prescription lengthens, which is both
 * wrong and discouraging.
 */
export function summariseAdherence(doses: MedicationLog[]): Adherence {
  const counts = { taken: 0, missed: 0, skipped: 0, pending: 0 }

  for (const dose of doses) {
    counts[dose.medication_log_status] += 1
  }

  const resolved = counts.taken + counts.missed + counts.skipped

  return {
    ...counts,
    resolved,
    rate: resolved === 0 ? null : Math.round((counts.taken / resolved) * 100),
  }
}
