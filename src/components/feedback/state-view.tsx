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
      <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-neutral-100">
        <Icon className="size-5 text-neutral-500" aria-hidden="true" />
      </span>
      <h3 className="text-base font-semibold text-heading">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
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

export function describeError(error: unknown): {
  icon: LucideIcon
  title: string
  description: string
  detail?: string
  kind: ErrorKind
} {
  // Not every failure arrives as an Error. PostgREST, Supabase Auth and the
  // Edge Functions all reject with objects carrying a `message`, and reading
  // only `Error` instances turned every one of them into "Unknown error" —
  // which meant the network and permission branches below never matched a
  // database failure, and the refusal a user needed to read was replaced by
  // "something went wrong".
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            typeof (error as { message: unknown }).message === 'string'
          ? (error as { message: string }).message
          : 'Unknown error'

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
