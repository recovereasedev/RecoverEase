import {
  AuthError,
  failure,
  requireAdminClinic,
  type AuditEntry,
  type Caller,
  type HandlerResult,
} from '../_shared/caller.ts'

/**
 * Who may reissue whose temporary credential - with Supabase behind an
 * interface, so every rule here is unit tested. `index.ts` supplies the real
 * store and the HTTP shell.
 *
 * Who may reset whom mirrors who may create whom, exactly:
 *
 *   - a Clinic Admin resets a DOCTOR in their own clinic (module 11.2)
 *   - a doctor resets THEIR OWN PATIENT (module 2.2, they registered them)
 *
 * There is deliberately no branch that resets an administrator, and none
 * that reaches another clinic or another doctor's caseload. The target is
 * named by profile id and the login is resolved from that row, so a raw
 * `auth.users` id in the payload cannot select a victim. Another clinic's
 * doctor is answered exactly as one that does not exist.
 */

export type ResetRequest =
  | { kind: 'doctor'; doctorId: string }
  | { kind: 'patient'; patientId: string }

export type ResetStore = {
  /** The clinic an administrator runs, or null. Throws if it cannot be read. */
  clinicOfAdmin(userId: string): Promise<string | null>
  /** A doctor by profile id, with their clinic. Throws if it cannot be read. */
  doctorById(docId: string): Promise<{ docId: string; userId: string; clinicId: string } | null>
  /** The caller's own clinician profile, or null. */
  doctorOf(userId: string): Promise<{ docId: string; isActive: boolean } | null>
  patientById(patId: string): Promise<{ patId: string; userId: string; docId: string } | null>
  /** The target's current app_metadata, preserved across the reset. */
  readAppMetadata(userId: string): Promise<Record<string, unknown>>
  /** The new password and the renewed requirement, in one call. */
  setTemporaryPassword(userId: string, password: string, appMetadata: Record<string, unknown>): Promise<void>
  audit(entry: AuditEntry): Promise<void>
}

export async function resetAccountPassword(
  caller: Caller,
  body: ResetRequest,
  store: ResetStore,
  generatePassword: () => string,
): Promise<HandlerResult> {
  try {
    if (body.kind !== 'doctor' && body.kind !== 'patient') {
      throw new AuthError('Unknown account kind', 400)
    }

    let target: { userId: string; entity: string; entityId: string }

    if (body.kind === 'doctor') {
      // Doctor accounts belong to their clinic's administrator, the same as
      // creating them.
      if (caller.role !== 'admin') {
        throw new AuthError('Only an administrator can reset a doctor account', 403)
      }

      const doctorId = body.doctorId
      if (typeof doctorId !== 'string' || doctorId.trim() === '') {
        throw new AuthError('Which doctor account is this for?', 400)
      }

      const clinicId = await requireAdminClinic(store.clinicOfAdmin, caller)

      let doctor: Awaited<ReturnType<ResetStore['doctorById']>>
      try {
        doctor = await store.doctorById(doctorId)
      } catch {
        throw new AuthError(
          'That doctor’s clinic could not be confirmed, so nothing was changed. Try again shortly.',
          503,
        )
      }

      if (!doctor || doctor.clinicId !== clinicId) {
        throw new AuthError('That doctor account could not be found', 404)
      }

      target = { userId: doctor.userId, entity: 'doctor_account', entityId: doctor.docId }
    } else {
      // A patient belongs to the clinician who registered them, so that is
      // who can reissue their credential. An administrator has no clinical
      // access and does not appear here. The patient is in that clinician's
      // clinic by definition.
      if (caller.role !== 'doctor') {
        throw new AuthError('Only the assigned doctor can reset a patient account', 403)
      }

      const patientId = body.patientId
      if (typeof patientId !== 'string' || patientId.trim() === '') {
        throw new AuthError('Which patient account is this for?', 400)
      }

      const doctor = await store.doctorOf(caller.userId).catch(() => null)
      if (!doctor) {
        throw new AuthError('Your clinician profile could not be found', 403)
      }
      if (!doctor.isActive) {
        throw new AuthError('A deactivated account cannot reset patient access', 403)
      }

      const patient = await store.patientById(patientId).catch(() => null)
      if (!patient) {
        throw new AuthError('That patient could not be found', 404)
      }

      // The assignment is the boundary, checked here rather than trusted
      // from the request: a clinician may only reissue for their own caseload.
      if (patient.docId !== doctor.docId) {
        throw new AuthError('That patient is not assigned to you', 403)
      }

      target = { userId: patient.userId, entity: 'patient_account', entityId: patient.patId }
    }

    // Read first, so the reset preserves everything else Auth holds for them.
    const appMetadata = await store.readAppMetadata(target.userId)
    const temporaryPassword = generatePassword()

    // One call: the new credential and the renewed requirement move
    // together, and the previous password stops working the moment it lands.
    await store.setTemporaryPassword(target.userId, temporaryPassword, {
      ...appMetadata,
      must_change_password: true,
    })

    // The password is not in here, and neither is a name or an address. An
    // administrator can read audit_log, and this records only that access
    // was reissued, by whom, and for which profile.
    await store.audit({
      userId: caller.userId,
      action: 'update',
      entity: target.entity,
      entityId: target.entityId,
      details: { reason: 'credential_reset', reset_by_role: caller.role },
    })

    // The only time this value leaves the server.
    return { status: 200, body: { temporaryPassword } }
  } catch (error) {
    // The caught value is not logged: this handler has a generated password
    // in scope and a thrown error can quote surrounding state.
    if (!(error instanceof AuthError)) console.error('reset-account-password failed')
    return failure(error, 'That account could not be reset')
  }
}
