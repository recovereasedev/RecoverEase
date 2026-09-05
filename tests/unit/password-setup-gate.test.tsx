import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser } from '@/features/auth/types'

/**
 * What happens in the seconds after the password is saved.
 *
 * This is the part that was wrong in production. A service-role password
 * change revokes the account's refresh tokens — on purpose, so a second
 * browser holding the temporary credential is put out at the same moment —
 * and the client then called `refreshSession()` with a token the server had
 * just revoked. It failed every time, so everyone who completed setup was
 * told "the session could not be renewed. Sign in again", having just proved
 * who they were twice.
 *
 * The gate now expects a re-authentication rather than a refresh, and only
 * falls back to the sign-in page when that genuinely fails. These cover both
 * branches, because a fallback nobody exercises is a fallback nobody knows is
 * broken.
 */

const mockComplete = vi.hoisted(() => vi.fn())
const mockNavigate = vi.hoisted(() => vi.fn())
const mockAuth = vi.hoisted(() => ({
  user: null as AppUser | null,
  signOut: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/features/auth/api', () => ({
  completePasswordSetup: mockComplete,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => mockAuth,
  useCurrentUser: () => mockAuth.user,
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  )
  return { ...actual, useNavigate: () => mockNavigate }
})

const { PasswordSetupGate } = await import(
  '@/features/auth/components/password-setup-gate'
)

function userWith(role: AppUser['role'], mustChangePassword: boolean): AppUser {
  return {
    userId: 'u-1',
    email: 'someone@example.test',
    role,
    displayName: 'Someone',
    mustChangePassword,
    profile: { kind: role, [role]: {} } as never,
  }
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  sessionStorage.clear()
  mockComplete.mockReset()
  mockNavigate.mockReset()
  mockAuth.refresh.mockClear()
  mockAuth.user = userWith('doctor', true)
})

function fillAndSubmit(password = 'a-long-enough-password') {
  render(
    <PasswordSetupGate>
      <div>the application</div>
    </PasswordSetupGate>,
  )
  fireEvent.change(screen.getByLabelText(/^New password/), {
    target: { value: password },
  })
  fireEvent.change(screen.getByLabelText(/^Confirm new password/), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: /Save and continue/ }))
}

describe('the forced password setup gate', () => {
  it('lets the application through once the requirement is cleared', () => {
    mockAuth.user = userWith('doctor', false)
    render(
      <PasswordSetupGate>
        <div>the application</div>
      </PasswordSetupGate>,
    )
    expect(screen.getByText('the application')).toBeInTheDocument()
  })

  it('holds the application back while the requirement stands', () => {
    render(
      <PasswordSetupGate>
        <div>the application</div>
      </PasswordSetupGate>,
    )
    expect(screen.queryByText('the application')).not.toBeInTheDocument()
    expect(screen.getByText('Choose your password')).toBeInTheDocument()
  })

  it('re-reads the session and enters the doctor home on success', async () => {
    mockComplete.mockResolvedValue({ signedIn: true })
    fillAndSubmit()

    await waitFor(() => expect(mockAuth.refresh).toHaveBeenCalled())
    expect(mockNavigate).toHaveBeenCalledWith('/doctor', { replace: true })
  })

  it('enters the patient home for a patient, not the doctor one', async () => {
    // The role comes from the verified session, so setting a password can
    // never move an account into another role's area.
    mockAuth.user = userWith('patient', true)
    mockComplete.mockResolvedValue({ signedIn: true })
    fillAndSubmit()

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/patient', { replace: true }),
    )
  })

  it('enters the admin home for an administrator', async () => {
    mockAuth.user = userWith('admin', true)
    mockComplete.mockResolvedValue({ signedIn: true })
    fillAndSubmit()

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true }),
    )
  })

  it('never tells a successful user to sign in again', async () => {
    mockComplete.mockResolvedValue({ signedIn: true })
    fillAndSubmit()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
    expect(screen.queryByText(/could not be renewed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Sign in again/i)).not.toBeInTheDocument()
  })

  it('falls back to sign-in only when the session cannot be rebuilt', async () => {
    mockComplete.mockResolvedValue({ signedIn: false })
    fillAndSubmit()

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/sign-in', { replace: true }),
    )
    // The message has to outlive the guard's own redirect, so it is left
    // where a redirect cannot drop it rather than attached to the navigation.
    expect(sessionStorage.getItem('recoverease.flash')).toBe(
      'Your password is saved. Sign in with your new password to continue.',
    )
    // The password did change, so the fallback must not read as a failure.
    expect(screen.queryByText(/could not be changed/i)).not.toBeInTheDocument()
  })

  it('keeps the form and shows why when the change itself fails', async () => {
    mockComplete.mockRejectedValue(
      new Error('Choose a password different from the temporary one'),
    )
    fillAndSubmit()

    await waitFor(() =>
      expect(
        screen.getByText('Choose a password different from the temporary one'),
      ).toBeInTheDocument(),
    )
    // Nothing was saved, so nothing should have moved.
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(mockAuth.refresh).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: /Save and continue/ }),
    ).toBeInTheDocument()
  })

  it('refuses a password shorter than the policy without calling the server', async () => {
    fillAndSubmit('short')
    await waitFor(() =>
      expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument(),
    )
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('offers a way to reveal what is being typed', () => {
    render(
      <PasswordSetupGate>
        <div>the application</div>
      </PasswordSetupGate>,
    )
    const toggle = screen.getByRole('button', { name: /Show password/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(
      screen.getByRole('button', { name: /Hide password/ }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
