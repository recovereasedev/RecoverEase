import { ShieldAlert, UserX, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { Button, buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import type { AccountProblem, UserRole } from '@/features/auth/types'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { cn } from '@/lib/utils'

/**
 * Route guards.
 *
 * These decide what is RENDERED. They are not the security boundary — Row
 * Level Security is. A guard that failed open would show a patient an empty
 * doctor dashboard, not another patient's records, because the database would
 * still refuse every query. The guards exist so that people see coherent
 * screens, not so that data stays private.
 */

const HOME_FOR_ROLE: Record<UserRole, string> = {
  patient: '/patient',
  doctor: '/doctor',
  admin: '/admin',
}

export function roleHome(role: UserRole): string {
  return HOME_FOR_ROLE[role]
}

/**
 * The frame for a screen that is the whole page rather than a panel inside
 * one: not found, blocked account, session failure.
 *
 * It is not `EmptyState`. That renders an `<h3>`, which is correct for a card
 * that sits under a page heading and wrong here, where this *is* the page and
 * the browser's heading outline would otherwise start at level three. Same
 * visual language, different document semantics.
 */
function StatusScreen({
  icon: Icon,
  tone = 'neutral',
  title,
  description,
  children,
}: {
  icon: LucideIcon
  tone?: 'neutral' | 'danger'
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <main
      className={[
        'mx-auto flex min-h-dvh w-full max-w-md flex-col px-5',
        'pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]',
      ].join(' ')}
    >
      {/* `my-auto` rather than `justify-center`, so a long message on a short
          screen scrolls from the top instead of overflowing past it. */}
      <div className="my-auto flex flex-col items-center text-center">
        <span
          aria-hidden="true"
          className={cn(
            'flex size-14 items-center justify-center rounded-[var(--radius-lg)]',
            tone === 'danger'
              ? 'bg-danger-50 text-danger-700'
              : 'bg-surface-raised text-brand-700',
          )}
        >
          <Icon className="size-7" />
        </span>

        <h1 className="mt-5 text-headline-lg text-brand-800">{title}</h1>
        <p className="mt-2 text-body-md leading-relaxed text-muted">
          {description}
        </p>

        {children ? <div className="mt-7 w-full">{children}</div> : null}
      </div>
    </main>
  )
}

function describeProblem(problem: AccountProblem): {
  title: string
  description: string
} {
  switch (problem.kind) {
    case 'doctor-deactivated':
      return {
        title: 'This account has been deactivated',
        description:
          'An administrator has deactivated your clinician account, so it can no longer access patient information. Contact your system administrator to have it reinstated.',
      }
    case 'not-provisioned':
      return {
        title: 'Your account is not set up yet',
        description:
          'You have signed in, but no RecoverEase profile is linked to this account. RecoverEase accounts are created by your care team — please contact them so they can finish setting yours up.',
      }
    case 'profile-missing':
      return {
        title: 'Your profile is incomplete',
        description: `Your account is registered as a ${problem.role}, but the matching profile record is missing. Please contact your system administrator.`,
      }
  }
}

/** Requires a usable session. Anything else gets an explanation. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, signOut } = useAuth()
  const location = useLocation()

  if (status.state === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-5">
        <LoadingState label="Checking your session…" />
      </div>
    )
  }

  if (status.state === 'signed-out') {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/sign-in" state={{ from: location }} replace />
  }

  if (status.state === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-5">
        <ErrorState
          error={status.error}
          onRetry={() => window.location.reload()}
        />
      </div>
    )
  }

  if (status.state === 'blocked') {
    const { title, description } = describeProblem(status.problem)
    return (
      <StatusScreen
        icon={UserX}
        tone="danger"
        title={title}
        description={description}
      >
        <Button
          variant="secondary"
          size="lg"
          block
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </StatusScreen>
    )
  }

  return <>{children}</>
}

/**
 * Requires one of the given roles. Users who are signed in but on the wrong
 * branch of the app are sent to their own home rather than shown an error:
 * landing on the wrong dashboard is a navigation mistake, not a security
 * event, and treating it as one is just noise.
 */
export function RequireRole({
  allow,
  children,
}: {
  allow: readonly UserRole[]
  children: ReactNode
}) {
  const { user } = useAuth()

  if (!user) {
    return <Navigate to="/sign-in" replace />
  }

  if (!allow.includes(user.role)) {
    return <Navigate to={roleHome(user.role)} replace />
  }

  return <>{children}</>
}

/** For the landing and sign-in pages: send a signed-in user to their app. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { status } = useAuth()

  if (status.state === 'signed-in') {
    return <Navigate to={roleHome(status.user.role)} replace />
  }

  return <>{children}</>
}

export function NotFoundScreen() {
  useDocumentTitle('Page Not Found')
  const { user } = useAuth()

  return (
    <StatusScreen
      icon={ShieldAlert}
      title="Page not found"
      description="This page does not exist, or you do not have access to it."
    >
      {/* The only destination offered is one that certainly exists for whoever
          is looking at this. No guesses, no "try searching". */}
      <Link
        to={user ? roleHome(user.role) : '/'}
        className={buttonVariants({ size: 'lg', block: true })}
      >
        {user ? 'Back to your dashboard' : 'Back to home'}
      </Link>
    </StatusScreen>
  )
}
