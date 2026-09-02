import type { Adherence } from '@/features/medications/api'
import { medicationLogStatus } from '@/lib/status'

/**
 * Modules 4.8 (patient) and 5.3 (doctor).
 *
 * Deliberately not a doughnut chart. Four numbers and a percentage are read
 * faster as four numbers, and a chart here would be decoration standing
 * between the reader and the count.
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

  return (
    <div>
      {adherence.rate === null ? (
        <p className="text-sm text-muted">
          No doses have come due yet, so there is nothing to measure.
        </p>
      ) : (
        <>
          <p className="text-3xl font-semibold text-heading" data-numeric>
            {adherence.rate}%
          </p>
          <p className="text-sm text-muted">
            of{' '}
            <span data-numeric>
              {adherence.resolved} {adherence.resolved === 1 ? 'dose' : 'doses'}
            </span>{' '}
            taken
          </p>
        </>
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
