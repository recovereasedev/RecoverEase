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
