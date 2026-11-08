import { formatDate, formatScheduleTime } from '@/lib/format'
import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

/**
 * Dose conflicts (migration 48): a dose occurrence the scheduler did not turn
 * into a dose, held for the patient's treating doctor - a time that does not
 * exist or happens twice on a clock-change day, or one whose moment is
 * already another dose of the same schedule after a clinic changes time zone.
 *
 * A conflict is never a dose. It gets no reminder, is never marked missed
 * and never counts as taken; adherence is worked out from doses alone and the
 * conflicts are shown beside it.
 *
 * PROVISIONAL: holding these for review, and every patient- and doctor-facing
 * sentence in this file, await the clinical adviser's approval
 * (docs/medication-clock-change-decisions.md, decisions A-K, all PENDING).
 * Nothing here tells anyone to take, skip or change a dose.
 */

export type MedicationConflict = Tables<'medication_dose_conflict'> & {
  medication_schedule: {
    medication_schedule_id: string
    medication_schedule_name: string
    medication_schedule_dosage: string
  } | null
}

export type ConflictReason = Enums<'medication_conflict_reason'>
export type DoctorResolution = 'rescheduled' | 'not_given_separately'

/** Every conflict of one patient's schedules, by date and time. RLS limits it to the patient and their treating doctor. */
export async function fetchConflicts(patientId: string): Promise<MedicationConflict[]> {
  const { data, error } = await supabase
    .from('medication_dose_conflict')
    .select(
      `*,
       medication_schedule!inner (
         medication_schedule_id,
         medication_schedule_name,
         medication_schedule_dosage,
         prescription!inner ( pat_id )
       )`,
    )
    .eq('medication_schedule.prescription.pat_id', patientId)
    .order('conflict_dose_date', { ascending: true })
    .order('conflict_dose_time', { ascending: true })

  if (error) throw error
  return data as unknown as MedicationConflict[]
}

/**
 * The treating doctor's decision. The database checks everything again: the
 * caller, a future moment on the same clinic-local date at no other dose's
 * moment, a reason, and that nobody decided first.
 */
export async function resolveConflict(input: {
  conflictId: string
  resolution: DoctorResolution
  scheduledAt: string | null
  note: string
}): Promise<void> {
  const { error } = await supabase.rpc('doctor_resolve_medication_conflict', {
    target_conflict_id: input.conflictId,
    resolution: input.resolution,
    new_scheduled_at: input.resolution === 'rescheduled' ? input.scheduledAt : null,
    resolution_note: input.note,
  })
  if (error) throw error
}

// --- What a conflict's state is --------------------------------------------

export type ConflictState =
  | 'awaiting_review'
  | 'not_scheduled_unresolved'
  | 'rescheduled'
  | 'not_given_separately'
  | 'course_ended'

/** Unresolved conflicts are awaiting review until their moment passes, then not scheduled. */
export function conflictState(conflict: MedicationConflict, now: number): ConflictState {
  switch (conflict.conflict_resolution) {
    case 'rescheduled':
      return 'rescheduled'
    case 'not_given_separately':
      return 'not_given_separately'
    case 'course_ended':
      return 'course_ended'
    default:
      return new Date(conflict.conflict_at).getTime() > now
        ? 'awaiting_review'
        : 'not_scheduled_unresolved'
  }
}

export type ConflictSummary = Record<ConflictState, number> & { total: number }

/**
 * The lines shown beside adherence. None of them is in the adherence figure,
 * which counts doses only; a rescheduled conflict's dose is an ordinary dose
 * and is counted there like any other.
 */
export function summariseConflicts(conflicts: MedicationConflict[], now: number): ConflictSummary {
  const summary: ConflictSummary = {
    awaiting_review: 0,
    not_scheduled_unresolved: 0,
    rescheduled: 0,
    not_given_separately: 0,
    course_ended: 0,
    total: conflicts.length,
  }
  for (const conflict of conflicts) summary[conflictState(conflict, now)] += 1
  return summary
}

// --- Wording (PROVISIONAL, decisions D and F) ------------------------------

export const CONFLICT_STATE_LABEL: Record<ConflictState, string> = {
  awaiting_review: 'Awaiting doctor review',
  not_scheduled_unresolved: 'Not scheduled: unresolved clock-change review',
  rescheduled: 'Rescheduled by the doctor',
  not_given_separately: 'Doctor decided: not given separately',
  course_ended: 'Course ended before review',
}

const medicineOf = (conflict: MedicationConflict) =>
  conflict.medication_schedule
    ? `${conflict.medication_schedule.medication_schedule_name} (${conflict.medication_schedule.medication_schedule_dosage})`
    : 'medicine'

/** What the patient reads: neutral, and never an instruction. */
export function patientConflictText(conflict: MedicationConflict, now: number): string {
  const when = `${formatDate(conflict.conflict_dose_date)} at ${formatScheduleTime(conflict.conflict_dose_time)}`
  switch (conflictState(conflict, now)) {
    case 'awaiting_review':
      return `Your ${medicineOf(conflict)} dose time on ${when} is awaiting your doctor's review because of a clock change.`
    case 'not_scheduled_unresolved':
      return `Your ${medicineOf(conflict)} dose time on ${when} was not scheduled: your doctor's review of the clock change was not completed.`
    case 'rescheduled':
      return `Your doctor reviewed your ${medicineOf(conflict)} dose time on ${when} and set a time for it. It is listed with your doses.`
    case 'not_given_separately':
      return `Your doctor reviewed your ${medicineOf(conflict)} dose time on ${when} and decided it is not given separately.`
    case 'course_ended':
      return `Your ${medicineOf(conflict)} dose time on ${when} was not scheduled: the course ended before it was reviewed.`
  }
}

/** Why the scheduler held it, for the doctor. */
export function conflictReasonText(conflict: MedicationConflict): string {
  const date = formatDate(conflict.conflict_dose_date)
  const time = formatScheduleTime(conflict.conflict_dose_time)
  switch (conflict.conflict_reason) {
    case 'nonexistent_local_time':
      return `${time} does not exist on ${date}: the clinic's clocks go forward over it.`
    case 'ambiguous_local_time':
      return `${time} happens twice on ${date}: the clinic's clocks go back over it.`
    case 'same_moment_collision':
      return `Another dose of this medicine is already due at the same moment, after the clinic's time zone changed.`
  }
}

/** The summary as one sentence, for the printed report. Empty when there is nothing to say. */
export function conflictSummarySentence(summary: ConflictSummary): string {
  if (summary.total === 0) return ''
  const order: ConflictState[] = [
    'awaiting_review',
    'not_scheduled_unresolved',
    'not_given_separately',
    'course_ended',
    'rescheduled',
  ]
  const parts = order
    .filter((state) => summary[state] > 0)
    .map((state) => `${CONFLICT_STATE_LABEL[state]}: ${summary[state]}`)
  return `Clock-change dose reviews in the same 7 days, not counted in that figure - ${parts.join('; ')}.`
}

// --- A clock time on a date, in a time zone --------------------------------

/** The `YYYY-MM-DD HH:MM` a moment shows in `zone`. */
function wallClock(moment: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(moment))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** The UTC offset `zone` uses at a moment, e.g. "GMT-04:00". */
export function offsetAt(moment: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(
    new Date(moment),
  )
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
}

/**
 * Every moment at which the clocks in `zone` read `time` on `date`: none on a
 * spring-forward day for a time the clocks jump over, two on a fall-back day
 * for a time they pass twice, one otherwise. Earliest first.
 *
 * Every offset in use today lies within 14 hours of UTC; the candidates are
 * checked every 15 minutes across that range, which covers every offset and
 * every clock change there is (30-minute and 2-hour ones included).
 */
export function momentsFor(date: string, time: string, zone: string): number[] {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  if ([y, m, d, hh, mm].some((n) => n === undefined || Number.isNaN(n))) return []
  const naive = Date.UTC(y!, m! - 1, d!, hh!, mm!)
  const wanted = `${date} ${time.slice(0, 5)}`
  const found = new Set<number>()
  for (let minutes = -15 * 60; minutes <= 15 * 60; minutes += 15) {
    const moment = naive - minutes * 60_000
    if (wallClock(moment, zone) === wanted) found.add(moment)
  }
  return [...found].sort((a, b) => a - b)
}
