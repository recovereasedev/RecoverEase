import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Eyebrow } from '@/components/ui/section-heading'
import { cn } from '@/lib/utils'

export type Breadcrumb = {
  label: string
  to?: string
}

export type PageHeaderProps = {
  title: string
  description?: string
  /** The small all-caps label above the title. */
  eyebrow?: string
  /**
   * Sits beside the eyebrow: a status badge, a count, a date range. Facts
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
 * The title is set in brand blue rather than the standard heading colour.
 * That is the design system's device for separating "the name of this page"
 * from "the name of a section within it", and it is why section headings can
 * stay at a smaller size without the page losing its structure.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
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
                      className="rounded-[var(--radius-sm)] hover:text-brand-700 hover:underline"
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
          {eyebrow || meta ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
              {meta}
            </div>
          ) : null}

          <h1 className="text-headline-lg text-brand-800 sm:text-headline-xl">
            {title}
          </h1>

          {description ? (
            <p className="mt-2 max-w-2xl text-body-md text-muted">
              {description}
            </p>
          ) : null}
        </div>

        {aside ? <div className="shrink-0">{aside}</div> : null}

        {actions ? (
          <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  )
}
