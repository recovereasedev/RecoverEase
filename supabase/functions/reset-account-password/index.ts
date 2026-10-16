import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import { AuthError, requireCaller, serviceClient, writeAuditLog } from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { generateTemporaryPassword } from '../_shared/credentials.ts'
import { resetAccountPassword, type ResetRequest, type ResetStore } from './handler.ts'

/**
 * Reissues the temporary credential for an account that cannot sign in.
 *
 * A temporary password is shown once, at creation. If it is lost before the
 * holder signs in, the account is unreachable: outbound email is not
 * configured, so "forgot password" cannot help either. This is the reset the
 * creation panel promises.
 *
 * A Clinic Admin resets a doctor in their own clinic; a doctor resets their
 * own patient. The rules live in `handler.ts`; this file is the HTTP shell
 * and the Supabase calls.
 *
 * Deploy only once migration 29 is applied: a doctor's clinic is read from
 * `doctor.clinic_id`. Deployed earlier, a doctor reset is refused before
 * anything changes, and a patient reset works as before.
 *
 * Deploy:
 *   supabase functions deploy reset-account-password
 */

function resetStore(admin: SupabaseClient): ResetStore {
  return {
    async clinicOfAdmin(userId) {
      const { data, error } = await admin
        .from('admin')
        .select('clinic_id')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data?.clinic_id as string | null | undefined) ?? null
    },

    async doctorById(docId) {
      const { data, error } = await admin
        .from('doctor')
        .select('doc_id, user_id, clinic_id')
        .eq('doc_id', docId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data
        ? {
            docId: data.doc_id as string,
            userId: data.user_id as string,
            clinicId: data.clinic_id as string,
          }
        : null
    },

    async doctorOf(userId) {
      const { data, error } = await admin
        .from('doctor')
        .select('doc_id, doc_is_active')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data
        ? { docId: data.doc_id as string, isActive: data.doc_is_active as boolean }
        : null
    },

    async patientById(patId) {
      const { data, error } = await admin
        .from('patient')
        .select('pat_id, user_id, doc_id')
        .eq('pat_id', patId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data
        ? {
            patId: data.pat_id as string,
            userId: data.user_id as string,
            docId: data.doc_id as string,
          }
        : null
    },

    async readAppMetadata(userId) {
      const { data, error } = await admin.auth.admin.getUserById(userId)
      if (error || !data.user) {
        throw new AuthError('That account could not be read', 500)
      }
      return (data.user.app_metadata ?? {}) as Record<string, unknown>
    },

    async setTemporaryPassword(userId, password, appMetadata) {
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password,
        app_metadata: appMetadata,
      })
      if (error) throw new AuthError('That account could not be reset', 400)
    },

    audit: (entry) => writeAuditLog(admin, entry),
  }
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin)
  }

  try {
    const caller = await requireCaller(request)
    const body = (await request.json()) as ResetRequest
    const result = await resetAccountPassword(
      caller,
      body,
      resetStore(serviceClient()),
      generateTemporaryPassword,
    )
    return jsonResponse(result.body, result.status, origin)
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    // The caught value is not logged: a thrown error can quote surrounding
    // state.
    console.error('reset-account-password failed')
    return jsonResponse({ error: 'That account could not be reset' }, 500, origin)
  }
})
