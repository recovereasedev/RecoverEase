import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The primary grouping container.
 *
 * Cards are separated by a border rather than a drop shadow. In a clinical
 * interface that shows many panels at once, shadows on everything read as
 * noise and stop signalling elevation; keeping shadow for genuinely floating
 * layers (menus, dialogs) preserves that meaning.
 */
export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface',
        className,
      )}
      {...props}
    />
  )
}

export type CardHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** Rendered on the trailing edge: a button, a link, a filter. */
  action?: ReactNode
  /** Heading level, so a card nested in a section keeps document order sane. */
  as?: 'h2' | 'h3' | 'h4'
  className?: string
}

export function CardHeader({
  title,
  description,
  action,
  as: Heading = 'h2',
  className,
}: CardHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-heading">
          {title}
        </Heading>
        {description ? (
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />
}

export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-5 py-4',
        className,
      )}
      {...props}
    />
  )
}
