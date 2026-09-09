import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { errorMessage } from '@/components/feedback/state-view'
import { AuthProvider } from '@/features/auth/auth-context'

/** Exported so the retry policy can be exercised directly in tests. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Clinical data changes on human timescales, not by the second.
        // A minute of freshness avoids refetching a treatment plan every
        // time someone switches browser tabs.
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Read through `errorMessage`, not `instanceof Error`. What the
          // data layer throws is the PostgREST response body — a plain
          // object — so the check below matched nothing and every
          // authorization failure was retried anyway, which is the exact
          // thing this guard exists to prevent.
          const message = errorMessage(error).toLowerCase()

          // Retrying an authorization failure cannot succeed, and turns one
          // clear denial into three slow ones.
          if (
            message.includes('row-level security') ||
            message.includes('permission denied') ||
            message.includes('jwt')
          ) {
            return false
          }

          return failureCount < 2
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function AppProviders({ children }: { children: ReactNode }) {
  // Created in state rather than at module scope so that each test render
  // gets an isolated cache instead of inheriting another test's data.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  )
}
