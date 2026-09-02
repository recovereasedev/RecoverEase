/**
 * Environment configuration, validated once at module load.
 *
 * An app that boots with a missing Supabase URL and only discovers it when a
 * user tries to sign in has turned a deployment mistake into a runtime
 * mystery. Failing here instead makes it a startup error with a message that
 * names the variable.
 *
 * Deliberately hand-rolled rather than using Zod. This module sits on the
 * critical boot path — the Supabase client imports it — so anything it pulls
 * in is downloaded by every visitor before the landing page paints. Zod is
 * roughly 34 kB gzipped, which is a poor trade for checking that two strings
 * are present. It is still used for form validation, where it earns its
 * place and loads lazily with the forms that need it.
 *
 * Only VITE_-prefixed values exist in the browser bundle, and only
 * publishable credentials are ever put there. The service-role key has no
 * entry here deliberately: it lives in Edge Function secrets, and nothing in
 * `src/` may read it.
 */
export type Env = {
  VITE_SUPABASE_URL: string
  VITE_SUPABASE_PUBLISHABLE_KEY: string
}

function readEnv(): Env {
  const problems: string[] = []

  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

  if (typeof url !== 'string' || url.trim() === '') {
    problems.push('VITE_SUPABASE_URL is required')
  } else {
    try {
      // A malformed URL fails later inside supabase-js with a far more
      // obscure message, so it is worth catching here by name.
      new URL(url)
    } catch {
      problems.push(
        'VITE_SUPABASE_URL must be a valid URL, e.g. https://xyz.supabase.co',
      )
    }
  }

  if (typeof key !== 'string' || key.trim() === '') {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is required')
  }

  if (problems.length > 0) {
    throw new Error(
      `RecoverEase is not configured.\n\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}\n\n` +
        'Copy .env.example to .env.local and fill in the values from your ' +
        'Supabase project settings.',
    )
  }

  return {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_PUBLISHABLE_KEY: key,
  }
}

export const env = readEnv()
