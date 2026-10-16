/**
 * The shapes every account function shares, with no Deno or Supabase
 * dependency, so the rules built on them can be unit tested in Node.
 * `auth.ts` resolves a real caller; the handlers decide what that caller may
 * do.
 */

export type Caller = {
  userId: string
  email: string
  role: 'patient' | 'doctor' | 'admin'
}

export class AuthError extends Error {
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.status = status
  }
}

/** A privileged action, as written to the audit log. */
export type AuditEntry = {
  userId: string
  action: string
  entity: string
  entityId: string | null
  details?: Record<string, unknown>
}

/** What a handler answers: the JSON body and its status. */
export type HandlerResult = {
  status: number
  body: Record<string, unknown>
}

/** An expected refusal keeps its own message; anything else gets `fallback`. */
export function failure(error: unknown, fallback: string): HandlerResult {
  if (error instanceof AuthError) {
    return { status: error.status, body: { error: error.message } }
  }
  return { status: 500, body: { error: fallback } }
}

/**
 * The caller's clinic, when they administer one. A lookup that fails - most
 * likely this function deployed before migration 29 added the column - stops
 * the request before anything is created or changed, rather than proceeding
 * without a clinic.
 */
export async function requireAdminClinic(
  clinicOfAdmin: (userId: string) => Promise<string | null>,
  caller: Caller,
): Promise<string> {
  let clinicId: string | null
  try {
    clinicId = await clinicOfAdmin(caller.userId)
  } catch {
    throw new AuthError(
      'Your clinic could not be confirmed, so nothing was changed. Try again shortly.',
      503,
    )
  }

  if (!clinicId) {
    throw new AuthError('Your administrator account is not assigned to a clinic', 403)
  }
  return clinicId
}
