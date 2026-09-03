import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type ListRowProps = {
  /** The thing this row is about. Usually the strongest text in the row. */
  title: ReactNode
  /** Time, dosage, relative date — the detail under the title. */
  description?: ReactNode
  /** A `StatusBadge`, or any other statement of fact. */
  status?: ReactNode
  /** Controls. Keep to three; past that a row needs a detail screen. */
  actions?: ReactNode
  /** A full-width block under the row: an explanatory note, a nested list. */
  children?: ReactNode
  className?: string
}

/**
 * One row in a patient-facing list.
 *
 * This exists because the same shape — something, its detail, its status, and
 * what you can do about it — appears in doses, prescriptions, appointments,
 * journal entries and notifications, and every one of them had hand-rolled a
 * `flex flex-wrap items-center` that broke differently at 375px. Wrapping put
 * the buttons under the text but left-aligned against it, so the row read as
 * two unrelated things.
 *
 * On a phone it is a deliberate stack: text first, then status and actions on
 * their own line. From `sm` it becomes the single line it always wanted to be.
 * The breakpoint change is a layout change, not a content change — nothing is
 * hidden at either size, because a patient on a phone is not a patient who
 * needs less.
 */
export function ListRow({
  title,
  description,
  status,
  actions,
  children,
  className,
}: ListRowProps) {
  return (
    <li className={cn('px-4 py-4 sm:px-5', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <div className="font-medium text-heading">{title}</div>
          {description ? (
            <div className="mt-0.5 text-sm text-muted">{description}</div>
          ) : null}
        </div>

        {status || actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            {status}
            {actions}
          </div>
        ) : null}
      </div>

      {children ? <div className="mt-3">{children}</div> : null}
    </li>
  )
}

/**
 * The `<ul>` these belong in: hairline-separated, no outer chrome of its own
 * because it sits inside a card that already has some.
 */
export function ListRows({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <ul className={cn('divide-y divide-[var(--color-border)]', className)}>
      {children}
    </ul>
  )
}
