import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type SectionHeadingProps = {
  title: string
  description?: ReactNode
  /** A trailing count, filter or link. */
  action?: ReactNode
  /** Kept explicit so a section nested inside a page cannot skip a level. */
  as?: 'h2' | 'h3'
  /** Lets a surrounding `<section>` name itself after this heading. */
  id?: string
  className?: string
}

/**
 * The heading that introduces a section of a page.
 *
 * RecoverEase 2.0 groups a page with space and a heading, not with a card per
 * group: the section rhythm (`--spacing-section`) is at least twice the gap
 * inside a group, so where one section ends is visible without a border. The
 * heading carries it - 20px semibold against a 30px page title and 16px body
 * - so it needs no icon tile to be found.
 */
export function SectionHeading({
  title,
  description,
  action,
  as: Heading = 'h2',
  id,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 sm:mb-4',
        className,
      )}
    >
      <div className="min-w-0">
        <Heading id={id} className="text-headline-md text-heading">
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

/**
 * A titled section of a page: a `<section>` named by its own heading, so it is
 * a landmark a screen reader user can jump to, with the heading above its
 * content and no container of its own. Put a `Card` inside only when the
 * content is one bounded object - a list of doses, a form.
 */
export function PageSection({
  title,
  description,
  action,
  as,
  className,
  children,
}: Omit<SectionHeadingProps, 'id' | 'className'> & {
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={className}>
      <SectionHeading
        id={headingId}
        title={title}
        description={description}
        action={action}
        {...(as ? { as } : {})}
      />
      {children}
    </section>
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
