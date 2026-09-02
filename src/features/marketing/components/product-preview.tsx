import { CalendarDays, CheckCircle2, Circle, Target } from 'lucide-react'

/**
 * An illustrative view of a patient's day, built from the real design system
 * components rather than a screenshot.
 *
 * It deliberately shows structure, not statistics: no invented adherence
 * percentages, no charts, no metrics. A landing page that displays fabricated
 * clinical numbers teaches visitors to read numbers that are not real, which
 * is a bad habit to build into a health product.
 */
export function ProductPreview() {
  return (
    <div
      // Decorative for assistive technology: everything it conveys is stated
      // in the surrounding prose.
      aria-hidden="true"
      className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-surface p-5 shadow-[var(--shadow-md)]"
    >
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-heading">Today</p>
        <p className="text-xs text-muted">Day 12 of recovery</p>
      </div>

      <div className="mt-4 space-y-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Medication
        </p>
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5">
          <CheckCircle2 className="size-5 shrink-0 text-success-700" />
          <span className="flex-1 text-sm text-heading">Morning dose</span>
          <span className="text-xs text-muted">8:00</span>
        </div>
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5">
          <Circle className="size-5 shrink-0 text-neutral-300" />
          <span className="flex-1 text-sm text-heading">Evening dose</span>
          <span className="text-xs text-muted">20:00</span>
        </div>
      </div>

      <div className="mt-5 space-y-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Coming up
        </p>
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2.5">
          <CalendarDays className="size-5 shrink-0 text-brand-600" />
          <span className="flex-1 text-sm text-heading">
            Follow-up consultation
          </span>
          <span className="text-xs text-muted">Thu</span>
        </div>
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2.5">
          <Target className="size-5 shrink-0 text-accent-600" />
          <span className="flex-1 text-sm text-heading">
            Walk 500 m unaided
          </span>
          <span className="text-xs text-muted">Goal</span>
        </div>
      </div>
    </div>
  )
}
