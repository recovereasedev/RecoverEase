/**
 * Single-use credentials for account onboarding and recovery.
 *
 * Shared so that a password issued by a reset is indistinguishable in
 * strength and shape from one issued at creation. Two copies of this would
 * eventually drift, and the weaker one would decide the security of the
 * system.
 */

/**
 * The alphabet deliberately omits characters that are misread when a
 * credential is handed over in person or over the phone: 0/O, 1/l/I, 5/S,
 * 8/B. Groups of four are separated by hyphens for the same reason.
 */
const TEMPORARY_PASSWORD_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679'

/**
 * A single-use credential for an account that has none it can use.
 *
 * 16 characters drawn with `crypto.getRandomValues` — comfortably above the
 * 12-character policy the application enforces, and unguessable, so an
 * account holding clinical data is never reachable by trying a default. It
 * is returned to the administrator or clinician exactly once, and is never
 * stored by RecoverEase in readable form: Supabase Auth keeps only a hash,
 * and nothing here writes it to a table, an audit entry or a log line.
 */
export function generateTemporaryPassword(): string {
  const bytes = new Uint32Array(16)
  crypto.getRandomValues(bytes)

  const characters = Array.from(
    bytes,
    (value) =>
      TEMPORARY_PASSWORD_ALPHABET[value % TEMPORARY_PASSWORD_ALPHABET.length],
  )

  return [
    characters.slice(0, 4).join(''),
    characters.slice(4, 8).join(''),
    characters.slice(8, 12).join(''),
    characters.slice(12, 16).join(''),
  ].join('-')
}
