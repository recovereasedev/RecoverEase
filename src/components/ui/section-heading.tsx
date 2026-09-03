import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type SectionHeadingProps = {
  title: string
  description?: string
  /**
   * Decorative tonal tile. The design system uses it to anchor a group of
   * cards so the eye can find where one clinical dataset ends and the next
   * begins. It is hidden from assistive technology; the heading is the label.
   */
  icon?: LucideIcon
  /** A trailing count, filter or link. */
  action?: ReactNode
  /** Kept explicit so a section nested inside a page cannot skip a level. */
  as?: 'h2' | 'h3'
  className?: string
}

/**
 * The heading that introduces a group of cards.
 *
 * This exists so that "a section of the page" has exactly one treatment
 * across all three roles, instead of every screen inventing its own
 * icon-plus-title arrangement.
 */
export function SectionHeading({
  title,
  description,
  icon: Icon,
  action,
  as: Heading = 'h2',
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-end justify-between gap-3',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon ? (
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-surface-raised text-brand-700"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0">
          <Heading className="text-headline-md text-heading">{title}</Heading>
          {description ? (
            <p className="mt-0.5 text-sm text-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/**
 * The small all-caps label that sits above a page or section title.
 *
 * Used sparingly and never for prose: capitals destroy word shape and slow
 * reading, which is the opposite of what a label is for.
 */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'text-label-sm font-semibold uppercase tracking-wider text-accent-700',
        className,
      )}
    >
      {children}
    </span>
  )
}
