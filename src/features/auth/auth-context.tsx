import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { supabase } from '@/lib/supabase/client'

import { loadAppUser, signOut as signOutRequest } from './api'
import type { AppUser, AuthStatus } from './types'

type AuthContextValue = {
  status: AuthStatus
  /** Convenience: the user, or null when not usably signed in. */
  user: AppUser | null
  signOut: () => Promise<void>
  /** Re-reads the profile, e.g. after the patient records consent. */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>({ state: 'loading' })

  // Auth events can arrive while a profile fetch is still in flight — a
  // token refresh during initial load, for instance. Without a guard the
  // slower response can overwrite the newer one and leave the app showing a
  // stale identity. Each resolution carries a sequence number and only the
  // most recent one is allowed to land.
  const requestSequence = useRef(0)

  const resolveSession = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current

    const {
      data: { session },
      error,
    } = await supabase.auth.getSession()

    if (sequence !== requestSequence.current) return

    if (error) {
      setStatus({ state: 'error', error })
      return
    }

    if (!session?.user) {
      setStatus({ state: 'signed-out' })
      return
    }

    try {
      const resolved = await loadAppUser(
        session.user.id,
        session.user.email ?? '',
      )
      if (sequence !== requestSequence.current) return
      setStatus(resolved)
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      setStatus({ state: 'error', error: caught })
    }
  }, [])

  // This effect exists precisely to synchronise React with an external
  // system: the Supabase Auth session and its event stream. There is no
  // render-time derivation for "who is signed in" — that answer lives
  // outside React and arrives asynchronously.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void resolveSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // TOKEN_REFRESHED fires on a timer and does not change who is signed
      // in. Re-resolving on it would refetch the profile every hour for no
      // reason, and could flash a loading state over a working screen.
      if (event === 'TOKEN_REFRESHED') return

      if (event === 'SIGNED_OUT') {
        requestSequence.current += 1
        setStatus({ state: 'signed-out' })
        return
      }

      void resolveSession()
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [resolveSession])

  const signOut = useCallback(async () => {
    // Clear locally first so the UI never appears signed in after the click,
    // even if the network call is slow or fails.
    requestSequence.current += 1
    setStatus({ state: 'signed-out' })
    try {
      await signOutRequest()
    } catch {
      // The local session is already gone; a failed server round trip must
      // not strand the user on a screen they can no longer use.
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: status.state === 'signed-in' ? status.user : null,
      signOut,
      refresh: resolveSession,
    }),
    [status, signOut, resolveSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside an <AuthProvider>.')
  }
  return context
}

/**
 * The signed-in user, for screens that are already behind a route guard.
 * Throws rather than returning null so a component never has to defensively
 * handle a case the router has already excluded.
 */
export function useCurrentUser(): AppUser {
  const { user } = useAuth()
  if (!user) {
    throw new Error(
      'useCurrentUser was called outside an authenticated route. ' +
        'Wrap the route in <RequireAuth>.',
    )
  }
  return user
}
