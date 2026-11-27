import { cn } from '@/lib/utils'

export type BarListItem = {
  key: string
  label: string
  value: number
  /** The value as written beside the bar: "3 clinics", "₱999.00". */
  valueLabel: string
}

/**
 * A plain horizontal bar chart: one row per item, its label and its value
 * written out, and a bar whose length is the value's share of the largest.
 *
 * The bars are decoration on top of a list that already says everything,
 * so they are hidden from assistive technology and nothing is read from
 * colour alone. No chart library, and nothing that needs a canvas.
 */
export function BarList({
  items,
  label,
  className,
}: {
  items: BarListItem[]
  /** Names the chart for assistive technology. */
  label: string
  className?: string
}) {
  const max = Math.max(0, ...items.map((item) => item.value))

  return (
    <ul aria-label={label} className={cn('space-y-3', className)}>
      {items.map((item) => {
        const share = max > 0 ? Math.max(item.value > 0 ? 2 : 0, (item.value / max) * 100) : 0
        return (
          <li key={item.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-body">{item.label}</span>
              <span className="shrink-0 font-semibold text-heading" data-numeric>
                {item.valueLabel}
              </span>
            </div>
            <div
              aria-hidden="true"
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-200"
            >
              <div
                className="h-full rounded-full bg-brand-600"
                style={{ width: `${share}%` }}
                data-bar
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
