import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react'

import { cn } from '@/lib/utils'

/**
 * The clinical table treatment, per the design system: no vertical borders,
 * 1px horizontal dividers, and a faintly tinted header row in small medium
 * text. Vertical rules turn a table into a grid of boxes; horizontal ones
 * alone let the eye travel along a row, which is how a record is actually
 * read.
 *
 * These are thin wrappers on real table elements rather than a data-grid
 * abstraction. Semantic `<table>` markup is what makes a table navigable by
 * assistive technology at all, and hiding it behind divs to gain styling
 * control trades that away for nothing.
 */

export type DataTableProps = HTMLAttributes<HTMLTableElement> & {
  /**
   * Describes the table for screen reader users. Required: an unlabelled
   * table in a page with several of them cannot be told apart in a list of
   * landmarks.
   */
  caption: string
  /** Show the caption on screen as well as to assistive technology. */
  captionVisible?: boolean
  /** Applied to the scroll container rather than the table. */
  containerClassName?: string
}

export function DataTable({
  caption,
  captionVisible = false,
  className,
  containerClassName,
  children,
  ...props
}: DataTableProps) {
  return (
    // A wide table scrolls inside its own container. Letting it push the page
    // wider instead is the classic small-screen failure, and the responsive
    // suite asserts the body never scrolls sideways.
    <div
      className={cn(
        'w-full overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface',
        containerClassName,
      )}
    >
      <table className={cn('w-full text-left text-sm', className)} {...props}>
        <caption
          className={cn(
            captionVisible
              ? 'px-5 py-3 text-left text-sm text-muted'
              : 'sr-only',
          )}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  )
}

export function THead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'bg-surface-sunken text-label-sm uppercase tracking-wider text-muted',
        className,
      )}
      {...props}
    />
  )
}

export function TBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn('divide-y divide-[var(--color-border)]', className)}
      {...props}
    />
  )
}

export function TR({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'transition-colors duration-[var(--duration-fast)] hover:bg-surface-sunken/60',
        className,
      )}
      {...props}
    />
  )
}

export function TH({
  className,
  scope = 'col',
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cn('px-5 py-3 font-semibold', className)}
      {...props}
    />
  )
}

export function TD({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-5 py-3.5 align-middle', className)} {...props} />
}
