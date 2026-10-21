import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUser, AuthStatus } from '@/features/auth/types'
import { queryKeysFor } from '@/lib/query-keys'

/**
 * One tab, two people: a shared clinic computer where one account signs out
 * and the next signs in on the same page. The tab keeps one query cache for
 * its whole life, and RLS answers `patients.list()` or `notifications.list()`
 * with whatever belongs to whoever asked - so nothing the first account
 * loaded may be shown to, or left in the cache for, the second.
 *
 * Driven through the real AppProviders and AuthProvider, with the app's own
 * query hooks and keys. Only the network is replaced: Supabase Auth, the
 * profile lookup and the two fetches.
 */

type Session = { user: { id: string; email: string; app_metadata: object } }

const auth = vi.hoisted(() => ({
  session: null as Session | null,
  emit: (_event: string) => {},
  /** Set to hold an account's profile lookup until the test releases it. */
  heldProfile: null as null | { userId: string; release: () => void },
}))

const server = vi.hoisted(() => ({
  /** Requests answered later, in the order they were made. */
  pending: [] as Array<{ asker: string; answer: () => void }>,
  hold: false,
}))

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: auth.session }, error: null }),
      onAuthStateChange: (callback: (event: string) => void) => {
        auth.emit = callback
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
  },
}))

const ACCOUNTS: Record<string, AppUser> = {
  'u-a': {
    userId: 'u-a',
    email: 'dr.a@clinic-one.test',
    role: 'doctor',
    displayName: 'Dr Ana Reyes',
    mustChangePassword: false,
    profile: { kind: 'doctor', doctor: { doc_id: 'd-a' } as never },
  },
  'u-b': {
    userId: 'u-b',
    email: 'dr.b@clinic-two.test',
    role: 'doctor',
    displayName: 'Dr Ben Cruz',
    mustChangePassword: false,
    profile: { kind: 'doctor', doctor: { doc_id: 'd-b' } as never },
  },
}

vi.mock('@/features/auth/api', () => ({
  loadAppUser: async (userId: string): Promise<AuthStatus> => {
    if (auth.heldProfile?.userId === userId) {
      await new Promise<void>((resolve) => {
        auth.heldProfile!.release = resolve
      })
    }
    return { state: 'signed-in', user: ACCOUNTS[userId]! }
  },
  // What supabase-js does on sign-out: the session goes, and SIGNED_OUT
  // follows.
  signOut: async () => {
    auth.session = null
    auth.emit('SIGNED_OUT')
  },
}))

// Each account's own records, as RLS would return them to that account.
const PATIENTS: Record<string, Array<{ pat_id: string; pat_first_name: string; pat_last_name: string }>> = {
  'u-a': [{ pat_id: 'p-a', pat_first_name: 'Alice', pat_last_name: 'Santos' }],
  'u-b': [{ pat_id: 'p-b', pat_first_name: 'Bruno', pat_last_name: 'Lim' }],
}
const NOTIFICATIONS: Record<string, Array<{ notification_id: string; notification_message: string }>> = {
  'u-a': [{ notification_id: 'n-a', notification_message: 'Alice Santos missed a dose' }],
  'u-b': [{ notification_id: 'n-b', notification_message: 'Bruno Lim logged a recovery entry' }],
}

/**
 * Answers for whoever is signed in when the request is made - the token it
 * carries - and, while `server.hold` is set, only when the test says so.
 */
function respond<T>(records: Record<string, T>) {
  return vi.fn(async () => {
    const asker = auth.session?.user.id ?? 'nobody'
    if (server.hold) {
      await new Promise<void>((resolve) => {
        server.pending.push({ asker, answer: resolve })
      })
    }
    return records[asker]
  })
}

const fetchMyPatients = respond(PATIENTS)
const fetchNotifications = respond(NOTIFICATIONS)

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchMyPatients: () => fetchMyPatients(),
}))

vi.mock('@/features/notifications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/notifications/api')>()),
  fetchNotifications: () => fetchNotifications(),
}))

const { AppProviders } = await import('@/app/providers')
const { useAuth } = await import('@/features/auth/auth-context')
const { useMyPatients } = await import('@/features/patients/hooks')
const { useNotifications } = await import('@/features/notifications/hooks')

/** A signed-in screen reading two of the keys that do not name an account. */
function Records() {
  const { signOut } = useAuth()
  const patients = useMyPatients()
  const notifications = useNotifications()

  return (
    <section aria-label="Records">
      {patients.isPending ? <p>Loading patients…</p> : null}
      <ul aria-label="Patients">
        {patients.data?.map((patient) => (
          <li key={patient.pat_id}>
            {patient.pat_first_name} {patient.pat_last_name}
          </li>
        ))}
      </ul>
      <ul aria-label="Notifications">
        {notifications.data?.map((notification) => (
          <li key={notification.notification_id}>{notification.notification_message}</li>
        ))}
      </ul>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  )
}

function Screen() {
  const { status } = useAuth()
  return status.state === 'signed-in' ? (
    <>
      <h1>{status.user.displayName}</h1>
      <Records />
    </>
  ) : (
    <p>Status: {status.state}</p>
  )
}

/** The tab's one QueryClient, as the providers created it. */
let cache: QueryClient

function CacheProbe() {
  const client = useQueryClient()
  useEffect(() => {
    cache = client
  }, [client])
  return null
}

function renderTab() {
  return render(
    <AppProviders>
      <CacheProbe />
      <Screen />
    </AppProviders>,
  )
}

function sessionFor(userId: string): Session {
  return {
    user: { id: userId, email: ACCOUNTS[userId]!.email, app_metadata: {} },
  }
}

async function signIn(userId: string) {
  auth.session = sessionFor(userId)
  await act(async () => auth.emit('SIGNED_IN'))
}

/** Everything in the cache that came from, or is filed under, account A. */
function cachedForA() {
  return cache
    .getQueryCache()
    .getAll()
    .filter(
      (query) =>
        query.queryKey.includes('u-a') ||
        JSON.stringify(query.state.data ?? null).includes('Alice'),
    )
}

async function answerAll() {
  const answering = server.pending.splice(0)
  await act(async () => {
    for (const request of answering) request.answer()
  })
}

beforeEach(() => {
  auth.session = sessionFor('u-a')
  auth.heldProfile = null
  server.pending.length = 0
  server.hold = false
  fetchMyPatients.mockClear()
  fetchNotifications.mockClear()
})

describe('one account signing out and another signing in on the same tab', () => {
  it('shows the next account none of the previous one’s records, and keeps none of them', async () => {
    renderTab()

    await screen.findByRole('heading', { name: 'Dr Ana Reyes' })
    expect(await screen.findByText('Alice Santos')).toBeInTheDocument()
    expect(await screen.findByText('Alice Santos missed a dose')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByText('Status: signed-out')

    // Gone at sign-out, not merely when the next account arrives.
    expect(cache.getQueryCache().getAll()).toEqual([])

    // B's requests are held open: this is the moment a stale cache would
    // have shown B the previous account's patients.
    server.hold = true
    await signIn('u-b')
    await screen.findByRole('heading', { name: 'Dr Ben Cruz' })

    expect(screen.getByText('Loading patients…')).toBeInTheDocument()
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
    expect(cachedForA()).toEqual([])

    await answerAll()

    expect(await screen.findByText('Bruno Lim')).toBeInTheDocument()
    expect(screen.getByText('Bruno Lim logged a recovery entry')).toBeInTheDocument()
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
    expect(cachedForA()).toEqual([])
  })

  it('drops a response the previous account was still waiting for', async () => {
    server.hold = true
    renderTab()
    await screen.findByRole('heading', { name: 'Dr Ana Reyes' })
    expect(server.pending).toHaveLength(2)
    const forA = server.pending.splice(0)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByText('Status: signed-out')

    server.hold = false
    await signIn('u-b')
    expect(await screen.findByText('Bruno Lim')).toBeInTheDocument()

    // A's answers arrive late, after B is already on screen.
    await act(async () => {
      for (const request of forA) request.answer()
    })

    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
    expect(cachedForA()).toEqual([])
  })

  it('takes the previous account off screen at once when another signs in without a sign-out', async () => {
    // Another tab signed in as someone else; this one hears SIGNED_IN for B
    // while A's screen is still up.
    renderTab()
    expect(await screen.findByText('Alice Santos')).toBeInTheDocument()

    auth.heldProfile = { userId: 'u-b', release: () => {} }
    await signIn('u-b')

    // B's profile has not loaded yet, and A is already gone.
    expect(screen.getByText('Status: loading')).toBeInTheDocument()
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
    expect(cache.getQueryCache().getAll()).toEqual([])

    await act(async () => auth.heldProfile!.release())

    await screen.findByRole('heading', { name: 'Dr Ben Cruz' })
    expect(await screen.findByText('Bruno Lim')).toBeInTheDocument()
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
    expect(cachedForA()).toEqual([])
  })

  it('keeps the cache when the same account’s session is re-read', async () => {
    // Recording consent or a profile change re-reads the session for the
    // same person. Emptying the cache then would refetch every screen for
    // nothing.
    renderTab()
    expect(await screen.findByText('Alice Santos')).toBeInTheDocument()

    await act(async () => auth.emit('USER_UPDATED'))

    expect(screen.getByText('Alice Santos')).toBeInTheDocument()
    expect(fetchMyPatients).toHaveBeenCalledTimes(1)
  })
})

describe('query keys name the account they were fetched for', () => {
  it('never serves one account an entry filed under another’s key', async () => {
    // The second defence, on its own: even if something did reach the cache
    // for A after the clear, B's screens ask for B's keys and cannot read it.
    auth.session = sessionFor('u-b')
    renderTab()
    expect(await screen.findByText('Bruno Lim')).toBeInTheDocument()

    act(() => {
      cache.setQueryData(queryKeysFor('u-a').patients.list(), PATIENTS['u-a'])
      cache.setQueryData(
        queryKeysFor('u-a').notifications.list(),
        NOTIFICATIONS['u-a'],
      )
    })

    expect(queryKeysFor('u-a').patients.list()).not.toEqual(
      queryKeysFor('u-b').patients.list(),
    )
    expect(screen.getByText('Bruno Lim')).toBeInTheDocument()
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument()
  })
})
