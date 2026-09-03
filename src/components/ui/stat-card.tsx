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
      <div className="flex flex-1 items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          {/* Tighter tracking on a phone, and `break-words` as a last
              resort. In a two-up grid at 375px the card is about 172px wide,
              and a single long word - "APPOINTMENTS" - has nowhere to wrap. */}
          <p className="text-label-sm font-semibold uppercase tracking-wide text-muted break-words sm:tracking-wider">
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
          // Hidden on the narrowest screens. The tile is decoration - it is
          // already `aria-hidden` - and beside a 172px card it was taking 52px
          // from the label, which is what forced "APPOINTMENTS" to break
          // mid-word. Decoration yields to legibility.
          <span
            aria-hidden="true"
            className="hidden size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-surface-raised text-brand-700 sm:flex"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
      </div>

      {footer ? (
        <div className="border-t border-[var(--color-border)] bg-surface-sunken px-4 py-3 text-sm text-muted sm:px-5">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
