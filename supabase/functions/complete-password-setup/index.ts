import {
  AuthError,
  requireCaller,
  serviceClient,
  writeAuditLog,
} from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'

/**
 * Completes the forced password change for an account created with a
 * temporary credential.
 *
 * Setting the password and clearing the requirement are one
 * `updateUserById` call rather than two steps. Split apart they can half
 * succeed: a new password with the flag still set locks the account holder
 * out of the application behind a screen that no longer accepts their old
 * credential, and a cleared flag with the old password leaves a temporary
 * credential live. One call cannot land halfway, so a failure here changes
 * nothing and is safe to retry.
 *
 * The password is validated again on this side. The browser already checks
 * it, but a client check is a convenience for the person typing, not a
 * control — this endpoint is reachable directly with a valid session.
 *
 * Deploy:
 *   supabase functions deploy complete-password-setup
 */

const MINIMUM_LENGTH = 12

type CompletePasswordSetupRequest = {
  password: unknown
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin)
  }

  const admin = serviceClient()

  try {
    const caller = await requireCaller(request)
    const body = (await request.json()) as CompletePasswordSetupRequest

    const password = body.password
    if (typeof password !== 'string' || password.length < MINIMUM_LENGTH) {
      throw new AuthError(
        `Your new password must be at least ${MINIMUM_LENGTH} characters`,
        400,
      )
    }

    // Read the account rather than trusting the request: this endpoint must
    // not become a way to change a password without knowing the current one.
    // Supabase has already verified the session in `requireCaller`, so the
    // caller holds a valid credential for this account; what is checked here
    // is that the account is genuinely mid-onboarding.
    const { data: existing, error: readError } =
      await admin.auth.admin.getUserById(caller.userId)

    if (readError || !existing.user) {
      throw new AuthError('Your account could not be read', 500)
    }

    const metadata = existing.user.app_metadata ?? {}

    if (metadata.must_change_password !== true) {
      throw new AuthError(
        'This account has already completed its password setup',
        409,
      )
    }

    // One call: the credential and the requirement move together.
    const { error: updateError } = await admin.auth.admin.updateUserById(
      caller.userId,
      {
        password,
        app_metadata: { ...metadata, must_change_password: false },
      },
    )

    if (updateError) {
      // Supabase rejects a password that matches the current one, which is
      // exactly the "you must actually change it" case.
      const lowered = updateError.message.toLowerCase()
      if (
        lowered.includes('should be different') ||
        lowered.includes('same as the old')
      ) {
        throw new AuthError(
          'Choose a password different from the temporary one',
          400,
        )
      }
      throw new AuthError('Your password could not be changed', 400)
    }

    // No password, no token and no email in the entry — an administrator can
    // read audit_log, and this records only that onboarding finished.
    await writeAuditLog(admin, {
      userId: caller.userId,
      action: 'update',
      entity: 'account_password',
      entityId: caller.userId,
      details: { reason: 'initial_password_setup' },
    })

    return jsonResponse({ ok: true }, 200, origin)
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    // Never log the caught value itself here: the request body carries a
    // password, and a thrown parse error can quote its input.
    console.error('complete-password-setup failed')
    return jsonResponse(
      { error: 'Your password could not be changed' },
      500,
      origin,
    )
  }
})
