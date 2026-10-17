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
 *
 * A Super Admin adds Clinic Admins (kind `clinic_admin`, migration 33). The
 * database decides that one, as the Super Admin, with their own token: it
 * confirms their verified session and the clinic before the login exists,
 * and makes the account and profile in one transaction after. Unlike the
 * other two, no password is handed over: the login has a password nobody is
 * told, and the new Clinic Admin sets their own through the emailed link.
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
  | {
      kind: 'clinic_admin'
      email: string
      firstName: string
      lastName: string
      /** The clinic they will administer; the database checks it exists and is active. */
      clinicId: string
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
  /**
   * As the caller: may they add a Clinic Admin to this clinic? Throws the
   * database's refusal as an AuthError.
   */
  checkClinicForAdmin(clinicId: string): Promise<void>
  /**
   * A login with a password nobody is told, marked in its app_metadata as
   * made for this clinic's administrator. Throws an AuthError (409 for a
   * taken email).
   */
  createClinicAdminLogin(email: string, clinicId: string): Promise<string>
  /**
   * As the caller: the Clinic Admin's account and profile, in one
   * transaction. Returns the new admin id; throws the database's refusal.
   */
  attachClinicAdmin(admin: {
    userId: string
    clinicId: string
    firstName: string
    lastName: string
  }): Promise<string>
  /** Sends the email with the link to set a password. False if it was not sent. */
  sendPasswordSetup(email: string): Promise<boolean>
}

/** A database refusal, as PostgREST reports it. */
export type DatabaseError = { code?: string; message?: string }

/**
 * The status for each refusal the Super Admin functions raise. Their
 * messages are written for the person reading them; anything else - the
 * function missing because migration 33 is not applied, a connection
 * failure - gets a plain message and fails closed.
 */
const REFUSALS: Record<string, number> = {
  '42501': 403, // insufficient_privilege: not a Super Admin in a verified session
  P0002: 404, // no_data_found: no such clinic or login
  '55000': 409, // object_not_in_prerequisite_state: the clinic is inactive
  '23505': 409, // unique_violation: the login already has an account
  '23514': 400, // check_violation: a missing or overlong name
}

export function refusalFromDatabase(error: DatabaseError): AuthError {
  const status = error.code ? REFUSALS[error.code] : undefined
  if (status && error.message) return new AuthError(error.message, status)
  return new AuthError('Clinic Admins cannot be added right now. Nothing was created.', 503)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/**
 * A Super Admin adds a Clinic Admin. The role is always Clinic Admin - the
 * request has no say in it - and the clinic is the one the database confirms.
 */
async function provisionClinicAdmin(
  caller: Caller,
  body: Extract<CreateAccountRequest, { kind: 'clinic_admin' }>,
  store: AccountStore,
): Promise<HandlerResult> {
  if (caller.role !== 'super_admin') {
    throw new AuthError('Only a Super Admin can add a Clinic Admin', 403)
  }

  const email = assertEmail(body.email)
  const firstName = assertNonEmpty(body.firstName, 'First name')
  const lastName = assertNonEmpty(body.lastName, 'Last name')
  if (typeof body.clinicId !== 'string' || !UUID.test(body.clinicId)) {
    throw new AuthError('Choose the clinic they will administer', 400)
  }
  const clinicId = body.clinicId.toLowerCase()

  // The verified session and the clinic, before any login exists.
  await store.checkClinicForAdmin(clinicId)

  const userId = await store.createClinicAdminLogin(email, clinicId)
  let adminId: string
  try {
    adminId = await store.attachClinicAdmin({ userId, clinicId, firstName, lastName })
  } catch (error) {
    // Nothing was made in the database; remove the login too, or the email
    // stays taken by a sign-in with nothing behind it.
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

  // The account exists either way; if the email did not go, the new Clinic
  // Admin can ask for it again from the sign-in page ("Forgot password").
  const setupEmailSent = await store.sendPasswordSetup(email).catch(() => false)

  // No password, link or token: there is none to hand over.
  return { status: 201, body: { userId, profileId: adminId, clinicId, setupEmailSent } }
}

export async function createAccount(
  caller: Caller,
  body: CreateAccountRequest,
  store: AccountStore,
  generatePassword: () => string,
): Promise<HandlerResult> {
  try {
    if (body.kind === 'clinic_admin') {
      return await provisionClinicAdmin(caller, body, store)
    }

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
