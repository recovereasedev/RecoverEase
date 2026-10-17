import type { TestDatabase } from './database'

/**
 * Supabase Auth's side of a Super Admin, written the way GoTrue writes it.
 *
 * Signing in creates an `aal1` session with a `password` AMR claim. Verifying
 * an authenticator-app code raises that same session to `aal2`, records the
 * factor it used in `sessions.factor_id`, adds a `totp` AMR claim, and issues
 * a token whose claims say `aal2` and name the session. The helpers below
 * build each of those pieces separately, so a test can leave any one out -
 * or point it at someone else's.
 */

export type Claims = Record<string, unknown>

/** A Supabase Auth sign-in with no RecoverEase account yet. */
export async function createSignIn(
  database: TestDatabase,
  email: string,
  appMetadata: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await database.asService<{ id: string }>(
    `insert into auth.users (id, email, raw_app_meta_data)
     values (gen_random_uuid(), $1, $2::jsonb) returning id`,
    [email, JSON.stringify(appMetadata)],
  )
  return row!.id
}

/** The approved procedure: a sign-in made a Super Admin by the owner. */
export async function provisionSuperAdmin(
  database: TestDatabase,
  email: string,
): Promise<{ userId: string; superAdminId: string }> {
  const userId = await createSignIn(database, email)
  const [row] = await database.asService<{ id: string }>(
    `select app_private.provision_super_admin($1, 'Sam', 'Platform') as id`,
    [userId],
  )
  return { userId, superAdminId: row!.id }
}

/** An authenticator-app factor, verified unless told otherwise. */
export async function enrolTotp(
  database: TestDatabase,
  userId: string,
  status: 'verified' | 'unverified' = 'verified',
): Promise<string> {
  const [row] = await database.asService<{ id: string }>(
    `insert into auth.mfa_factors (user_id, friendly_name, factor_type, status)
     values ($1, 'Authenticator', 'totp', $2::auth.factor_status) returning id`,
    [userId, status],
  )
  return row!.id
}

export type SessionShape = {
  /** The session's own assurance level. */
  aal?: 'aal1' | 'aal2'
  /** The factor recorded as having raised it. */
  factorId?: string | null
  /** Its AMR claims, in order. */
  methods?: string[]
  /** When it stops being valid; null for never. */
  notAfter?: string | null
}

/** A session in auth.sessions, with its AMR claims. */
export async function openSession(
  database: TestDatabase,
  userId: string,
  shape: SessionShape = {},
): Promise<string> {
  const [row] = await database.asService<{ id: string }>(
    `insert into auth.sessions (user_id, aal, factor_id, not_after)
     values ($1, $2::auth.aal_level, $3, $4::timestamptz) returning id`,
    [userId, shape.aal ?? 'aal1', shape.factorId ?? null, shape.notAfter ?? null],
  )
  for (const method of shape.methods ?? ['password']) {
    await database.asService(
      `insert into auth.mfa_amr_claims (session_id, authentication_method) values ($1, $2)`,
      [row!.id, method],
    )
  }
  return row!.id
}

/** The claims of a token for that session, as PostgREST would set them. */
export function claimsFor(userId: string, sessionId: string | null, aal: 'aal1' | 'aal2' = 'aal2'): Claims {
  return {
    sub: userId,
    role: 'authenticated',
    aal,
    ...(sessionId === null ? {} : { session_id: sessionId }),
  }
}

/** Someone signed in with a password and then an authenticator-app code. */
export async function verifiedSession(database: TestDatabase, userId: string): Promise<Claims> {
  const factorId = await enrolTotp(database, userId)
  const sessionId = await openSession(database, userId, {
    aal: 'aal2',
    factorId,
    methods: ['password', 'totp'],
  })
  return claimsFor(userId, sessionId)
}

/** A Super Admin, provisioned and in a fully verified session. */
export async function assuredSuperAdmin(
  database: TestDatabase,
  email = 'super.admin@platform.test',
): Promise<{ userId: string; superAdminId: string; claims: Claims }> {
  const { userId, superAdminId } = await provisionSuperAdmin(database, email)
  return { userId, superAdminId, claims: await verifiedSession(database, userId) }
}
