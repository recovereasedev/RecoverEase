import {
  AuthError,
  failure,
  requireAdminClinic,
  type AuditEntry,
  type Caller,
  type HandlerResult,
} from '../_shared/caller.ts'

/**
 * Who may create which account, and in what order - with Supabase behind an
 * interface, so every rule here is unit tested. `index.ts` supplies the real
 * store and the HTTP shell.
 *
 * The order is what keeps a failure from leaving a half-made account:
 * everything that can refuse without side effects (role, input, the caller's
 * clinic or clinician profile) is checked before the login exists. Once it
 * does, any failure removes it again, so the email is never taken by a login
 * with no account behind it.
 */

export type CreateAccountRequest =
  | {
      kind: 'patient'
      email: string
      firstName: string
      lastName: string
      birthDate?: string | null
      gender?: string | null
      contactNo?: string | null
      address?: string | null
    }
  | {
      kind: 'doctor'
      email: string
      firstName: string
      lastName: string
      licenseNo: string
      specialization?: string | null
      contactNo?: string | null
    }

export type AccountStore = {
  /** The clinic an administrator runs, or null. Throws if it cannot be read. */
  clinicOfAdmin(userId: string): Promise<string | null>
  /** The caller's own clinician profile, or null. */
  doctorOf(userId: string): Promise<{ docId: string; isActive: boolean } | null>
  /** Creates the sign-in. Throws an AuthError (409 for a taken email). */
  createLogin(email: string, password: string): Promise<string>
  deleteLogin(userId: string): Promise<void>
  insertAccount(account: { userId: string; email: string; role: 'patient' | 'doctor' }): Promise<void>
  insertDoctor(doctor: {
    userId: string
    clinicId: string
    firstName: string
    lastName: string
    licenseNo: string
    specialization: string | null
    contactNo: string | null
  }): Promise<string>
  insertPatient(patient: {
    userId: string
    docId: string
    firstName: string
    lastName: string
    birthDate: string | null
    gender: string | null
    contactNo: string | null
    address: string | null
  }): Promise<string>
  audit(entry: AuditEntry): Promise<void>
}

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

export async function createAccount(
  caller: Caller,
  body: CreateAccountRequest,
  store: AccountStore,
  generatePassword: () => string,
): Promise<HandlerResult> {
  try {
    if (body.kind !== 'patient' && body.kind !== 'doctor') {
      throw new AuthError('Unknown account kind', 400)
    }

    // Module 2.1 is administrator-only; module 2.2 is doctor-only. Neither
    // role may do the other's job.
    if (body.kind === 'doctor' && caller.role !== 'admin') {
      throw new AuthError('Only an administrator can register a doctor account', 403)
    }
    if (body.kind === 'patient' && caller.role !== 'doctor') {
      throw new AuthError('Only a doctor can register a patient account', 403)
    }

    const email = assertEmail(body.email)
    const firstName = assertNonEmpty(body.firstName, 'First name')
    const lastName = assertNonEmpty(body.lastName, 'Last name')

    // Where the new account belongs, settled before it exists: each branch
    // checks what it needs, then says how its profile is written.
    let insertProfile: (userId: string) => Promise<string>

    if (body.kind === 'doctor') {
      const licenseNo = assertNonEmpty(body.licenseNo, 'Licence number')
      // A doctor joins the clinic of the administrator registering them.
      // Taken from the verified caller, never the request.
      const clinicId = await requireAdminClinic(store.clinicOfAdmin, caller)
      const { specialization, contactNo } = body
      insertProfile = (userId) =>
        store.insertDoctor({
          userId,
          clinicId,
          firstName,
          lastName,
          licenseNo,
          specialization: specialization ?? null,
          contactNo: contactNo ?? null,
        })
    } else {
      // The assigned doctor comes from the verified caller, not the payload.
      // Taking it from the request would let one clinician assign patients
      // to another and gain a read path into their caseload. The patient
      // belongs to that doctor's clinic.
      const doctor = await store.doctorOf(caller.userId).catch(() => null)
      if (!doctor) {
        throw new AuthError('Your clinician profile could not be found', 403)
      }
      if (!doctor.isActive) {
        throw new AuthError('A deactivated account cannot register patients', 403)
      }
      const { birthDate, gender, contactNo, address } = body
      insertProfile = (userId) =>
        store.insertPatient({
          userId,
          docId: doctor.docId,
          firstName,
          lastName,
          birthDate: birthDate ?? null,
          gender: gender ?? null,
          contactNo: contactNo ?? null,
          address: address ?? null,
        })
    }

    const temporaryPassword = generatePassword()
    const userId = await store.createLogin(email, temporaryPassword)

    try {
      await store.insertAccount({ userId, email, role: body.kind })
      const profileId = await insertProfile(userId)

      // No invitation email is sent. Onboarding is credential handover: the
      // creator reads the temporary password to the account holder, who is
      // required to replace it at first sign-in.
      await store.audit({
        userId: caller.userId,
        action: 'create',
        entity: `${body.kind}_account`,
        entityId: profileId,
        // Deliberately no name, email or clinical detail: administrators can
        // read audit_log and must not learn patient identities from it.
        details: { created_by_role: caller.role },
      })

      // The only time this value leaves the server. It is not logged here
      // and must not be persisted by the caller.
      return { status: 201, body: { userId, profileId, temporaryPassword } }
    } catch (error) {
      // The login exists but its account does not, or not completely. Remove
      // it, or the email stays taken by a sign-in with nothing behind it.
      try {
        await store.deleteLogin(userId)
      } catch (cleanupError) {
        console.error(
          'orphan cleanup failed',
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        )
      }
      throw error
    }
  } catch (error) {
    if (!(error instanceof AuthError)) console.error('create-account failed', error)
    return failure(error, 'The account could not be created')
  }
}
