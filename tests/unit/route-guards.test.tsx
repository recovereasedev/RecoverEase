import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { AppUser, AuthStatus } from '@/features/auth/types'

// Mocked so the guards can be driven through every session state without a
// network round trip. The guards are the unit under test, not the provider.
const mockAuth = vi.hoisted(() => ({
  status: { state: 'loading' } as AuthStatus,
  user: null as AppUser | null,
  signOut: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => mockAuth,
  useCurrentUser: () => mockAuth.user,
}))

const { RequireAuth, RequireRole, RedirectIfSignedIn, roleHome } = await import(
  '@/app/routes/guards'
)

function patient(): AppUser {
  return {
    userId: 'u-1',
    email: 'alice@example.test',
    role: 'patient',
    displayName: 'Alice Santos',
    mustChangePassword: false,
    profile: {
      kind: 'patient',
      // Only the fields the guards read matter here.
      patient: { pat_id: 'p-1', pat_consent_at: '2026-01-01' } as never,
    },
  }
}

function signedIn(user: AppUser) {
  mockAuth.status = { state: 'signed-in', user }
  mockAuth.user = user
}

/**
 * Renders the guard at a neutral path, with each role's home registered
 * separately so a redirect lands somewhere observable.
 *
 * The path under test is deliberately not one of the destinations: reusing
 * `/patient` for both would register that path twice and the redirect would
 * re-enter the guard instead of resolving.
 */
const GUARDED_PATH = '/guarded'

function renderAt(element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[GUARDED_PATH]}>
      <Routes>
        <Route path={GUARDED_PATH} element={element} />
        <Route path="/sign-in" element={<p>Sign in page</p>} />
        <Route path="/patient" element={<p>Patient home</p>} />
        <Route path="/doctor" element={<p>Doctor home</p>} />
        <Route path="/admin" element={<p>Admin home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  beforeEach(() => {
    mockAuth.status = { state: 'loading' }
    mockAuth.user = null
    mockAuth.signOut = vi.fn()
  })

  it('waits rather than redirecting while the session is resolving', () => {
    // Redirecting on `loading` would bounce a signed-in user to the login
    // page on every hard refresh, before their session had a chance to load.
    renderAt(<RequireAuth>secret</RequireAuth>)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('Sign in page')).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in', () => {
    mockAuth.status = { state: 'signed-out' }
    renderAt(<RequireAuth>secret</RequireAuth>)

    expect(screen.getByText('Sign in page')).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('explains a deactivated clinician account instead of dumping them at login', () => {
    mockAuth.status = {
      state: 'blocked',
      problem: { kind: 'doctor-deactivated' },
    }
    renderAt(<RequireAuth>secret</RequireAuth>)

    expect(
      screen.getByRole('heading', { name: /has been deactivated/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/contact your system administrator/i)).toBeInTheDocument()
    expect(screen.queryByText('Sign in page')).not.toBeInTheDocument()
  })

  it('explains an unprovisioned account', () => {
    mockAuth.status = {
      state: 'blocked',
      problem: { kind: 'not-provisioned' },
    }
    renderAt(<RequireAuth>secret</RequireAuth>)

    // RecoverEase has no self-registration, so this is a provisioning gap and
    // the copy has to point at the care team, not at a sign-up link.
    expect(screen.getByText(/not set up yet/i)).toBeInTheDocument()
    expect(screen.getByText(/care team/i)).toBeInTheDocument()
  })

  it('renders the page once the session is usable', () => {
    signedIn(patient())
    renderAt(<RequireAuth>secret</RequireAuth>)

    expect(screen.getByText('secret')).toBeInTheDocument()
  })
})

describe('RequireRole', () => {
  beforeEach(() => {
    mockAuth.signOut = vi.fn()
  })

  it('renders the page for a permitted role', () => {
    signedIn(patient())
    renderAt(<RequireRole allow={['patient']}>patient area</RequireRole>,
    )

    expect(screen.getByText('patient area')).toBeInTheDocument()
  })

  it('sends a patient who reaches an admin route to their own home', () => {
    // Not an error page: landing on the wrong dashboard is a navigation
    // mistake, and the database refuses the data regardless.
    signedIn(patient())
    renderAt(<RequireRole allow={['admin']}>admin area</RequireRole>)

    expect(screen.getByText('Patient home')).toBeInTheDocument()
    expect(screen.queryByText('admin area')).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in', () => {
    mockAuth.status = { state: 'signed-out' }
    mockAuth.user = null
    renderAt(<RequireRole allow={['admin']}>admin area</RequireRole>)

    expect(screen.getByText('Sign in page')).toBeInTheDocument()
  })
})

describe('RedirectIfSignedIn', () => {
  it('sends a signed-in user from the landing page to their dashboard', () => {
    signedIn(patient())
    renderAt(<RedirectIfSignedIn>marketing</RedirectIfSignedIn>)

    expect(screen.getByText('Patient home')).toBeInTheDocument()
  })

  it('shows the page to a visitor who is not signed in', () => {
    mockAuth.status = { state: 'signed-out' }
    mockAuth.user = null
    renderAt(<RedirectIfSignedIn>marketing</RedirectIfSignedIn>)

    expect(screen.getByText('marketing')).toBeInTheDocument()
  })
})

describe('roleHome', () => {
  it('maps every role to its own section', () => {
    expect(roleHome('patient')).toBe('/patient')
    expect(roleHome('doctor')).toBe('/doctor')
    expect(roleHome('admin')).toBe('/admin')
  })
})
