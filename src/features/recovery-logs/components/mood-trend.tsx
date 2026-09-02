import type { RecoveryLog } from '@/features/recovery-logs/api'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

const MOOD_WORDS = ['very poor', 'poor', 'okay', 'good', 'very good'] as const

/**
 * Module 5.11 "View Recovery Trend Charts".
 *
 * A column per day over the last fortnight, height set by that day's rating.
 * It is not a line chart: with at most fourteen points on a scale of five, a
 * line implies a precision and a continuity the data does not have — a
 * patient does not glide from "okay" to "good" over the course of a night.
 *
 * The whole thing is also written out as a table for screen readers, so the
 * trend is available without seeing the columns.
 */
export function MoodTrend({ logs }: { logs: RecoveryLog[] }) {
  const recent = [...logs]
    .filter((log) => log.recovery_log_mood_rating !== null)
    .sort((a, b) => a.recovery_log_date.localeCompare(b.recovery_log_date))
    .slice(-14)

  if (recent.length === 0) {
    return (
      <p className="text-sm text-muted">
        Rate a few days and your trend will appear here.
      </p>
    )
  }

  return (
    <figure>
      <div className="flex h-24 items-end gap-1" aria-hidden="true">
        {recent.map((log) => {
          const rating = log.recovery_log_mood_rating ?? 0
          return (
            <div
              key={log.recovery_log_id}
              className="flex flex-1 flex-col justify-end"
              title={`${formatDate(log.recovery_log_date)}: ${MOOD_WORDS[rating - 1]}`}
            >
              <div
                className={cn(
                  'w-full rounded-t-[3px]',
                  rating >= 4
                    ? 'bg-success-600'
                    : rating === 3
                      ? 'bg-brand-500'
                      : 'bg-warning-600',
                )}
                style={{ height: `${(rating / 5) * 100}%` }}
              />
            </div>
          )
        })}
      </div>

      <figcaption className="mt-2 text-xs text-muted">
        Last {recent.length} rated {recent.length === 1 ? 'day' : 'days'}
      </figcaption>

      {/* The same data, readable by assistive technology and by anyone who
          cannot distinguish the bar colours. */}
      <table className="sr-only">
        <caption>Recovery rating by day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">How you felt</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((log) => (
            <tr key={log.recovery_log_id}>
              <th scope="row">{formatDate(log.recovery_log_date)}</th>
              <td>{MOOD_WORDS[(log.recovery_log_mood_rating ?? 1) - 1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
