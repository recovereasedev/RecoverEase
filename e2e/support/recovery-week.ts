import { IDS } from './fixtures'

/**
 * A week of Alice's recovery, for the recovery progress panel: passed to
 * `signInAs` as overrides, so the shared dataset stays as every other spec
 * expects it. Days ago, local time:
 *
 *   6: rated 3, her dose taken           -> (50 + 100) / 2  = 75%
 *   5: rated 4, her dose missed          -> (75 + 0) / 2    = 37.5%
 *   4: one dose taken, one skipped       ->                    50%
 *   3: rated 5                           ->                   100%
 *   1: rated 4, her dose taken           -> (75 + 100) / 2  = 87.5%
 *   2 and today: nothing recorded        -> left blank
 *
 * Five of seven days have records, and they average 70%. Nothing is dated
 * today, so the day's own checklist and reminders are untouched.
 */

function dayKey(daysAgo: number): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function at(daysAgo: number, hour: number): string {
  const when = new Date()
  when.setDate(when.getDate() - daysAgo)
  when.setHours(hour, 0, 0, 0)
  return when.toISOString()
}

function entry(daysAgo: number, rating: number) {
  return {
    recovery_log_id: `progress-log-${daysAgo}`,
    pat_id: IDS.alicePat,
    recovery_log_date: dayKey(daysAgo),
    recovery_log_notes: null,
    recovery_log_mood_rating: rating,
    recovery_log_created_at: at(daysAgo, 9),
  }
}

function dose(daysAgo: number, hour: number, status: 'taken' | 'missed' | 'skipped') {
  return {
    medication_log_id: `progress-dose-${daysAgo}-${hour}`,
    medication_schedule_id: IDS.scheduleA,
    medication_log_scheduled_at: at(daysAgo, hour),
    medication_log_taken_at: status === 'taken' ? at(daysAgo, hour) : null,
    medication_log_status: status,
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: null,
    medication_schedule: {
      medication_schedule_id: IDS.scheduleA,
      medication_schedule_name: 'Paracetamol',
      medication_schedule_dosage: '500mg',
      prescription: { pat_id: IDS.alicePat },
    },
  }
}

export const RECOVERY_WEEK = {
  recovery_log: [entry(6, 3), entry(5, 4), entry(3, 5), entry(1, 4)],
  medication_log: [
    dose(6, 8, 'taken'),
    dose(5, 8, 'missed'),
    dose(4, 8, 'taken'),
    dose(4, 20, 'skipped'),
    dose(1, 8, 'taken'),
  ],
}
