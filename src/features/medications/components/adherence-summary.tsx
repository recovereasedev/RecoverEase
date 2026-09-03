import { ProgressRing } from '@/components/ui/progress'
import type { Adherence } from '@/features/medications/api'
import { medicationLogStatus } from '@/lib/status'

/**
 * Modules 4.8 (patient) and 5.3 (doctor).
 *
 * The ring restates a number that is already written beside it in words; it is
 * never the only place the rate appears, and it carries the same value as its
 * accessible name. Below it are the four counts, unchanged — four numbers are
 * read faster as four numbers than as four slices, and a chart there would
 * stand between the reader and the count.
 *
 * When nothing has come due yet the percentage is withheld rather than shown
 * as 0%, which would read as total non-adherence from a patient who has
 * simply not reached their first dose.
 */
export function AdherenceSummary({ adherence }: { adherence: Adherence }) {
  const rows = [
    { key: 'taken' as const, count: adherence.taken },
    { key: 'missed' as const, count: adherence.missed },
    { key: 'skipped' as const, count: adherence.skipped },
    { key: 'pending' as const, count: adherence.pending },
  ].filter((row) => row.count > 0)

  if (adherence.resolved === 0 && adherence.pending === 0) {
    return (
      <p className="text-sm text-muted">
        No doses were scheduled in this period.
      </p>
    )
  }

  const doseWord = adherence.resolved === 1 ? 'dose' : 'doses'

  return (
    <div>
      {adherence.rate === null ? (
        <p className="text-sm text-muted">
          No doses have come due yet, so there is nothing to measure.
        </p>
      ) : (
        <div className="flex items-center gap-4">
          <ProgressRing
            value={adherence.rate}
            label="Doses taken this week"
            valueText={`${adherence.rate}% of ${adherence.resolved} ${doseWord} taken`}
            tone={adherence.rate >= 80 ? 'success' : 'warning'}
            size={64}
          >
            {adherence.rate}%
          </ProgressRing>

          <p className="min-w-0 text-sm text-muted">
            of{' '}
            <span className="font-medium text-heading" data-numeric>
              {adherence.resolved} {doseWord}
            </span>{' '}
            taken
          </p>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {rows.map((row) => {
          const status = medicationLogStatus[row.key]
          const Icon = status.icon

          return (
            <li key={row.key} className="flex items-center gap-2.5 text-sm">
              <Icon
                className="size-4 shrink-0 text-neutral-500"
                aria-hidden="true"
              />
              <span className="flex-1 text-body">{status.label}</span>
              <span className="font-medium text-heading" data-numeric>
                {row.count}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
