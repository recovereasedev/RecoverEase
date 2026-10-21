import { useQueryClient } from '@tanstack/react-query'
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
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<AuthStatus>({ state: 'loading' })

  // Whose data the query cache holds: the id of the account it was filled
  // for, or null when it belongs to nobody. The tab keeps one cache for its
  // whole life, and on a shared clinic computer that life spans more than
  // one person: one signs out, the next signs in on the same page. Most
  // keys say what was fetched, not for whom, so a cache carried across that
  // change would show the next person the previous one's records until a
  // refetch replaced them.
  const cacheOwner = useRef<string | null>(null)

  // Every change of status goes through here, and the cache is emptied
  // before a status naming a different account (or none) is committed.
  // Clearing first, in the same tick, means no screen ever renders for one
  // account while the cache still holds another's data. `clear` also
  // cancels fetches still in flight, so a response requested by the
  // previous account is dropped rather than landing in the next one's
  // cache.
  const commit = useCallback(
    (next: AuthStatus) => {
      const owner = next.state === 'signed-in' ? next.user.userId : null
      if (owner !== cacheOwner.current) {
        queryClient.clear()
        cacheOwner.current = owner
      }
      setStatus(next)
    },
    [queryClient],
  )

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
      commit({ state: 'error', error })
      return
    }

    if (!session?.user) {
      commit({ state: 'signed-out' })
      return
    }

    // The session now belongs to someone other than the account on screen:
    // another tab signed in as a different person, say. Stop showing the
    // previous account now rather than for as long as the new profile takes
    // to load. `loading` also unmounts every signed-in screen, so nothing
    // the previous account had open, typed or selected carries over either.
    if (cacheOwner.current !== null && cacheOwner.current !== session.user.id) {
      commit({ state: 'loading' })
    }

    try {
      const resolved = await loadAppUser(
        session.user.id,
        session.user.email ?? '',
        session.user.app_metadata?.must_change_password === true,
      )
      if (sequence !== requestSequence.current) return
      commit(resolved)
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      commit({ state: 'error', error: caught })
    }
  }, [commit])

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
        commit({ state: 'signed-out' })
        return
      }

      void resolveSession()
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [commit, resolveSession])

  const signOut = useCallback(async () => {
    // Clear locally first so the UI never appears signed in after the click,
    // even if the network call is slow or fails. That includes the cache:
    // what this account loaded goes with it, not when the next one arrives.
    requestSequence.current += 1
    commit({ state: 'signed-out' })
    try {
      await signOutRequest()
    } catch {
      // The local session is already gone; a failed server round trip must
      // not strand the user on a screen they can no longer use.
    }
  }, [commit])

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
