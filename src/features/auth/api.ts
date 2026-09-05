import { supabase } from '@/lib/supabase/client'
import { fullName } from '@/lib/utils'

import type { AppUser, AuthStatus } from './types'

/**
 * Resolves an authenticated Supabase user into an application user.
 *
 * Every branch that cannot produce a usable session returns a `blocked`
 * status naming the reason, rather than throwing or silently signing the user
 * out. A doctor whose account was deactivated deserves to be told that, not
 * dropped back at the login form to try their password again.
 */
export async function loadAppUser(
  userId: string,
  email: string,
  mustChangePassword = false,
): Promise<AuthStatus> {
  const { data: account, error: accountError } = await supabase
    .from('user_account')
    .select('user_id, user_email, user_role')
    .eq('user_id', userId)
    .maybeSingle()

  if (accountError) {
    return { state: 'error', error: accountError }
  }

  if (!account) {
    // Authenticated against Supabase Auth, but never provisioned in the
    // application. RecoverEase has no self-registration, so this means an
    // administrator or doctor started creating the account and it did not
    // complete.
    return { state: 'blocked', problem: { kind: 'not-provisioned' } }
  }

  const base = {
    userId: account.user_id,
    email: account.user_email || email,
    role: account.user_role,
    mustChangePassword,
  }

  switch (account.user_role) {
    case 'patient': {
      const { data: patient, error } = await supabase
        .from('patient')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (error) return { state: 'error', error }
      if (!patient) {
        return {
          state: 'blocked',
          problem: { kind: 'profile-missing', role: 'patient' },
        }
      }

      return {
        state: 'signed-in',
        user: {
          ...base,
          role: 'patient',
          displayName: fullName(patient.pat_first_name, patient.pat_last_name),
          profile: { kind: 'patient', patient },
        } satisfies AppUser,
      }
    }

    case 'doctor': {
      const { data: doctor, error } = await supabase
        .from('doctor')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (error) return { state: 'error', error }
      if (!doctor) {
        return {
          state: 'blocked',
          problem: { kind: 'profile-missing', role: 'doctor' },
        }
      }

      // The database already denies a deactivated doctor every patient row.
      // Catching it here turns a confusing empty dashboard into an
      // explanation. This is presentation, not enforcement — the RLS policies
      // remain the actual control.
      if (!doctor.doc_is_active) {
        return { state: 'blocked', problem: { kind: 'doctor-deactivated' } }
      }

      return {
        state: 'signed-in',
        user: {
          ...base,
          role: 'doctor',
          displayName: `Dr ${fullName(doctor.doc_first_name, doctor.doc_last_name)}`,
          profile: { kind: 'doctor', doctor },
        } satisfies AppUser,
      }
    }

    case 'admin': {
      const { data: admin, error } = await supabase
        .from('admin')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (error) return { state: 'error', error }
      if (!admin) {
        return {
          state: 'blocked',
          problem: { kind: 'profile-missing', role: 'admin' },
        }
      }

      return {
        state: 'signed-in',
        user: {
          ...base,
          role: 'admin',
          displayName: fullName(admin.admin_first_name, admin.admin_last_name),
          profile: { kind: 'admin', admin },
        } satisfies AppUser,
      }
    }
  }
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (error) {
    throw error
  }
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
    { redirectTo: `${window.location.origin}/reset-password` },
  )
  if (error) throw error
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

/** Module 1.5: records the patient's data privacy consent. */
export async function recordPrivacyConsent(patientId: string): Promise<void> {
  const { error } = await supabase
    .from('patient')
    .update({ pat_consent_at: new Date().toISOString() })
    .eq('pat_id', patientId)

  if (error) throw error
}

/** Whether the account is still signed in once its password has changed. */
export type PasswordSetupOutcome = { signedIn: boolean }

/**
 * Completes the forced password change for an account still holding the
 * temporary credential it was created with.
 *
 * This goes through an Edge Function rather than `supabase.auth.updateUser`
 * because the requirement lives in `app_metadata`, which only the
 * service-role key may clear. Doing both in one server call also means the
 * password and the requirement cannot end up disagreeing.
 *
 * The session is then re-established by signing in again, not by refreshing.
 * A service-role password change revokes the account's refresh tokens — every
 * one of them, deliberately, so that a second browser still holding the
 * temporary credential is put out at the same moment. The previous version
 * called `refreshSession()` immediately afterwards with a token the server
 * had just revoked, so it failed every single time and told the account
 * holder to sign in again the instant they had finished setting up. The
 * revocation is worth keeping; reusing a revoked token is not.
 *
 * Signing in again is the strongest possible re-authentication: it is a full
 * password grant for the same account, using the password the person typed a
 * moment ago and nothing else. The identity comes from the verified session
 * that existed before the change, never from user input, so this cannot be
 * steered at another account.
 */
export async function completePasswordSetup(
  password: string,
): Promise<PasswordSetupOutcome> {
  // Read before the change: afterwards there is no session left to read it
  // from. This is the address Supabase already authenticated, not typed input.
  const {
    data: { session: current },
  } = await supabase.auth.getSession()
  const email = current?.user.email ?? null

  const { data, error } = await supabase.functions.invoke<{ error?: string }>(
    'complete-password-setup',
    { body: { password } },
  )

  if (error) {
    let message = 'Your password could not be changed.'
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: string }
        if (payload?.error) message = payload.error
      } catch {
        // Body was not JSON; keep the generic message.
      }
    }
    throw new Error(message)
  }

  if (data?.error) throw new Error(data.error)

  // Past this point the password IS changed. Nothing below may throw: a
  // failure to re-establish the session is an inconvenience, not a failed
  // password change, and reporting it as one would send the account holder
  // back to try again with a password that no longer exists.
  if (!email) return { signedIn: false }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError) {
    // The tokens still in storage were revoked by the change and every
    // request made with them will fail. Left in place the application still
    // believes it is signed in, so it bounces anyone sent to the sign-in page
    // straight back to a dashboard that cannot load. `local` clears them
    // without a network call, which is the point: there is no live session
    // left to end.
    await supabase.auth.signOut({ scope: 'local' })
    return { signedIn: false }
  }

  return { signedIn: true }
}
