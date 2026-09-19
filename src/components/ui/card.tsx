import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The primary grouping container.
 *
 * The design system builds depth out of tonal layers rather than shadow: the
 * canvas is the floor, a white card sits on it behind a hairline border, and
 * shadow is spent only on things that genuinely float. In a clinical
 * interface showing many panels at once, a shadow on everything reads as
 * noise and stops meaning "raised" at all.
 *
 * `elevated` is the "lifted" state from the specification - the restrained
 * 0 4px 12px shadow - reserved for the one card on a screen that is asking
 * for an action right now.
 */
const cardVariants = cva('rounded-[var(--radius-lg)] bg-surface', {
  variants: {
    variant: {
      default: 'border border-[var(--color-border)]',
      elevated: 'border border-[var(--color-border)] shadow-[var(--shadow-md)]',
      /** A tinted well: nested groupings that must not look like a new card. */
      sunken: 'bg-surface-sunken',
      /** No chrome at all, for a card that only exists to own the radius. */
      plain: '',
    },
  },
  defaultVariants: { variant: 'default' },
})

export type CardProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof cardVariants>

export function Card({ className, variant, ...props }: CardProps) {
  return (
    <div className={cn(cardVariants({ variant }), className)} {...props} />
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

/**
 * RecoverEase 2.0: a card's title is text, not an icon tile plus text. The
 * 36px tinted tile sat on every card on every screen - forty-four of them -
 * so it marked nothing, and gave a one-line card a 70px header. Icons stay
 * where they carry meaning: statuses, navigation, and actions.
 */
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
        'flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-4 sm:px-5',
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
      {action ? <div className="ms-auto shrink-0">{action}</div> : null}
    </div>
  )
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 sm:p-5', className)} {...props} />
}

export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] bg-surface-sunken/60 px-4 py-4 sm:px-5',
        className,
      )}
      {...props}
    />
  )
}

export { cardVariants }
