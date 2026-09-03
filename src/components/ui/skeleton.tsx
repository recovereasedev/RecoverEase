import { cn } from '@/lib/utils'

/**
 * A placeholder block shown while real content loads.
 *
 * Two rules govern every use of this component:
 *
 * 1. It must occupy the same space the real content will, or the page jumps
 *    when data arrives - the cumulative layout shift the UX guidelines treat
 *    as a defect rather than a cosmetic issue.
 * 2. It is `aria-hidden`. A screen reader user gains nothing from hearing a
 *    grey rectangle described; they need the single "Loading…" status message
 *    that `SkeletonGroup` provides, and then the content.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-[var(--radius-sm)] bg-neutral-200',
        className,
      )}
    />
  )
}

export type SkeletonGroupProps = {
  /** Announced once, in place of describing every block. */
  label?: string
  children: React.ReactNode
  className?: string
}

/**
 * Wraps a set of skeletons and speaks for all of them at once.
 */
export function SkeletonGroup({
  label = 'Loading…',
  children,
  className,
}: SkeletonGroupProps) {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** Several lines of body text, the last one short like a real paragraph. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-4', index === lines - 1 && 'w-2/3')}
        />
      ))}
    </div>
  )
}

/** The shape of a list row: leading block, two lines, trailing pill. */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 px-5 py-3.5', className)}>
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
    </div>
  )
}
