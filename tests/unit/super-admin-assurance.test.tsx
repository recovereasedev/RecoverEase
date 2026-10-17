import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The platform console's authenticator step (SuperAdminAssuranceGate).
 *
 * Supabase Auth is replaced by a small model of its MFA endpoints: factors
 * that are verified or not, a session that is aal1 or aal2, and a code that
 * is right or wrong. The database's own answer - `super_admin_assured()` - is
 * set per test, because the console may open only when the database agrees,
 * whatever the session claims. That function itself, and every Super Admin
 * function refusing a session it does not accept, are tested against the
 * real migrations in tests/db/super-admin.test.ts.
 *
 * What is covered here is what the person sees: nothing of the console
 * before the database accepts the session; setting up an authenticator;
 * entering its code; a wrong, expired or rate-limited code; starting again;
 * a lost authenticator, which has a way out but no way round; and failing
 * closed whenever the answer cannot be read.
 */

type FakeFactor = {
  id: string
  factor_type: 'totp' | 'phone'
  status: 'verified' | 'unverified'
}

type AuthFailure = { code?: string; status?: number; message: string }

const auth = vi.hoisted(() => {
  const state = {
    factors: [] as FakeFactor[],
    level: 'aal1' as 'aal1' | 'aal2',
    /** What `super_admin_assured()` answers, or the error it fails with. */
    assured: true as boolean | { message: string },
    /** The code the authenticator would show right now. */
    code: '123456',
    /** Overrides the outcome of the next check, e.g. an expired challenge. */
    nextFailure: null as AuthFailure | null,
    /** Holds checks open until released, to test a second press. */
    hold: null as Promise<void> | null,
    listFails: false,
    nextId: 1,
  }

  const mfa = {
    listFactors: vi.fn(async () => {
      if (state.listFails) {
        return { data: null, error: { message: 'Failed to fetch' } }
      }
      return {
        data: {
          all: state.factors.map((factor) => ({ ...factor })),
          totp: state.factors
            .filter((f) => f.factor_type === 'totp' && f.status === 'verified')
            .map((factor) => ({ ...factor })),
          phone: [],
          webauthn: [],
        },
        error: null,
      }
    }),
    getAuthenticatorAssuranceLevel: vi.fn(async () => ({
      data: {
        currentLevel: state.level,
        nextLevel: 'aal2',
        currentAuthenticationMethods: [],
      },
      error: null,
    })),
    enroll: vi.fn(async (_params: { factorType: 'totp'; issuer?: string }) => {
      const id = `factor-${state.nextId++}`
      state.factors.push({ id, factor_type: 'totp', status: 'unverified' })
      return {
        data: {
          id,
          type: 'totp',
          friendly_name: '',
          totp: {
            qr_code: `data:image/svg+xml;utf-8,<svg id="${id}"/>`,
            secret: `JBSWY3DPEHPK3PXP${id.toUpperCase().replace('-', '')}`,
            uri: 'otpauth://totp/RecoverEase',
          },
        },
        error: null,
      }
    }),
    unenroll: vi.fn(async ({ factorId }: { factorId: string }) => {
      state.factors = state.factors.filter((factor) => factor.id !== factorId)
      return { data: { id: factorId }, error: null }
    }),
    challengeAndVerify: vi.fn(
      async ({ factorId, code }: { factorId: string; code: string }) => {
        if (state.hold) await state.hold
        if (state.nextFailure) {
          const failure = state.nextFailure
          state.nextFailure = null
          return { data: null, error: failure }
        }
        const factor = state.factors.find((candidate) => candidate.id === factorId)
        if (!factor || code !== state.code) {
          return {
            data: null,
            error: {
              code: 'mfa_verification_failed',
              status: 422,
              message: 'Invalid TOTP code entered',
            },
          }
        }
        factor.status = 'verified'
        state.level = 'aal2'
        return { data: { access_token: 'raised' }, error: null }
      },
    ),
  }

  const rpc = vi.fn(async (name: string) => {
    if (name !== 'super_admin_assured') {
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    }
    return typeof state.assured === 'boolean'
      ? { data: state.assured, error: null }
      : { data: null, error: state.assured }
  })

  return { state, supabase: { auth: { mfa }, rpc } }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: auth.supabase }))

const signOut = vi.fn()
vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => ({ signOut, refresh: vi.fn() }),
  useCurrentUser: () => ({
    userId: 'super-user',
    email: 'super@platform.test',
    role: 'super_admin',
    displayName: 'Pat Reyes',
    mustChangePassword: false,
    profile: { kind: 'super_admin', superAdmin: { super_admin_id: 'sa-1' } },
  }),
}))

const { SuperAdminAssuranceGate } = await import(
  '@/features/platform/components/assurance-gate'
)
const { startEnrolment } = await import('@/features/platform/mfa')

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function renderGate(client = freshClient()) {
  const ui = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <SuperAdminAssuranceGate>{children}</SuperAdminAssuranceGate>
    </QueryClientProvider>
  )
  const view = render(ui(<p>Platform console</p>))
  return { ...view, client }
}

const CONSOLE = 'Platform console'

function verified(id = 'factor-verified'): FakeFactor {
  return { id, factor_type: 'totp', status: 'verified' }
}

beforeEach(() => {
  auth.state.factors = []
  auth.state.level = 'aal1'
  auth.state.assured = true
  auth.state.code = '123456'
  auth.state.nextFailure = null
  auth.state.hold = null
  auth.state.listFails = false
  auth.state.nextId = 1
  signOut.mockReset()
  for (const fn of Object.values(auth.supabase.auth.mfa)) fn.mockClear()
  auth.supabase.rpc.mockClear()
})

describe('what the console needs before it opens', () => {
  it('opens for a session the database accepts: aal2, with a verified authenticator', async () => {
    auth.state.factors = [verified()]
    auth.state.level = 'aal2'

    renderGate()

    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.rpc).toHaveBeenCalledWith('super_admin_assured')
  })

  it('asks for a code, and shows nothing of the console, when this session has not entered one', async () => {
    auth.state.factors = [verified()]

    renderGate()

    expect(
      await screen.findByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
    // The token is aal1, so the database is not even asked: it would refuse.
    expect(auth.supabase.rpc).not.toHaveBeenCalled()
  })

  it('asks for an authenticator to be set up when there is none', async () => {
    renderGate()

    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator app' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
  })

  it('treats an unfinished setup as no authenticator: it cannot be used to sign in', async () => {
    auth.state.factors = [{ id: 'abandoned', factor_type: 'totp', status: 'unverified' }]

    renderGate()

    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator app' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/6-digit code/)).not.toBeInTheDocument()
  })

  it('treats a verified factor of another kind as no authenticator app', async () => {
    // Only an authenticator app (TOTP) satisfies the database's check.
    auth.state.factors = [{ id: 'sms', factor_type: 'phone', status: 'verified' }]

    renderGate()

    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator app' }),
    ).toBeInTheDocument()
  })

  it('stays closed when the session says aal2 but the database does not accept it', async () => {
    auth.state.factors = [verified()]
    auth.state.level = 'aal2'
    auth.state.assured = false

    renderGate()

    expect(
      await screen.findByRole('heading', {
        name: 'This session cannot open the platform console',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('stays closed when the database cannot be asked', async () => {
    auth.state.factors = [verified()]
    auth.state.level = 'aal2'
    auth.state.assured = { message: 'Failed to fetch' }

    renderGate()

    expect(await screen.findByRole('heading', { name: 'No connection' })).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('stays closed when the authenticators cannot be read', async () => {
    auth.state.listFails = true

    renderGate()

    expect(await screen.findByRole('heading', { name: 'No connection' })).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
  })

  it('asks again each time it appears: an earlier "yes" never opens the console for a later session', async () => {
    auth.state.factors = [verified()]
    auth.state.level = 'aal2'
    const first = renderGate()
    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()

    // Signed out (the gate goes), and signed in again with a password only.
    first.unmount()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    auth.state.level = 'aal1'

    renderGate(first.client)

    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
  })
})

describe('setting up an authenticator app', () => {
  it('shows a QR code and the setup key, then opens the console once its code is right', async () => {
    const user = userEvent.setup()
    renderGate()

    await user.click(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    )

    expect(auth.supabase.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      issuer: 'RecoverEase',
    })
    const qr = await screen.findByRole('img', {
      name: 'QR code for adding RecoverEase to your authenticator app',
    })
    expect(qr).toHaveAttribute('src', 'data:image/svg+xml;utf-8,<svg id="factor-1"/>')
    // Grouped in fours to be typed by hand.
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP FACT OR1')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/6-digit code/), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }))

    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      code: '123456',
    })
    expect(auth.state.factors).toEqual([verified('factor-1')])
  })

  it('keeps the setup open after a wrong code, with the field emptied for the next one', async () => {
    const user = userEvent.setup()
    renderGate()

    await user.click(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    )
    const field = await screen.findByLabelText(/6-digit code/)
    await user.type(field, '000000')
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code did not match. Enter the code your authenticator app is showing now',
    )
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
    expect(auth.state.factors).toEqual([
      { id: 'factor-1', factor_type: 'totp', status: 'unverified' },
    ])
  })

  it('removes an unfinished setup before starting another, and never a verified factor', async () => {
    auth.state.factors = [
      { id: 'abandoned', factor_type: 'totp', status: 'unverified' },
      verified('kept'),
      { id: 'sms', factor_type: 'phone', status: 'verified' },
    ]

    const pending = await startEnrolment()

    expect(auth.supabase.auth.mfa.unenroll).toHaveBeenCalledTimes(1)
    expect(auth.supabase.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'abandoned' })
    expect(pending.factorId).toBe('factor-1')
    expect(auth.state.factors.map((factor) => factor.id)).toEqual([
      'kept',
      'sms',
      'factor-1',
    ])
  })

  it('"Start again" replaces the QR code, and the old one can no longer be completed', async () => {
    const user = userEvent.setup()
    renderGate()

    await user.click(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    )
    await screen.findByRole('img', { name: /QR code/ })

    await user.click(
      screen.getByRole('button', { name: 'Start again with a new QR code' }),
    )

    await waitFor(() =>
      expect(screen.getByRole('img', { name: /QR code/ })).toHaveAttribute(
        'src',
        'data:image/svg+xml;utf-8,<svg id="factor-2"/>',
      ),
    )
    expect(auth.supabase.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'factor-1' })
    expect(auth.state.factors.map((factor) => factor.id)).toEqual(['factor-2'])

    await user.type(screen.getByLabelText(/6-digit code/), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }))

    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.auth.mfa.challengeAndVerify).toHaveBeenLastCalledWith({
      factorId: 'factor-2',
      code: '123456',
    })
  })

  it('says so when authenticator apps are not switched on for the project', async () => {
    auth.supabase.auth.mfa.enroll.mockResolvedValueOnce({
      data: null,
      error: { code: 'mfa_totp_enroll_not_enabled', status: 422, message: 'MFA enroll is disabled for TOTP' },
    } as never)
    const user = userEvent.setup()
    renderGate()

    await user.click(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    )

    expect(
      await screen.findByText(/Authenticator apps are not switched on for RecoverEase yet/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
  })
})

describe('entering the code at sign-in', () => {
  beforeEach(() => {
    auth.state.factors = [verified()]
  })

  async function codeScreen() {
    renderGate()
    return screen.findByLabelText(/6-digit code/)
  }

  it('opens the console once the code is right, with spaces in the code allowed', async () => {
    const user = userEvent.setup()
    const field = await codeScreen()
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    expect(field).toHaveAttribute('inputmode', 'numeric')

    await user.type(field, '123 456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-verified',
      code: '123456',
    })
  })

  it.each(['', '12345', '1234567', '12a456'])(
    'refuses %j before asking Supabase Auth',
    async (typed) => {
      const user = userEvent.setup()
      const field = await codeScreen()
      if (typed) await user.type(field, typed)
      await user.click(screen.getByRole('button', { name: 'Verify' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Enter the 6-digit code from your authenticator app.',
      )
      expect(field).toHaveFocus()
      expect(auth.supabase.auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
    },
  )

  it.each<[string, AuthFailure, RegExp]>([
    [
      'an expired challenge',
      { code: 'mfa_challenge_expired', status: 422, message: 'challenge expired' },
      /took too long to check/,
    ],
    [
      'too many attempts',
      { code: 'over_request_rate_limit', status: 429, message: 'rate limited' },
      /Too many attempts. Wait a minute/,
    ],
    [
      'a rate limit with no code',
      { status: 429, message: 'Too many requests' },
      /Too many attempts. Wait a minute/,
    ],
    [
      'a factor removed meanwhile',
      { code: 'mfa_factor_not_found', status: 404, message: 'Factor not found' },
      /no longer set up for your account/,
    ],
    [
      'authenticator apps switched off',
      { code: 'mfa_totp_verify_not_enabled', status: 422, message: 'disabled' },
      /not switched on for RecoverEase yet/,
    ],
    ['no connection', { message: 'Failed to fetch' }, /could not reach RecoverEase/],
  ])('explains %s, and the console stays closed', async (_label, failure, message) => {
    auth.state.nextFailure = failure
    const user = userEvent.setup()
    const field = await codeScreen()

    await user.type(field, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText(CONSOLE)).not.toBeInTheDocument()
  })

  it('works again after a failure: every attempt is a new challenge', async () => {
    auth.state.nextFailure = {
      code: 'mfa_challenge_expired',
      status: 422,
      message: 'challenge expired',
    }
    const user = userEvent.setup()
    const field = await codeScreen()

    await user.type(field, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    await screen.findByRole('alert')

    await user.type(field, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledTimes(2)
  })

  it('checks one code once, however many times Verify is pressed', async () => {
    let release = () => {}
    auth.state.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const user = userEvent.setup()
    const field = await codeScreen()

    await user.type(field, '123456')
    const form = field.closest('form') as HTMLFormElement
    // Two presses in the same task, before React has drawn the busy button
    // that would ignore the second.
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    // And presses on the busy button afterwards.
    await user.click(screen.getByRole('button', { name: /Verify|Checking/ }))
    await user.keyboard('{Enter}')

    release()
    expect(await screen.findByText(CONSOLE)).toBeInTheDocument()
    expect(auth.supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledTimes(1)
  })
})

describe('a lost authenticator', () => {
  it('names the way out that exists, and offers no way round the code', async () => {
    auth.state.factors = [verified()]
    const user = userEvent.setup()
    renderGate()

    const help = (await screen.findByText('Lost your authenticator app?')).closest(
      'details',
    ) as HTMLElement
    await user.click(within(help).getByText('Lost your authenticator app?'))

    expect(help).toHaveAttribute('open')
    expect(help).toHaveTextContent('There is no way to skip this step')
    expect(help).toHaveTextContent('Contact the RecoverEase platform owner')
    expect(help).toHaveTextContent('they remove your old authenticator')

    // Verify and Sign out are the only actions: nothing skips, defers or
    // replaces the code from this screen.
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual(['Verify', 'Sign out'])
    expect(auth.supabase.auth.mfa.unenroll).not.toHaveBeenCalled()
    expect(auth.supabase.auth.mfa.enroll).not.toHaveBeenCalled()
  })

  it('is warned about when an authenticator is first set up', async () => {
    renderGate()

    expect(
      await screen.findByText(/If you lose it, the platform owner has to confirm who you are/),
    ).toBeInTheDocument()
  })
})
