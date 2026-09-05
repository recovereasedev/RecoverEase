import {
  AuthError,
  requireCaller,
  serviceClient,
  writeAuditLog,
} from '../_shared/auth.ts'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'
import { generateTemporaryPassword } from '../_shared/credentials.ts'

/**
 * Reissues the temporary credential for an account that cannot sign in.
 *
 * A temporary password is shown once, at creation. If it is lost before the
 * holder signs in, the account is unreachable: outbound email is not
 * configured, so "forgot password" cannot help either. The success panel
 * already told the creator that the account could be reset — this is that
 * reset, which until now did not exist.
 *
 * Who may reset whom mirrors who may create whom, exactly:
 *
 *   - an administrator resets a DOCTOR    (module 11.2, doctor accounts)
 *   - a doctor resets THEIR OWN PATIENT   (module 2.2, they registered them)
 *
 * There is deliberately no branch that resets an administrator, and none
 * that lets a doctor reach a patient outside their caseload. The target is
 * named by profile id — `doc_id` or `pat_id` — and the auth user is resolved
 * from that row, so a raw `auth.users` id in the payload cannot select a
 * victim.
 *
 * The new password and the re-armed requirement are one `updateUserById`
 * call. Split apart they can half succeed and leave an account with a fresh
 * credential that is not required to be changed, or a requirement with no
 * usable credential.
 *
 * Deploy:
 *   supabase functions deploy reset-account-password
 */

type ResetRequest =
  | { kind: 'doctor'; doctorId: string }
  | { kind: 'patient'; patientId: string }

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
    const body = (await request.json()) as ResetRequest

    if (body.kind !== 'doctor' && body.kind !== 'patient') {
      throw new AuthError('Unknown account kind', 400)
    }

    let targetUserId: string
    let auditEntity: string
    let auditEntityId: string

    if (body.kind === 'doctor') {
      // Doctor accounts belong to administrators, the same as creating them.
      if (caller.role !== 'admin') {
        throw new AuthError(
          'Only an administrator can reset a doctor account',
          403,
        )
      }

      const doctorId = body.doctorId
      if (typeof doctorId !== 'string' || doctorId.trim() === '') {
        throw new AuthError('Which doctor account is this for?', 400)
      }

      const { data: doctor, error } = await admin
        .from('doctor')
        .select('doc_id, user_id')
        .eq('doc_id', doctorId)
        .maybeSingle()

      if (error || !doctor) {
        throw new AuthError('That doctor account could not be found', 404)
      }

      targetUserId = doctor.user_id as string
      auditEntity = 'doctor_account'
      auditEntityId = doctor.doc_id as string
    } else {
      // A patient belongs to the clinician who registered them, so that is
      // who can reissue their credential. An administrator has no clinical
      // access and does not appear here.
      if (caller.role !== 'doctor') {
        throw new AuthError(
          'Only the assigned doctor can reset a patient account',
          403,
        )
      }

      const patientId = body.patientId
      if (typeof patientId !== 'string' || patientId.trim() === '') {
        throw new AuthError('Which patient account is this for?', 400)
      }

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
          'A deactivated account cannot reset patient access',
          403,
        )
      }

      const { data: patient, error } = await admin
        .from('patient')
        .select('pat_id, user_id, doc_id')
        .eq('pat_id', patientId)
        .maybeSingle()

      if (error || !patient) {
        throw new AuthError('That patient could not be found', 404)
      }

      // The assignment is the boundary, checked here rather than trusted from
      // the request: a clinician may only reissue for their own caseload.
      if (patient.doc_id !== doctor.doc_id) {
        throw new AuthError('That patient is not assigned to you', 403)
      }

      targetUserId = patient.user_id as string
      auditEntity = 'patient_account'
      auditEntityId = patient.pat_id as string
    }

    // Read the target's current metadata so the reset preserves everything
    // else Auth holds for them, rather than replacing it wholesale.
    const { data: existing, error: readError } =
      await admin.auth.admin.getUserById(targetUserId)

    if (readError || !existing.user) {
      throw new AuthError('That account could not be read', 500)
    }

    const temporaryPassword = generateTemporaryPassword()

    // One call: the new credential and the renewed requirement move together,
    // and the previous password stops working the moment this succeeds.
    const { error: updateError } = await admin.auth.admin.updateUserById(
      targetUserId,
      {
        password: temporaryPassword,
        app_metadata: {
          ...(existing.user.app_metadata ?? {}),
          must_change_password: true,
        },
      },
    )

    if (updateError) {
      throw new AuthError('That account could not be reset', 400)
    }

    // The password is not in here, and neither is a name or an address. An
    // administrator can read audit_log, and this records only that access was
    // reissued, by whom, and for which profile.
    await writeAuditLog(admin, {
      userId: caller.userId,
      action: 'update',
      entity: auditEntity,
      entityId: auditEntityId,
      details: { reason: 'credential_reset', reset_by_role: caller.role },
    })

    // The only time this value leaves the server.
    return jsonResponse({ temporaryPassword }, 200, origin)
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin)
    }

    // The caught value is not logged: this handler has a generated password
    // in scope and a thrown error can quote surrounding state.
    console.error('reset-account-password failed')
    return jsonResponse({ error: 'That account could not be reset' }, 500, origin)
  }
})
