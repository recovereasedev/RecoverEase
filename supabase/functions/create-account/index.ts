import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  AuthError,
  requireCaller,
  serviceClient,
  writeAuditLog,
} from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { generateTemporaryPassword } from '../_shared/credentials.ts'
import {
  createAccount,
  type AccountStore,
  type CreateAccountRequest,
} from './handler.ts'

/**
 * Account provisioning — modules 1.1, 2.1 and 2.2.
 *
 * RecoverEase has no public sign-up. Administrators create doctor accounts;
 * doctors create patient accounts. Both require `auth.admin.createUser`,
 * which needs the service-role key — so this has to run server-side. Putting
 * that key in the browser would hand every visitor unrestricted access to
 * every table, RLS included.
 *
 * The caller's role is verified against the database before anything is
 * created. A doctor joins the clinic of the administrator who registers them,
 * and a patient is assigned to the doctor who registers them: both are taken
 * from the verified caller, never from the request body. The rules live in
 * `handler.ts`; this file is the HTTP shell and the Supabase calls.
 *
 * Deploy only once migration 29 is applied: a doctor's clinic is read from
 * `admin.clinic_id`. Deployed earlier, registering a doctor is refused before
 * any login is created, and registering a patient works as before.
 *
 * Deploy:
 *   supabase functions deploy create-account
 *   supabase secrets set ALLOWED_ORIGINS="https://your-app.vercel.app"
 */

function accountStore(admin: SupabaseClient): AccountStore {
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

    async createLogin(email, password) {
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        // Confirmed on creation: the account is handed over in person with a
        // temporary credential, so there is no confirmation link to follow.
        // Without this the first sign-in is refused as an unconfirmed email.
        email_confirm: true,
        // `app_metadata` is writable only with the service-role key, unlike
        // `user_metadata`, which the account holder can edit themselves. A
        // password requirement kept in user_metadata could simply be turned
        // off by the person it constrains.
        app_metadata: { must_change_password: true },
      })

      if (error || !created.user) {
        const message = error?.message ?? 'Could not create the account'
        const isDuplicate = message.toLowerCase().includes('already')
        throw new AuthError(
          isDuplicate ? 'An account already exists for that email address' : message,
          isDuplicate ? 409 : 400,
        )
      }
      return created.user.id
    },

    async deleteLogin(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) throw new Error(error.message)
    },

    async insertAccount({ userId, email, role }) {
      const { error } = await admin
        .from('user_account')
        .insert({ user_id: userId, user_email: email, user_role: role })
      if (error) throw new AuthError(error.message, 400)
    },

    async insertDoctor(doctor) {
      const { data, error } = await admin
        .from('doctor')
        .insert({
          user_id: doctor.userId,
          clinic_id: doctor.clinicId,
          doc_first_name: doctor.firstName,
          doc_last_name: doctor.lastName,
          doc_license_no: doctor.licenseNo,
          doc_specialization: doctor.specialization,
          doc_contact_no: doctor.contactNo,
        })
        .select('doc_id')
        .single()
      if (error) throw new AuthError(error.message, 400)
      return data.doc_id as string
    },

    async insertPatient(patient) {
      const { data, error } = await admin
        .from('patient')
        .insert({
          user_id: patient.userId,
          doc_id: patient.docId,
          pat_first_name: patient.firstName,
          pat_last_name: patient.lastName,
          pat_birth_date: patient.birthDate,
          pat_gender: patient.gender,
          pat_contact_no: patient.contactNo,
          pat_address: patient.address,
        })
        .select('pat_id')
        .single()
      if (error) throw new AuthError(error.message, 400)
      return data.pat_id as string
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
    const body = (await request.json()) as CreateAccountRequest
    const result = await createAccount(
      caller,
      body,
      accountStore(serviceClient()),
      generateTemporaryPassword,
    )
    return jsonResponse(result.body, result.status, origin)
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    console.error('create-account failed', error)
    return jsonResponse({ error: 'The account could not be created' }, 500, origin)
  }
})
