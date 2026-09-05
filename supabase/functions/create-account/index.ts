import {
  AuthError,
  requireCaller,
  serviceClient,
  writeAuditLog,
} from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { generateTemporaryPassword } from '../_shared/credentials.ts'

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
 * created, and a doctor can only ever create a patient assigned to
 * themselves: the assignment is taken from the verified caller, never from
 * the request body.
 *
 * Deploy:
 *   supabase functions deploy create-account
 *   supabase secrets set ALLOWED_ORIGINS="https://your-app.vercel.app"
 */

type CreatePatientRequest = {
  kind: 'patient'
  email: string
  firstName: string
  lastName: string
  birthDate?: string | null
  gender?: string | null
  contactNo?: string | null
  address?: string | null
}

type CreateDoctorRequest = {
  kind: 'doctor'
  email: string
  firstName: string
  lastName: string
  licenseNo: string
  specialization?: string | null
  contactNo?: string | null
}

type CreateAccountRequest = CreatePatientRequest | CreateDoctorRequest

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError(`${field} is required`, 400)
  }
  return value.trim()
}

function assertEmail(value: unknown): string {
  const email = assertNonEmpty(value, 'Email address').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('Enter a valid email address', 400)
  }
  return email
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  const origin = request.headers.get('origin')

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin)
  }

  const admin = serviceClient()
  let createdUserId: string | null = null

  try {
    const caller = await requireCaller(request)
    const body = (await request.json()) as CreateAccountRequest

    if (body.kind !== 'patient' && body.kind !== 'doctor') {
      throw new AuthError('Unknown account kind', 400)
    }

    // Module 2.1 is administrator-only; module 2.2 is doctor-only. Neither
    // role may do the other's job.
    if (body.kind === 'doctor' && caller.role !== 'admin') {
      throw new AuthError(
        'Only an administrator can register a doctor account',
        403,
      )
    }
    if (body.kind === 'patient' && caller.role !== 'doctor') {
      throw new AuthError(
        'Only a doctor can register a patient account',
        403,
      )
    }

    const email = assertEmail(body.email)
    const firstName = assertNonEmpty(body.firstName, 'First name')
    const lastName = assertNonEmpty(body.lastName, 'Last name')

    const temporaryPassword = generateTemporaryPassword()

    // Creating the auth user first means a duplicate email fails before any
    // profile row is written, leaving nothing to clean up.
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password: temporaryPassword,
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

    if (createError || !created.user) {
      const message = createError?.message ?? 'Could not create the account'
      const isDuplicate = message.toLowerCase().includes('already')
      throw new AuthError(
        isDuplicate
          ? 'An account already exists for that email address'
          : message,
        isDuplicate ? 409 : 400,
      )
    }

    createdUserId = created.user.id

    const { error: accountError } = await admin.from('user_account').insert({
      user_id: createdUserId,
      user_email: email,
      user_role: body.kind,
    })
    if (accountError) throw new AuthError(accountError.message, 400)

    let profileId: string

    if (body.kind === 'doctor') {
      const { data, error } = await admin
        .from('doctor')
        .insert({
          user_id: createdUserId,
          doc_first_name: firstName,
          doc_last_name: lastName,
          doc_license_no: assertNonEmpty(body.licenseNo, 'Licence number'),
          doc_specialization: body.specialization ?? null,
          doc_contact_no: body.contactNo ?? null,
        })
        .select('doc_id')
        .single()

      if (error) throw new AuthError(error.message, 400)
      profileId = data.doc_id as string
    } else {
      // The assigned doctor comes from the verified caller, not the payload.
      // Taking it from the request would let one clinician assign patients to
      // another and gain a read path into their caseload.
      const { data: doctor, error: doctorError } = await admin
        .from('doctor')
        .select('doc_id, doc_is_active')
        .eq('user_id', caller.userId)
        .maybeSingle()

      if (doctorError || !doctor) {
        throw new AuthError('Your clinician profile could not be found', 403)
      }
      if (!doctor.doc_is_active) {
        throw new AuthError(
          'A deactivated account cannot register patients',
          403,
        )
      }

      const { data, error } = await admin
        .from('patient')
        .insert({
          user_id: createdUserId,
          doc_id: doctor.doc_id,
          pat_first_name: firstName,
          pat_last_name: lastName,
          pat_birth_date: body.birthDate ?? null,
          pat_gender: body.gender ?? null,
          pat_contact_no: body.contactNo ?? null,
          pat_address: body.address ?? null,
        })
        .select('pat_id')
        .single()

      if (error) throw new AuthError(error.message, 400)
      profileId = data.pat_id as string
    }

    // No invitation email is sent. Onboarding is credential handover: the
    // creator reads the temporary password to the account holder, who is
    // required to replace it at first sign-in. That removes the dependency
    // on outbound email, which the project's Supabase instance cannot
    // deliver reliably, and it means an account is never left unusable
    // because a message did not arrive.

    await writeAuditLog(admin, {
      userId: caller.userId,
      action: 'create',
      entity: `${body.kind}_account`,
      entityId: profileId,
      // Deliberately no name, email or clinical detail: administrators can
      // read audit_log and must not learn patient identities from it.
      details: { created_by_role: caller.role },
    })

    // The only time this value leaves the server. It is not logged here and
    // must not be persisted by the caller.
    return jsonResponse(
      {
        userId: createdUserId,
        profileId,
        temporaryPassword,
      },
      201,
      origin,
    )
  } catch (error) {
    // If a profile insert failed after the auth user was created, remove the
    // orphan. Otherwise the email is taken by an account that can sign in but
    // has no profile, and cannot be re-created.
    if (createdUserId) {
      const { error: cleanupError } =
        await admin.auth.admin.deleteUser(createdUserId)
      if (cleanupError) {
        console.error('orphan cleanup failed', cleanupError.message)
      }
    }

    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    console.error('create-account failed', error)
    return jsonResponse(
      { error: 'The account could not be created' },
      500,
      origin,
    )
  }
})
