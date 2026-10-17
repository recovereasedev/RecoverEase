import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  AuthError,
  callerClient,
  requireCaller,
  serviceClient,
  writeAuditLog,
} from '../_shared/auth.ts'
import { corsHeaders, handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { generateTemporaryPassword, generateUnusablePassword } from '../_shared/credentials.ts'
import {
  createAccount,
  refusalFromDatabase,
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
 * A Super Admin adds Clinic Admins here too (migration 33). That path asks
 * the database as the Super Admin, with their own token, so the database
 * confirms their session was verified with an authenticator app. Deployed
 * before migration 33, it is refused before any login is created.
 *
 * Deploy:
 *   supabase functions deploy create-account
 *   supabase secrets set ALLOWED_ORIGINS="https://your-app.vercel.app"
 */

function accountStore(
  admin: SupabaseClient,
  asCaller: SupabaseClient,
  origin: string | null,
): AccountStore {
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

    async checkClinicForAdmin(clinicId) {
      const { error } = await asCaller.rpc('super_admin_check_clinic_for_admin', {
        target_clinic_id: clinicId,
      })
      if (error) throw refusalFromDatabase(error)
    },

    async createClinicAdminLogin(email, clinicId) {
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        // Never returned or logged. The owner sets their own password with
        // the emailed link; until then the login cannot be used.
        password: generateUnusablePassword(),
        // The link goes to this address, so following it proves it is theirs.
        email_confirm: true,
        // Writable only with the service key. The database attaches only a
        // login marked for exactly this clinic's administrator.
        app_metadata: {
          provisioned_as: 'clinic_admin',
          provisioned_clinic: clinicId,
          must_change_password: false,
        },
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

    async attachClinicAdmin({ userId, clinicId, firstName, lastName }) {
      const { data, error } = await asCaller.rpc('super_admin_attach_clinic_admin', {
        target_user_id: userId,
        target_clinic_id: clinicId,
        first_name: firstName,
        last_name: lastName,
      })
      if (error) throw refusalFromDatabase(error)
      return data as string
    },

    async sendPasswordSetup(email) {
      // Supabase Auth's own password-recovery email, back to the website's
      // existing /reset-password page - on the caller's origin only when it
      // is one of the allowed ones, else the project's Site URL.
      const allowed = corsHeaders(origin)['Access-Control-Allow-Origin']
      const { error } = await asCaller.auth.resetPasswordForEmail(
        email,
        allowed ? { redirectTo: `${allowed}/reset-password` } : undefined,
      )
      if (error) {
        console.error('password setup email was not sent', error.message)
        return false
      }
      return true
    },
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
      accountStore(serviceClient(), callerClient(request), origin),
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
