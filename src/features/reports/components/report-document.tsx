import type { ReactNode } from 'react'

import { BrandMark } from '@/components/layout/brand'
import { toneClasses, type StatusDescriptor } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The printed report's page furniture: the sheet, its letterhead, section
 * headings, tables, empty states and footer.
 *
 * Laid out after the approved Stitch report design, in the app's own tokens.
 * Everything here is presentation; what goes on the page comes from real
 * records and is assembled in `patient-report.tsx`.
 *
 * Nothing inside a sheet is interactive. The print button and the version
 * switch live outside it (`report-preview.tsx`), so what is on the screen is
 * exactly what is on the paper.
 */

export type ReportDensity = 'comfortable' | 'compact'

/**
 * An A4 sheet on screen; the page itself in print.
 *
 * `report-sheet` puts it on the `report` named page (see `src/index.css`),
 * which carries the A4 size, the margins and the page numbers, and asks the
 * browser to print its tinted panels rather than dropping them.
 */
export function ReportSheet({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <article
      data-report-document
      aria-label={label}
      className="report-sheet mx-auto w-full max-w-[210mm] rounded-[var(--radius-xs)] bg-white p-5 text-[12px] leading-[1.5] text-body shadow-[var(--shadow-md)] sm:p-[12mm] print:max-w-none print:rounded-none print:p-0! print:shadow-none"
    >
      {children}
    </article>
  )
}

export function ReportLetterhead({
  title,
  subtitle,
  meta,
}: {
  title: string
  subtitle: string
  meta: ReactNode
}) {
  return (
    <header className="break-inside-avoid">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:flex-row print:items-center print:justify-between">
        <div className="flex items-center gap-3">
          <BrandMark className="size-10" />
          <div className="leading-tight">
            <p className="text-[20px] font-bold tracking-tight text-brand-800">
              RecoverEase
            </p>
            <p className="text-[8.5px] font-semibold uppercase tracking-[0.14em] text-accent-700">
              Recovery management
            </p>
          </div>
        </div>
        <div className="sm:text-center print:text-center">
          <h2 className="text-[20px] font-bold uppercase leading-tight tracking-tight text-brand-800">
            {title}
          </h2>
          <p className="text-[8.5px] uppercase tracking-wider text-muted">
            {subtitle}
          </p>
        </div>
        <div className="space-y-0.5 text-[11px] sm:text-right print:text-right">
          {meta}
        </div>
      </div>
      <div aria-hidden="true" className="mt-3 h-[2px] w-full bg-brand-800" />
    </header>
  )
}

export function ReportSection({
  number,
  title,
  aside,
  children,
}: {
  number: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    // Tighter on paper than on screen: an empty record — the one most likely
    // to be printed at a first consultation — then fits on a single sheet
    // instead of spilling its footer onto a second.
    <section className="mt-6 print:mt-3.5">
      {/* Kept with what follows it: a heading alone at the foot of a page
          reads as a section with nothing in it. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 break-after-avoid">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="rounded-[var(--radius-xs)] bg-brand-800 px-1.5 py-0.5 text-[9.5px] font-semibold leading-3 text-white"
            data-numeric
          >
            {number}
          </span>
          <h3 className="text-[14px] font-semibold leading-5 text-brand-800">
            {title}
          </h3>
        </div>
        {aside ? (
          <p className="text-[8.5px] font-medium uppercase tracking-wider text-muted">
            {aside}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** Labelled facts about the patient, in as many columns as fit. */
export function ReportFacts({
  items,
}: {
  items: { label: string; value: ReactNode }[]
}) {
  return (
    <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] print:mt-3 gap-x-4 gap-y-3 break-inside-avoid rounded-[var(--radius-xs)] bg-surface-sunken p-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[8.5px] font-semibold uppercase tracking-wider text-muted">
            {item.label}
          </dt>
          <dd className="mt-0.5 text-[12px] font-semibold leading-4 text-heading [overflow-wrap:anywhere]">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export type ReportStatItem = {
  label: string
  value: string
  note: string
  /**
   * 0-100. Only for a share the records actually hold — goals marked
   * achieved out of goals set — never a decorative bar.
   */
  share?: number | null
}

export function ReportStats({ items }: { items: ReportStatItem[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 break-inside-avoid sm:grid-cols-5 print:grid-cols-5">
      {items.map((item) => (
        <li
          key={item.label}
          className="flex flex-col justify-between rounded-[var(--radius-xs)] bg-surface-raised p-2.5"
        >
          <p className="text-[8.5px] font-semibold uppercase leading-3 tracking-wider text-body">
            {item.label}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1">
            <span
              className="text-[18px] font-bold leading-none text-brand-800"
              data-numeric
            >
              {item.value}
            </span>
            <span className="text-[8.5px] text-muted">{item.note}</span>
          </p>
          {typeof item.share === 'number' ? (
            <span
              aria-hidden="true"
              className="mt-2 block h-1 overflow-hidden rounded-full bg-white"
            >
              <span
                className="block h-full bg-accent-600"
                style={{ width: `${item.share}%` }}
              />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export type ReportColumn = { label: string; className?: string }

/**
 * A data table that fits A4 portrait.
 *
 * On a narrow screen it scrolls inside its own box rather than widening the
 * page; on paper it takes the page width and wraps. The header row is a
 * `thead`, which browsers repeat at the top of every printed page a long
 * table runs onto.
 */
export function ReportTable({
  caption,
  columns,
  density = 'compact',
  children,
}: {
  caption: string
  columns: ReportColumn[]
  density?: ReportDensity
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-xs)] border border-neutral-200 print:overflow-visible">
      <table className="w-full min-w-[32rem] border-collapse text-left print:min-w-0">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-surface-raised text-heading">
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={cn(
                  'px-2.5 py-1.5 font-semibold uppercase leading-3 tracking-[0.06em]',
                  density === 'compact' ? 'text-[9.5px]' : 'text-[10px]',
                  column.className,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          className={cn(
            'divide-y divide-neutral-200 align-top',
            density === 'compact'
              ? 'text-[10.5px] leading-[14px]'
              : 'text-[12px] leading-[18px]',
          )}
        >
          {children}
        </tbody>
      </table>
    </div>
  )
}

/** A row is never split across two pages. */
export function ReportRow({ children }: { children: ReactNode }) {
  return <tr className="break-inside-avoid even:bg-surface-sunken">{children}</tr>
}

export function ReportCell({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <td className={cn('px-2.5 py-1.5 [overflow-wrap:anywhere]', className)}>
      {children}
    </td>
  )
}

/**
 * A section with nothing in it, said plainly — never a blank box or a
 * missing heading, which on paper look like a printing fault.
 */
export function ReportEmpty({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="break-inside-avoid rounded-[var(--radius-xs)] border border-dashed border-neutral-300 bg-surface-sunken px-3.5 py-3 print:py-2">
      <p className="text-[12px] font-semibold text-heading">{title}</p>
      {children ? (
        <p className="mt-0.5 text-[11px] leading-4 text-body">{children}</p>
      ) : null}
    </div>
  )
}

/** A status as a labelled chip: the word carries it, not the colour. */
export function ReportStatus({ status }: { status: StatusDescriptor }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase leading-3 tracking-[0.03em]',
        toneClasses[status.tone],
      )}
    >
      {status.label}
    </span>
  )
}

export function ReportFooter({ generated }: { generated: string }) {
  return (
    <footer className="mt-8 break-inside-avoid print:mt-6">
      <p className="text-center text-[8.5px] italic leading-3 text-muted">
        This report reflects information recorded in RecoverEase and is
        intended for care and recovery-management reference. It is not a
        medical diagnosis or a substitute for professional medical advice.
      </p>
      <div aria-hidden="true" className="mt-2 h-px w-full bg-neutral-200" />
      <div className="mt-2 flex flex-col gap-1 text-[8.5px] uppercase tracking-wider text-muted sm:flex-row sm:items-center sm:justify-between print:flex-row print:justify-between">
        <p>
          <span className="font-semibold text-brand-800">RecoverEase</span> ·
          Confidential health record
        </p>
        <p data-numeric>Generated {generated}</p>
      </div>
    </footer>
  )
}
