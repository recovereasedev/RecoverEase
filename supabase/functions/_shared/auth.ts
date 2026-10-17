import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import { AuthError, type AuditEntry, type Caller } from './caller.ts'

// Re-exported so every function keeps importing these from one place.
export { AuthError }
export type { Caller }

/**
 * Identifies the caller of an Edge Function, and gives access to a
 * service-role client for the privileged work that follows.
 *
 * The split matters. The caller is identified by verifying THEIR access token
 * — never by trusting a user id in the request body, which the caller
 * controls. Only after their role has been read from the database does the
 * function switch to the service-role client, which bypasses RLS entirely.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

/** A client that bypasses Row Level Security. Server-side only, always. */
export function serviceClient(): SupabaseClient {
  if (!SERVICE_ROLE_KEY) {
    throw new AuthError('Service role key is not configured', 500)
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * A client that acts as the caller, with their own token. Row Level Security
 * and the database's own caller checks apply to everything it does - which is
 * how a Super Admin operation reaches the database as the Super Admin, so
 * the database itself confirms their verified session (migration 33).
 */
export function callerClient(request: Request): SupabaseClient {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    throw new AuthError('Authentication required')
  }
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * Verifies the bearer token and resolves the caller's role from the database.
 *
 * The role is read from `user_account`, not from the JWT's metadata: metadata
 * is user-writable, so a patient could otherwise present themselves as an
 * administrator to this function.
 */
export async function requireCaller(request: Request): Promise<Caller> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    throw new AuthError('Authentication required')
  }

  const token = authorization.slice('Bearer '.length)

  // Verified against Supabase Auth, so a forged or expired token fails here.
  const {
    data: { user },
    error,
  } = await callerClient(request).auth.getUser(token)

  if (error || !user) {
    throw new AuthError('Your session is not valid. Sign in again.')
  }

  const { data: account, error: accountError } = await serviceClient()
    .from('user_account')
    .select('user_id, user_email, user_role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (accountError) {
    throw new AuthError('Could not verify your account', 500)
  }

  if (!account) {
    throw new AuthError('Your account is not provisioned', 403)
  }

  return {
    userId: account.user_id as string,
    email: account.user_email as string,
    role: account.user_role as Caller['role'],
  }
}

/** Records a privileged action. Failure to log must not fail the action. */
export async function writeAuditLog(
  client: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await client.from('audit_log').insert({
    user_id: entry.userId,
    audit_log_action: entry.action,
    audit_log_entity: entry.entity,
    audit_log_entity_id: entry.entityId,
    audit_log_details: entry.details ?? null,
  })

  if (error) {
    console.error('audit log write failed', error.message)
  }
}
