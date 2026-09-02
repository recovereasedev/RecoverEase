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
  breadcrumbs?: Breadcrumb[]
  actions?: ReactNode
  className?: string
}

/**
 * The single page-title treatment for the whole application.
 *
 * Every screen renders exactly one `<h1>` through this component, which keeps
 * the heading hierarchy predictable for screen reader users navigating by
 * headings — and stops each page inventing its own title styling.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
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

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-heading sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted sm:text-base">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  )
}
