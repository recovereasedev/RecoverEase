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

export type StatItem = {
  /** What the number counts, in sentence case: "Upcoming appointments". */
  label: string
  /** The number itself. Kept as a node so a unit can be styled down. */
  value: ReactNode
  /** Sits beside the value at body size: "of 28 doses", "patients". */
  unit?: string
  trend?: StatTrend
  /** One short line under the number: "21 active". */
  detail?: ReactNode
}

const trendIcon: Record<StatTrend['direction'], LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
}

const trendClasses: Record<NonNullable<StatTrend['intent']>, string> = {
  positive: 'text-success-700',
  negative: 'text-danger-700',
  neutral: 'text-muted',
}

// Static class names, so Tailwind can see them. Two up on a phone; the whole
// row on one line once there is room for it.
const columns: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
}

/**
 * A row of measurements, as one band.
 *
 * RecoverEase 2.0 replaces the four separate stat cards - each with its own
 * border, icon tile, all-caps label and tinted footer strip - with a single
 * container divided by hairlines. Four cards read as four things competing for
 * attention; one band reads as one summary, which is what a row of related
 * counts is. The numbers carry the weight, the labels are plain sentence-case
 * text, and there is no decoration left to compete with either.
 *
 * Deliberately narrow in what it will show: a number, what it counts, and at
 * most one line of context. Not an action, a chart or a paragraph.
 */
export function StatBand({
  items,
  label,
  className,
}: {
  items: StatItem[]
  /** Names the group for assistive technology: "System totals". */
  label?: string
  className?: string
}) {
  const isOddOnPhone = items.length % 2 === 1 && items.length > 1

  return (
    <dl
      aria-label={label}
      className={cn(
        // The hairlines are the band's own background showing through a
        // one-pixel gap, so they stay continuous however the grid wraps.
        'grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-border)]',
        columns[Math.min(items.length, 4)] ?? columns[4],
        className,
      )}
    >
      {items.map((item, index) => {
        const TrendIcon = item.trend ? trendIcon[item.trend.direction] : null
        const isLast = index === items.length - 1
        return (
          <div
            key={item.label}
            className={cn(
              'flex min-w-0 flex-col bg-surface px-4 py-3.5 sm:px-5 sm:py-4',
              // An odd count on a phone would leave a hole showing the
              // hairline colour; the last item takes the full row instead.
              isOddOnPhone && isLast && 'max-sm:col-span-2',
            )}
          >
            <dt className="text-sm text-muted">{item.label}</dt>
            <dd className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
              <span
                className="text-headline-lg font-semibold text-heading"
                data-numeric
              >
                {item.value}
              </span>
              {item.unit ? (
                <span className="text-sm text-muted">{item.unit}</span>
              ) : null}
            </dd>
            {item.trend && TrendIcon ? (
              <dd
                className={cn(
                  'mt-0.5 flex items-center gap-1 text-sm font-medium',
                  trendClasses[item.trend.intent ?? 'neutral'],
                )}
              >
                <TrendIcon className="size-4 shrink-0" aria-hidden="true" />
                {item.trend.label}
              </dd>
            ) : null}
            {item.detail ? (
              <dd className="mt-0.5 text-sm text-muted">{item.detail}</dd>
            ) : null}
          </div>
        )
      })}
    </dl>
  )
}
