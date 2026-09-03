import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type StatTrend = {
  /** "up" is not automatically good - see `intent`. */
  direction: 'up' | 'down' | 'flat'
  /** The change, already formatted: "+2 this week", "-12%". */
  label: string
  /**
   * How to read the direction. Missed doses going up is bad; adherence going
   * up is good. Colour follows intent, never the arrow, and the arrow plus
   * the written label mean the meaning survives without colour at all.
   */
  intent?: 'positive' | 'negative' | 'neutral'
}

export type StatCardProps = {
  /** The all-caps label above the number. */
  label: string
  /** The number itself. Kept as a node so a unit can be styled down. */
  value: ReactNode
  /** Sits beside the value at body size: "of 28 doses", "patients". */
  unit?: string
  icon?: LucideIcon
  trend?: StatTrend
  /** A sentence along the bottom edge, on its own tonal strip. */
  footer?: ReactNode
  className?: string
}

const trendIcon: Record<StatTrend['direction'], LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
}

const trendClasses: Record<
  NonNullable<StatTrend['intent']>,
  string
> = {
  positive: 'text-success-700',
  negative: 'text-danger-700',
  neutral: 'text-muted',
}

/**
 * A single measurement, presented as one card in a bento row.
 *
 * Deliberately narrow in what it will show. A stat card answers "what is this
 * number, and is it moving the right way" - it is not a place to put an
 * action, a chart or a paragraph, because a row of four cards that each do
 * something different stops being scannable, which was the only reason to use
 * cards instead of a list.
 */
export function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  trend,
  footer,
  className,
}: StatCardProps) {
  const TrendIcon = trend ? trendIcon[trend.direction] : null

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface',
        className,
      )}
    >
      <div className="flex flex-1 items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <p className="text-label-sm font-semibold uppercase tracking-wider text-muted">
            {label}
          </p>
          <p className="mt-2 flex flex-wrap items-baseline gap-1.5">
            <span
              className="text-headline-lg font-bold text-heading"
              data-numeric
            >
              {value}
            </span>
            {unit ? (
              <span className="text-sm font-medium text-muted">{unit}</span>
            ) : null}
          </p>
          {trend && TrendIcon ? (
            <p
              className={cn(
                'mt-1 flex items-center gap-1 text-sm font-medium',
                trendClasses[trend.intent ?? 'neutral'],
              )}
            >
              <TrendIcon className="size-4 shrink-0" aria-hidden="true" />
              {trend.label}
            </p>
          ) : null}
        </div>

        {Icon ? (
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-surface-raised text-brand-700"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
      </div>

      {footer ? (
        <div className="border-t border-[var(--color-border)] bg-surface-sunken px-5 py-3 text-sm text-muted">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
