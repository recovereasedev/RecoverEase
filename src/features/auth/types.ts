import type { Enums, Tables } from '@/types/database.types'

export type UserRole = Enums<'user_role'>

/**
 * The signed-in principal, resolved from the database.
 *
 * The role is read from `public.user_account`, never from a JWT claim.
 * Supabase's `user_metadata` is writable by the user it describes, so a role
 * taken from there could be set to 'admin' by the account holder. Reading it
 * from a table the user cannot update (see the user_account RLS policies)
 * makes that impossible.
 *
 * The profile is a discriminated union so that `user.profile.doctor` simply
 * does not typecheck unless the role has already been narrowed.
 */
export type AppUser = {
  userId: string
  email: string
  role: UserRole
  displayName: string
  profile: AppProfile
  /**
   * True while the account still holds the temporary password it was created
   * with. Read from Supabase Auth's `app_metadata`, which only the
   * service-role key can write — the same reason the role is not taken from
   * `user_metadata`. A requirement the account holder could switch off is not
   * a requirement.
   */
  mustChangePassword: boolean
}

export type AppProfile =
  | { kind: 'patient'; patient: Tables<'patient'> }
  | { kind: 'doctor'; doctor: Tables<'doctor'> }
  | { kind: 'admin'; admin: Tables<'admin'> }

/**
 * Why a session exists but cannot be used. These are distinct from ordinary
 * errors because each has its own screen and its own way out.
 */
export type AccountProblem =
  /** Authenticated, but no user_account row was provisioned for them. */
  | { kind: 'not-provisioned' }
  /** A doctor whose account an administrator has deactivated (module 11.3). */
  | { kind: 'doctor-deactivated' }
  /** A role row is missing, e.g. a user_account marked doctor with no doctor. */
  | { kind: 'profile-missing'; role: UserRole }

export type AuthStatus =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; user: AppUser }
  | { state: 'blocked'; problem: AccountProblem }
  | { state: 'error'; error: unknown }
