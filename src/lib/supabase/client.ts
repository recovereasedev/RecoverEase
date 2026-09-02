import { createClient } from '@supabase/supabase-js'

import { env } from '@/lib/env'
import type { Database } from '@/types/database.types'

/**
 * The single Supabase client for the browser.
 *
 * Typed with the generated `Database`, so `.from('patient').select()` returns
 * real column types and a typo in a column name is a compile error rather
 * than an empty object at runtime.
 *
 * This client authenticates with the publishable key, which carries no
 * privileges of its own: every request is filtered by the Row Level Security
 * policies in supabase/migrations. Operations that genuinely need elevated
 * rights (creating an account, calling the chatbot provider) go through Edge
 * Functions, which hold the service-role key server-side.
 */
export const supabase = createClient<Database>(
  env.VITE_SUPABASE_URL,
  env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      // Keep the session across reloads and refresh it before expiry, so a
      // patient filling in a recovery log is not logged out mid-entry.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'recoverease.auth',
    },
  },
)

export type SupabaseClient = typeof supabase
