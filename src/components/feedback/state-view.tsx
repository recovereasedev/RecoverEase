import {
  AlertTriangle,
  Loader2,
  Lock,
  SearchX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The seven states every data-backed screen has to handle.
 *
 * The failure this component exists to prevent is the most common one in
 * data-driven UIs: rendering an "empty" message while a request is still in
 * flight, so the user is told there is nothing there when in fact nothing has
 * arrived yet. `StateView` makes that impossible by resolving the states in a
 * fixed order — pending, then error, then empty, then content.
 */

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('size-5 animate-spin text-brand-600', className)}
      aria-hidden="true"
    />
  )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    // aria-live so the wait is announced, aria-busy so it is understood as
    // in-progress rather than as final content.
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <Spinner className="size-6" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  )
}

/**
 * The line that says a form's save went through.
 *
 * One component rather than one per form, because the detail that makes it
 * work is easy to lose: the region is always in the document and only its
 * text changes. A status region that mounts with its words already in it is
 * announced inconsistently, and saving a second time was silent.
 *
 * `at` is the moment the save was sent - a mutation's `submittedAt` does
 * nicely. It keys the text, so the same message saved twice is a new element
 * both to React and to the reader: it settles in again rather than sitting
 * there unchanged, which is the only signal that anything happened.
 */
export function SavedNotice({
  at,
  children,
  className,
}: {
  at?: number
  children?: ReactNode
  className?: string
}) {
  return (
    <p
      role="status"
      className={cn(
        'text-sm font-medium text-success-700 empty:hidden',
        className,
      )}
    >
      {/* Settles in from its leading edge: the line sits beside the Save
          button, and scaling it from its centre made that edge drift. */}
      {children ? (
        <span key={at} className="motion-confirm inline-block origin-left">
          {children}
        </span>
      ) : null}
    </p>
  )
}

export type EmptyStateProps = {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon = SearchX,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {/* A glyph, not a glyph in a circle: the tinted tile was the pattern
          RecoverEase 2.0 took off cards, sections, notices and
          notifications, and an empty screen is the last place that needs
          decoration. */}
      <Icon className="mb-1 size-6 text-neutral-500" aria-hidden="true" />
      {/* A message, not a heading. It is what an empty panel says, and it
          introduces no section of its own; as an `<h3>` it sat directly under
          a page's `<h1>` wherever the panel had no heading - notifications,
          the patient and doctor lists, the audit log - and put a hole in the
          outline that heading navigation reads. */}
      <p className="text-base font-semibold text-heading">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

/**
 * The compact empty state (RecoverEase 2.0): one quiet line inside the
 * section it belongs to, instead of a 200px panel with a glyph in a circle
 * announcing that a list is empty. Use `EmptyState` only where the empty
 * screen is the whole page, and the next step needs explaining.
 */
export function InlineEmpty({
  icon: Icon,
  children,
  action,
  className,
}: {
  icon?: LucideIcon
  children: ReactNode
  /** A link or button that fills the empty list: "Book a follow-up". */
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-4 text-sm text-muted sm:px-5',
        className,
      )}
    >
      <p className="flex min-w-0 flex-1 items-start gap-2">
        {Icon ? (
          <Icon
            className="mt-0.5 size-4 shrink-0 text-neutral-500"
            aria-hidden="true"
          />
        ) : null}
        <span>{children}</span>
      </p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/**
 * Turns an unknown thrown value into something a person can act on.
 *
 * Raw Postgres and PostgREST messages are not user-facing copy: "new row
 * violates row-level security policy" tells a patient nothing. The known
 * cases are translated; anything unrecognised gets a generic message, and the
 * technical detail is kept available for support rather than shown by default.
 */
export type ErrorKind = 'network' | 'permission' | 'unknown'

/**
 * The message carried by a thrown value, whatever shape it arrived in.
 *
 * Not every failure is an Error. PostgREST is the one that catches people
 * out: it only constructs a `PostgrestError` when `.throwOnError()` is used,
 * so code that reads `{ data, error }` and throws `error` is throwing the
 * parsed response body — a plain object with `code`, `details`, `hint` and
 * `message`. Supabase Auth and the Edge Functions reject with objects too.
 *
 * Reading only `Error` instances silently turns all of those into no message
 * at all, which is how a translated refusal becomes "something went wrong".
 * This is shared rather than repeated because it has now been got wrong twice
 * in two different classifiers, and the second one shipped.
 *
 * Returns an empty string when there is no message to read, so each caller
 * chooses its own fallback.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return ''
}

export function describeError(error: unknown): {
  icon: LucideIcon
  title: string
  description: string
  detail?: string
  kind: ErrorKind
} {
  const raw = errorMessage(error) || 'Unknown error'

  const lowered = raw.toLowerCase()

  if (
    lowered.includes('failed to fetch') ||
    lowered.includes('networkerror') ||
    lowered.includes('network request failed')
  ) {
    return {
      icon: WifiOff,
      title: 'No connection',
      description:
        'We could not reach RecoverEase. Check your internet connection and try again.',
      detail: raw,
      kind: 'network',
    }
  }

  if (
    lowered.includes('row-level security') ||
    lowered.includes('insufficient_privilege') ||
    lowered.includes('permission denied') ||
    lowered.includes('jwt')
  ) {
    return {
      icon: Lock,
      title: 'You do not have access to this',
      description:
        'Your account is not permitted to view or change this information. If you believe this is a mistake, contact your care team.',
      detail: raw,
      kind: 'permission',
    }
  }

  return {
    icon: AlertTriangle,
    title: 'Something went wrong',
    description:
      'We could not load this information. Trying again usually helps.',
    detail: raw,
    kind: 'unknown',
  }
}

/**
 * Markers of a message written by Postgres or PostgREST rather than by
 * RecoverEase. "new row violates row-level security policy" is true and
 * useless; "An account already exists for that email address" is neither.
 */
const MACHINE_MESSAGE = [
  'violates',
  'constraint',
  'duplicate key',
  'null value in column',
  'relation "',
  'column "',
  'syntax error',
  'pgrst',
  'invalid input syntax',
  'unknown error',
]

/**
 * Whether a message can be shown to whoever pressed Save.
 *
 * Application errors — from an Edge Function, or a validation rule — are
 * already written for the person reading them and are the single most useful
 * thing on the screen. Database internals are not.
 */
export function isPresentableMessage(raw: string): boolean {
  const lowered = raw.toLowerCase().trim()
  if (lowered.length === 0 || lowered.length > 200) return false
  return !MACHINE_MESSAGE.some((marker) => lowered.includes(marker))
}

export type ErrorStateProps = {
  error: unknown
  onRetry?: () => void
  className?: string
}

export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const { icon: Icon, title, description, detail } = describeError(error)

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-danger-50">
        <Icon className="size-5 text-danger-700" aria-hidden="true" />
      </span>
      <h3 className="text-base font-semibold text-heading">{title}</h3>
      <p className="max-w-sm text-sm text-muted">{description}</p>

      {onRetry ? (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}

      {detail && import.meta.env.DEV ? (
        <details className="mt-4 max-w-md text-left">
          <summary className="cursor-pointer text-xs text-muted">
            Technical detail
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] bg-neutral-100 p-3 text-xs text-body">
            {detail}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

export type StateViewProps<T> = {
  isPending: boolean
  error?: unknown
  data: T | undefined
  onRetry?: () => void
  /** Treated as empty when this returns true. Defaults to empty arrays. */
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  loadingLabel?: string
  children: (data: T) => ReactNode
}

export function StateView<T>({
  isPending,
  error,
  data,
  onRetry,
  isEmpty,
  empty,
  loadingLabel,
  children,
}: StateViewProps<T>) {
  // Order matters. Pending is checked first so a slow request never renders
  // as "no results", which would be a lie the user acts on.
  if (isPending) {
    return <LoadingState {...(loadingLabel ? { label: loadingLabel } : {})} />
  }

  if (error) {
    return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />
  }

  if (data === undefined || data === null) {
    return (
      <ErrorState
        error={new Error('No data was returned.')}
        {...(onRetry ? { onRetry } : {})}
      />
    )
  }

  const treatAsEmpty = isEmpty
    ? isEmpty(data)
    : Array.isArray(data) && data.length === 0

  if (treatAsEmpty && empty) {
    return <>{empty}</>
  }

  return <>{children(data)}</>
}
