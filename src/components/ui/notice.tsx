import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger'

const toneStyles: Record<
  NoticeTone,
  { container: string; tile: string; title: string; icon: LucideIcon }
> = {
  info: {
    container: 'border-info-200 bg-info-50',
    tile: 'bg-info-100 text-info-800',
    title: 'text-info-800',
    icon: Info,
  },
  success: {
    container: 'border-success-200 bg-success-50',
    tile: 'bg-success-100 text-success-800',
    title: 'text-success-800',
    icon: CheckCircle2,
  },
  warning: {
    container: 'border-warning-200 bg-warning-50',
    tile: 'bg-warning-100 text-warning-800',
    title: 'text-warning-800',
    icon: AlertTriangle,
  },
  danger: {
    container: 'border-danger-200 bg-danger-50',
    tile: 'bg-danger-100 text-danger-800',
    title: 'text-danger-800',
    icon: ShieldAlert,
  },
}

export type NoticeProps = {
  tone?: NoticeTone
  title?: ReactNode
  children: ReactNode
  /**
   * Overrides the tone's default glyph. The default for `danger` is a shield,
   * which reads as "you are blocked" - right for a permission failure, wrong
   * for a mistyped password. Pass the icon that matches what actually
   * happened; the tone still carries the colour.
   */
  icon?: LucideIcon
  /** A button or link on the trailing edge. */
  action?: ReactNode
  /**
   * Announce the notice when it appears.
   *
   * Leave it off for standing guidance that was on the page all along, which
   * would otherwise be read out on every visit for no reason. Use `polite`
   * for something that resolved in the background, and `assertive` - which
   * renders `role="alert"` - for the outcome of something the user just did,
   * such as a failed sign-in, where waiting for a pause in speech means the
   * person has already moved on.
   */
  live?: 'polite' | 'assertive'
  className?: string
}

/**
 * A banner carrying guidance, a safety note, or the outcome of an action.
 *
 * Tone drives colour, but the icon and the wording carry the meaning on their
 * own - the design system requires that status is never colour alone, and a
 * tinted rectangle is exactly the case where that is easiest to forget.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  icon,
  action,
  live,
  className,
}: NoticeProps) {
  const styles = toneStyles[tone]
  const Icon = icon ?? styles.icon

  return (
    <div
      // `alert` and `status` already imply their own politeness, so
      // `aria-live` is not set alongside them: doubling the two is a known
      // way to get a message announced twice.
      role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined}
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-[var(--radius-lg)] border p-3 sm:gap-4 sm:p-4',
        styles.container,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] sm:size-9',
          styles.tile,
        )}
      >
        <Icon className="size-4 sm:size-5" />
      </span>

      <div className="min-w-0 flex-1">
        {title ? (
          <p className={cn('font-semibold', styles.title)}>{title}</p>
        ) : null}
        <div className={cn('text-sm text-body', title && 'mt-0.5')}>
          {children}
        </div>
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
