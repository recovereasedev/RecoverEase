import { cn } from '@/lib/utils'

type Tone = 'brand' | 'accent' | 'success' | 'warning' | 'danger'

const barTone: Record<Tone, string> = {
  brand: 'bg-brand-600',
  accent: 'bg-accent-600',
  success: 'bg-success-600',
  warning: 'bg-warning-600',
  danger: 'bg-danger-600',
}

const ringTone: Record<Tone, string> = {
  brand: 'text-brand-600',
  accent: 'text-accent-600',
  success: 'text-success-600',
  warning: 'text-warning-600',
  danger: 'text-danger-600',
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export type ProgressBarProps = {
  /** 0-100. Values outside the range are clamped rather than overflowing. */
  value: number
  /**
   * What the bar is measuring, e.g. "Goals achieved". Required, because a
   * bar with no accessible name is an unlabelled decoration to anyone not
   * looking at it.
   */
  label: string
  /**
   * Overrides the announced value. Pass the real quantity - "27 of 28 doses"
   * reads far better than "96 percent" when the underlying count is what the
   * patient actually cares about.
   */
  valueText?: string
  tone?: Tone
  className?: string
}

/**
 * A horizontal progress track.
 *
 * The bar is always a repetition of something already written in text
 * nearby, never the only place a number appears: a length is not readable to
 * a screen reader user and is hard to judge precisely for anyone.
 */
export function ProgressBar({
  value,
  label,
  valueText,
  tone = 'brand',
  className,
}: ProgressBarProps) {
  const percentage = clampPercentage(value)

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percentage)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText ?? `${Math.round(percentage)}%`}
      className={cn(
        'h-2 w-full overflow-hidden rounded-full bg-neutral-200',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-[var(--duration-base)]',
          barTone[tone],
        )}
        style={{ width: `${percentage}%` }}
      />
    </div>
  )
}

export type ProgressRingProps = {
  value: number
  label: string
  valueText?: string
  tone?: Tone
  /** Diameter in pixels. */
  size?: number
  /** Rendered in the middle of the ring. Usually the percentage. */
  children?: React.ReactNode
  className?: string
}

/**
 * The circular variant, used where a single headline rate needs to read as a
 * summary rather than as a row in a list - adherence, for instance.
 *
 * Drawn with a stroke-dasharray rather than an image so it scales, respects
 * the user's zoom, and carries no download cost.
 */
export function ProgressRing({
  value,
  label,
  valueText,
  tone = 'brand',
  size = 48,
  children,
  className,
}: ProgressRingProps) {
  const percentage = clampPercentage(value)
  // r = 15.9155 gives a circumference of almost exactly 100, so the dash
  // array can be written directly in percent with no arithmetic.
  const circumference = 100

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percentage)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText ?? `${Math.round(percentage)}%`}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden="true">
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.5"
          className="stroke-neutral-200"
        />
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${percentage} ${circumference - percentage}`}
          className={cn('stroke-current', ringTone[tone])}
        />
      </svg>
      {children ? (
        <span
          aria-hidden="true"
          className="absolute text-xs font-semibold text-heading"
          data-numeric
        >
          {children}
        </span>
      ) : null}
    </div>
  )
}
