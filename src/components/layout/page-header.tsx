import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'

export type Breadcrumb = {
  label: string
  to?: string
}

export type PageHeaderProps = {
  title: string
  description?: string
  /**
   * Sits above the title: a status badge, a count, a date range. Facts
   * about what you are looking at, not controls.
   */
  meta?: ReactNode
  breadcrumbs?: Breadcrumb[]
  /** Controls on the trailing edge. */
  actions?: ReactNode
  /**
   * A summary panel that sits opposite the title on wide screens - an
   * adherence ring, a headline count. Falls below the title on narrow ones.
   */
  aside?: ReactNode
  className?: string
}

/**
 * The single page-title treatment for the whole application.
 *
 * Every screen renders exactly one `<h1>` through this component, which keeps
 * the heading hierarchy predictable for screen reader users navigating by
 * headings — and stops each page inventing its own title styling.
 *
 * RecoverEase 2.0: the title is set by size and weight alone - `title`
 * (30/36 semibold, Inter's display cut) against the 20px section heading - in
 * the heading colour. Brand blue is kept for what can be acted on, so a page
 * no longer opens with a blue word competing with its own primary button.
 *
 * There is no eyebrow. The small all-caps line above every title restated the
 * title ("YOUR MEDICATION" over "Medication") and pushed each page's content
 * down by a row; breadcrumbs and the navigation already say where you are.
 */
export function PageHeader({
  title,
  description,
  meta,
  breadcrumbs,
  actions,
  aside,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6 lg:mb-8', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-3">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {crumb.to && !isLast ? (
                    <Link
                      to={crumb.to}
                      // On a phone the breadcrumb is the way back out of a
                      // record, and as a bare inline link it was a 20px
                      // target. Full height there, inline from `sm` where a
                      // pointer makes 20px fine and the extra row does not
                      // earn its space.
                      className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] hover:text-brand-700 hover:underline sm:min-h-0"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={isLast ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  )}
                  {!isLast ? (
                    <ChevronRight
                      className="size-4 text-neutral-400"
                      aria-hidden="true"
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          {meta ? (
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {meta}
            </div>
          ) : null}

          <h1 className="text-headline-lg text-heading sm:text-title">
            {title}
          </h1>

          {description ? (
            <p className="mt-1.5 max-w-2xl text-body-md text-muted">
              {description}
            </p>
          ) : null}
        </div>

        {aside ? <div className="shrink-0">{aside}</div> : null}

        {actions ? (
          // Full width on a phone, so the actions take their own line instead
          // of holding their intrinsic width beside the title and squeezing
          // the description into a four-word column. Auto width from `sm`,
          // where there is room for both on one line.
          <div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  )
}
