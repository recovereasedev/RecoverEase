import { errorMessage } from '@/components/feedback/state-view'
import { supabase } from '@/lib/supabase/client'

/**
 * The Super Admin's authenticator app (Supabase Auth MFA, TOTP).
 *
 * This decides what the console SHOWS. It is not what protects the platform:
 * every Super Admin function in the database refuses its caller unless
 * Supabase Auth's own records say the current session was raised to `aal2`
 * with the caller's own verified TOTP factor (migration 33,
 * `app_private.require_super_admin`). A browser that skipped everything here
 * would reach the same refusals, and nothing here can grant what the
 * database withholds.
 *
 * Nothing here removes a verified factor. The only factors this code ever
 * removes are the caller's own unfinished enrolments, which cannot be used to
 * sign in. A lost authenticator is replaced by the platform owner after they
 * have confirmed who is asking (docs/security.md) - there is no self-service
 * way round the code.
 */

export type Assurance =
  /** No verified authenticator yet: one has to be set up first. */
  | { step: 'enrol' }
  /** An authenticator is set up, and this session has not entered a code. */
  | { step: 'verify'; factorId: string }
  /** The database accepts this session for Super Admin work. */
  | { step: 'assured' }
  /**
   * The session says `aal2`, but the database does not accept it - for
   * instance it was signed out elsewhere, or raised without an authenticator
   * app. Treated as no access.
   */
  | { step: 'refused' }

/** Where this session stands. Throws when any part of it cannot be read. */
export async function readAssurance(): Promise<Assurance> {
  const { data: factors, error: factorsError } =
    await supabase.auth.mfa.listFactors()
  if (factorsError) throw factorsError

  // `totp` holds verified factors only. An enrolment that was never finished
  // is in `all`, and does not count.
  const authenticator = factors.totp[0]
  if (!authenticator) return { step: 'enrol' }

  const { data: level, error: levelError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (levelError) throw levelError

  if (level.currentLevel !== 'aal2') {
    return { step: 'verify', factorId: authenticator.id }
  }

  // `aal2` in the token is only a claim. The database checks it against the
  // live session, the factor that raised it and the code entered for it.
  const { data: assured, error } = await supabase.rpc('super_admin_assured')
  if (error) throw error

  return assured === true ? { step: 'assured' } : { step: 'refused' }
}

/** An enrolment in progress: shown once, held only on screen. */
export type PendingAuthenticator = {
  factorId: string
  /** An SVG data URL from Supabase Auth, for the authenticator to scan. */
  qrCode: string
  /** The same secret as the QR code, for typing in by hand. */
  setupKey: string
}

/**
 * Starts setting up an authenticator app.
 *
 * Any unfinished enrolment of the caller's is removed first - one left by a
 * closed tab, or by "Start again" - so only the QR code on screen can ever be
 * completed. Verified factors are never touched.
 */
export async function startEnrolment(): Promise<PendingAuthenticator> {
  const { data: factors, error: factorsError } =
    await supabase.auth.mfa.listFactors()
  if (factorsError) throw factorsError

  for (const factor of factors.all) {
    if (factor.factor_type !== 'totp' || factor.status !== 'unverified') {
      continue
    }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
    if (error) throw error
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    // The name the authenticator app lists the account under.
    issuer: 'RecoverEase',
  })
  if (error) throw error

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    setupKey: data.totp.secret,
  }
}

/**
 * Checks a code for a factor: the first code finishes an enrolment, and
 * every later one raises a session to `aal2`. Supabase Auth replaces the
 * session with the raised one when it succeeds.
 *
 * A new challenge is made for every attempt, so one that expired while the
 * code was being typed cannot leave anyone stuck.
 */
export async function verifyAuthenticatorCode(
  factorId: string,
  code: string,
): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code,
  })
  if (error) throw error
}

export type CodeParseResult =
  | { ok: true; code: string }
  | { ok: false; message: string }

/**
 * A six-digit code, as authenticator apps show it. Spaces are dropped, since
 * several apps display the code as "123 456" and copy it that way.
 */
export function parseAuthenticatorCode(input: string): CodeParseResult {
  const code = input.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) {
    return {
      ok: false,
      message: 'Enter the 6-digit code from your authenticator app.',
    }
  }
  return { ok: true, code }
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * What went wrong with an authenticator step, for the person doing it.
 * Supabase Auth's own messages ("Invalid TOTP code entered") are accurate
 * but say nothing about what to do next.
 */
export function describeMfaFailure(error: unknown): string {
  switch (codeOf(error)) {
    case 'mfa_verification_failed':
      return 'That code did not match. Enter the code your authenticator app is showing now - it changes every 30 seconds.'
    case 'mfa_challenge_expired':
      return 'That code took too long to check. Enter the code your authenticator app is showing now.'
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.'
    case 'mfa_factor_not_found':
      return 'This authenticator is no longer set up for your account. Reload the page to set one up again.'
    case 'mfa_totp_enroll_not_enabled':
    case 'mfa_totp_verify_not_enabled':
      return 'Authenticator apps are not switched on for RecoverEase yet. Ask the platform owner to turn them on.'
    case 'too_many_enrolled_mfa_factors':
      return 'Your account has too many authenticators. Ask the platform owner to remove the ones you no longer use.'
  }

  if (statusOf(error) === 429) {
    return 'Too many attempts. Wait a minute, then try again.'
  }

  const message = errorMessage(error).toLowerCase()
  if (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed')
  ) {
    return 'We could not reach RecoverEase. Check your internet connection and try again.'
  }

  return 'That did not work. Please try again.'
}
