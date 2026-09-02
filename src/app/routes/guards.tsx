import { ShieldAlert, UserX } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/state-view'
import { Button, buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import type { AccountProblem, UserRole } from '@/features/auth/types'

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

function BlockedScreen({
  title,
  description,
  onSignOut,
}: {
  title: string
  description: string
  onSignOut: () => void
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6">
      <EmptyState
        icon={UserX}
        title={title}
        description={description}
        action={
          <Button variant="secondary" onClick={onSignOut}>
            Sign out
          </Button>
        }
      />
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
      <div className="flex min-h-dvh items-center justify-center">
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
      <div className="flex min-h-dvh items-center justify-center px-6">
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
      <BlockedScreen
        title={title}
        description={description}
        onSignOut={() => void signOut()}
      />
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
  const { user } = useAuth()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6">
      <EmptyState
        icon={ShieldAlert}
        title="Page not found"
        description="This page does not exist, or you do not have access to it."
        action={
          <Link
            to={user ? roleHome(user.role) : '/'}
            className={buttonVariants({ variant: 'secondary' })}
          >
            {user ? 'Back to your dashboard' : 'Back to home'}
          </Link>
        }
      />
    </main>
  )
}
