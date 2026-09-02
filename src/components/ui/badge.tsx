import { cn } from '@/lib/utils'
import { toneClasses, type StatusDescriptor, type StatusTone } from '@/lib/status'

export type BadgeProps = {
  tone?: StatusTone
  className?: string | undefined
  children: React.ReactNode
}

export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-0.5 text-xs font-medium',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export type StatusBadgeProps = {
  status: StatusDescriptor
  /** Hide the text label, e.g. in a dense table. The label stays for screen
   *  readers, so the icon is never the only signal. */
  iconOnly?: boolean
  className?: string | undefined
}

/**
 * Renders a status as icon + label + colour together.
 *
 * All three are present deliberately: colour alone excludes colour-blind
 * users, and an icon alone is ambiguous. Even in `iconOnly` mode the label is
 * still exposed to assistive technology.
 */
export function StatusBadge({
  status,
  iconOnly = false,
  className,
}: StatusBadgeProps) {
  const Icon = status.icon

  return (
    <Badge tone={status.tone} className={className}>
      <Icon className="size-3.5" aria-hidden="true" />
      {iconOnly ? (
        <span className="sr-only">{status.label}</span>
      ) : (
        status.label
      )}
    </Badge>
  )
}
