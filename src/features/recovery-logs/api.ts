import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type RecoveryLog = Tables<'recovery_log'>

/**
 * Modules 5.10 "Maintain Recovery Journal" and 5.11 "View Recovery Trend
 * Charts" for the patient; 5.1 and 5.2 for their doctor.
 */
export async function fetchRecoveryLogs(
  patientId: string,
  limit = 90,
): Promise<RecoveryLog[]> {
  const { data, error } = await supabase
    .from('recovery_log')
    .select('*')
    .eq('pat_id', patientId)
    .order('recovery_log_date', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data
}

/**
 * Module 5.9 "Log Daily Recovery Progress".
 *
 * Upsert rather than insert: the database allows one entry per patient per
 * day, so re-submitting today's log is an edit, not an error the patient has
 * to understand and work around.
 */
export async function saveRecoveryLog(input: {
  patientId: string
  date: string
  notes: string | null
  moodRating: number | null
}): Promise<RecoveryLog> {
  const { data, error } = await supabase
    .from('recovery_log')
    .upsert(
      {
        pat_id: input.patientId,
        recovery_log_date: input.date,
        recovery_log_notes: input.notes,
        recovery_log_mood_rating: input.moodRating,
      },
      { onConflict: 'pat_id,recovery_log_date' },
    )
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Module 5.12 "View Recovery Streak": consecutive days logged, counting back
 * from today.
 *
 * A streak is computed rather than stored, so it can never drift out of sync
 * with the entries it describes. Yesterday counts as the anchor as well as
 * today, so the streak does not appear broken simply because the patient has
 * not opened the app yet this morning.
 */
export function calculateStreak(
  logs: Pick<RecoveryLog, 'recovery_log_date'>[],
  today = new Date(),
): number {
  if (logs.length === 0) return 0

  const dates = new Set(logs.map((log) => log.recovery_log_date))

  // Formatted from local date parts, not toISOString(). A patient in UTC+8
  // logging at 07:00 local is still on the previous UTC day, so an ISO key
  // would look up the wrong date and report a broken streak every morning.
  const toKey = (date: Date): string =>
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')

  const dayBefore = (date: Date): Date => {
    const previous = new Date(date)
    previous.setDate(previous.getDate() - 1)
    return previous
  }

  let cursor = new Date(today)
  if (!dates.has(toKey(cursor))) {
    cursor = dayBefore(cursor)
    if (!dates.has(toKey(cursor))) return 0
  }

  let streak = 0
  while (dates.has(toKey(cursor))) {
    streak += 1
    cursor = dayBefore(cursor)
  }

  return streak
}
