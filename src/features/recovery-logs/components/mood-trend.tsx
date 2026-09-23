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

  // `recent` is oldest first, so the last entry is the latest rated day.
  const latest = recent[recent.length - 1]!
  const latestRating = latest.recovery_log_mood_rating ?? 1

  return (
    <figure>
      {/* The latest rating in words, on the page. Each column's value is
          otherwise only in its hover title - which a touch screen never
          shows - and in the table below, which only a screen reader reads.
          The same word and date the table gives for that day; nothing is
          worked out from it. */}
      <p className="mb-3 text-body">
        Most recent:{' '}
        <span className="font-semibold text-heading">
          {MOOD_WORDS[latestRating - 1]}
        </span>{' '}
        ({latestRating} of 5), {formatDate(latest.recovery_log_date)}
      </p>

      {/* The columns stretch to the row's full 96px (`items-stretch`, the
          flex default). With `items-end` they shrank to their content - an
          empty bar - so each bar's percentage height resolved against a
          zero-height column and every bar rendered at 0px: the chart showed
          nothing at all. Layout only; the ratings and their heights are
          unchanged. */}
      <div className="flex h-24 items-stretch gap-1" aria-hidden="true">
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

      {/* Every day's rating, for assistive technology: the columns are
          hidden from it. */}
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
