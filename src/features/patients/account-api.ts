import { supabase } from '@/lib/supabase/client'

/**
 * Account provisioning — modules 2.1 and 2.2.
 *
 * These go through the `create-account` Edge Function rather than a direct
 * table insert, because creating an auth user requires the service-role key.
 * That key bypasses Row Level Security entirely, so it can only ever live
 * server-side; a browser holding it would have unrestricted access to every
 * record in the system.
 *
 * The function verifies the caller's role from the database before creating
 * anything, and takes the assigned doctor from the verified caller rather
 * than from the payload.
 */

export type NewPatientInput = {
  email: string
  firstName: string
  lastName: string
  birthDate?: string | null
  gender?: string | null
  contactNo?: string | null
  address?: string | null
}

export type NewDoctorInput = {
  email: string
  firstName: string
  lastName: string
  licenseNo: string
  specialization?: string | null
  contactNo?: string | null
}

export type AccountCreated = {
  userId: string
  profileId: string
  /**
   * The single-use credential the new account was created with, generated
   * server-side and returned exactly once. The holder is required to replace
   * it at first sign-in. Never persist or log this.
   */
  temporaryPassword: string
}

async function invokeCreateAccount(
  body: Record<string, unknown>,
): Promise<AccountCreated> {
  const { data, error } = await supabase.functions.invoke<
    AccountCreated & { error?: string }
  >('create-account', { body })

  if (error) {
    // Edge Function errors carry the useful message in the response body, so
    // read it rather than surfacing a bare "non-2xx status code".
    let message = 'The account could not be created.'
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

  if (!data || data.error) {
    throw new Error(data?.error ?? 'The account could not be created.')
  }

  return data
}

/** Module 2.2 "Register Patient Account" — doctors only. */
export function createPatientAccount(
  input: NewPatientInput,
): Promise<AccountCreated> {
  return invokeCreateAccount({ kind: 'patient', ...input })
}

/** Module 2.1 "Register Doctor Account" — administrators only. */
export function createDoctorAccount(
  input: NewDoctorInput,
): Promise<AccountCreated> {
  return invokeCreateAccount({ kind: 'doctor', ...input })
}

export type CredentialReissued = {
  /**
   * The replacement credential, returned exactly once. The holder must change
   * it at first sign-in. Never persist or log this.
   */
  temporaryPassword: string
}

async function invokeReset(
  body: Record<string, unknown>,
): Promise<CredentialReissued> {
  const { data, error } = await supabase.functions.invoke<
    CredentialReissued & { error?: string }
  >('reset-account-password', { body })

  if (error) {
    let message = 'That account could not be reset.'
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

  if (!data || data.error) {
    throw new Error(data?.error ?? 'That account could not be reset.')
  }

  return data
}

/**
 * Reissues a doctor's temporary credential. Administrators only.
 *
 * The previous password stops working immediately and the account is put
 * back into the first-login password change, so a reissued credential is no
 * more privileged than a freshly created one.
 */
export function resetDoctorPassword(
  doctorId: string,
): Promise<CredentialReissued> {
  return invokeReset({ kind: 'doctor', doctorId })
}

/** Reissues a patient's temporary credential. Their assigned doctor only. */
export function resetPatientPassword(
  patientId: string,
): Promise<CredentialReissued> {
  return invokeReset({ kind: 'patient', patientId })
}
