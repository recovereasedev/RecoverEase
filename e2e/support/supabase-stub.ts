import type { Page, Route } from '@playwright/test'

/**
 * A PostgREST-shaped stub for the Supabase endpoints the app calls.
 *
 * These tests exercise the real browser, the real router, the real guards and
 * the real query layer. What they deliberately do NOT exercise is Row Level
 * Security — that is enforced in PostgreSQL and is covered by the 78 database
 * tests, which run the actual migrations and issue real queries as real
 * principals.
 *
 * The division matters and is not a shortcut: pointing a browser at a stub
 * proves the interface behaves; pointing SQL at Postgres proves the data is
 * protected. Testing authorization through a stub would only prove the stub
 * agrees with itself.
 */

export type TableRows = Record<string, Record<string, unknown>[]>

export type StubSession = {
  userId: string
  email: string
  /**
   * Mirrors Supabase Auth's `app_metadata.must_change_password`, set when an
   * account is created with a temporary credential. Service-role-only in
   * production, so the app may read it but never write it.
   */
  mustChangePassword?: boolean
  /**
   * The account's authenticator app (Supabase Auth MFA, TOTP), for the
   * Super Admin's console. No factor unless one is given; a session starts at
   * `aal1`, as a password sign-in does.
   */
  mfa?: { verifiedFactor?: boolean; aal?: 'aal1' | 'aal2' }
}

/** A factor as Supabase Auth lists it on the user. */
type StubFactor = {
  id: string
  friendly_name: string
  factor_type: 'totp'
  status: 'verified' | 'unverified'
  created_at: string
  updated_at: string
}

/**
 * The code the stubbed authenticator app shows. Supabase Auth accepts it for
 * any of the account's factors, and refuses every other code.
 */
export const STUB_TOTP_CODE = '123456'

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'is',
  'in',
  'like',
  'ilike',
] as const

/**
 * Primary key per table. Most follow `<table>_id`, but the ERD abbreviates
 * three of them, and guessing from the table name produced `chat_id` for
 * chat_session — which silently broke every insert that read the id back.
 */
const PRIMARY_KEYS: Record<string, string> = {
  user_account: 'user_id',
  patient: 'pat_id',
  doctor: 'doc_id',
}

function primaryKeyOf(table: string): string {
  return PRIMARY_KEYS[table] ?? `${table}_id`
}

/** Reserved PostgREST params that select rows rather than filter them. */
const NON_FILTER_PARAMS = new Set([
  'select',
  'order',
  'limit',
  'offset',
  'on_conflict',
  'columns',
])

function coerce(raw: string): unknown {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function matches(
  row: Record<string, unknown>,
  column: string,
  expression: string,
): boolean {
  const separator = expression.indexOf('.')
  const operator = expression.slice(0, separator)
  const rawValue = expression.slice(separator + 1)

  if (!FILTER_OPERATORS.includes(operator as (typeof FILTER_OPERATORS)[number])) {
    return true
  }

  // Embedded filters such as `medication_schedule.prescription.pat_id` are
  // resolved against the nested object the fixture already carries.
  const value = column
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      row,
    )

  switch (operator) {
    case 'eq':
      return String(value) === rawValue
    case 'neq':
      return String(value) !== rawValue
    case 'is':
      return value === coerce(rawValue)
    case 'in':
      return rawValue
        .replace(/^\(|\)$/g, '')
        .split(',')
        .includes(String(value))
    case 'gt':
      return String(value) > rawValue
    case 'gte':
      return String(value) >= rawValue
    case 'lt':
      return String(value) < rawValue
    case 'lte':
      return String(value) <= rawValue
    default:
      return true
  }
}

export class SupabaseStub {
  private tables: TableRows
  private session: StubSession | null = null
  /**
   * The password the stubbed accounts currently accept.
   *
   * Not a constant, because completing the forced password setup changes it:
   * the app re-authenticates with the password it has just set, and a stub
   * that only ever honoured the original one would reject that and make the
   * fallback look like the normal path.
   */
  private password = 'correct-horse-battery'
  /** Requests the app made, for assertions about what it asked for. */
  readonly requests: string[] = []
  private readonly rpcResults = new Map<string, unknown>()
  private factors: StubFactor[] = []
  private aal: 'aal1' | 'aal2' = 'aal1'

  constructor(tables: TableRows) {
    // Deep copy so a mutation in one test cannot leak into the next.
    this.tables = JSON.parse(JSON.stringify(tables)) as TableRows
  }

  setSession(session: StubSession | null): void {
    this.session = session
  }

  /** The account's factors, as Supabase Auth holds them now. */
  factorsNow(): readonly StubFactor[] {
    return this.factors
  }

  /** Models an account whose password has been changed server-side. */
  setPassword(password: string): void {
    this.password = password
  }

  rowsIn(table: string): Record<string, unknown>[] {
    return this.tables[table] ?? []
  }

  /**
   * The answer to a `.rpc()` call that returns a single value - a count, say
   * - rather than a JSON object. Without one, an RPC answers with the first
   * row seeded under `rpc/<name>`.
   */
  setRpcResult(name: string, value: unknown): void {
    this.rpcResults.set(name, value)
  }

  /**
   * Adds rows the database writes by itself — a trigger's output, which a
   * PostgREST stub cannot derive from the request it was sent.
   */
  addRows(table: string, rows: Record<string, unknown>[]): void {
    this.tables[table] = [...this.rowsIn(table), ...rows]
  }

  async install(page: Page): Promise<void> {
    await page.route('**/auth/v1/**', (route) => this.handleAuth(route))
    await page.route('**/rest/v1/**', (route) => this.handleRest(route))
    // The chatbot Edge Function is unavailable in these runs, which is a
    // supported production state; the UI must say so rather than invent a
    // reply.
    await page.route('**/functions/v1/**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not configured' }),
      }),
    )
  }

  /** Seeds a signed-in session into storage before the app boots. */
  async signInAs(page: Page, session: StubSession): Promise<void> {
    this.setSession(session)
    this.aal = session.mfa?.aal ?? 'aal1'
    this.factors = session.mfa?.verifiedFactor
      ? [
          {
            id: 'f0000000-0000-4000-8000-000000000001',
            friendly_name: '',
            factor_type: 'totp',
            status: 'verified',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]
      : []

    const payload = {
      access_token: this.accessToken(session),
      token_type: 'bearer',
      expires_in: 3600,
      // Far future, so supabase-js does not attempt a refresh mid-test.
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      refresh_token: `stub-refresh-${session.userId}`,
      user: this.authUser(session),
    }

    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string)
      },
      ['recoverease.auth', JSON.stringify(payload)],
    )
  }

  /**
   * A token shaped like Supabase Auth's: supabase-js reads the assurance
   * level and sign-in methods from its claims (`aal`, `amr`). It is not
   * signed - nothing in the browser verifies one; the database does.
   */
  private accessToken(session: StubSession): string {
    const now = Math.floor(Date.now() / 1000)
    const amr = [{ method: 'password', timestamp: now }]
    if (this.aal === 'aal2') amr.push({ method: 'totp', timestamp: now })
    const claims = {
      sub: session.userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: session.email,
      aal: this.aal,
      amr,
      session_id: `5e550000-0000-4000-8000-${session.userId.slice(-12)}`,
      iat: now,
      exp: now + 60 * 60 * 24,
    }
    return [
      base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      base64Url(JSON.stringify(claims)),
      base64Url('stub-signature'),
    ].join('.')
  }

  /** What `super_admin_assured()` answers for this session, as the database would. */
  private isAssured(): boolean {
    return (
      this.aal === 'aal2' &&
      this.factors.some((factor) => factor.status === 'verified')
    )
  }

  private sessionPayload(session: StubSession) {
    return {
      access_token: this.accessToken(session),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      refresh_token: `stub-refresh-${session.userId}`,
      user: this.authUser(session),
    }
  }

  private authUser(session: StubSession) {
    return {
      id: session.userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: session.email,
      email_confirmed_at: '2026-01-01T00:00:00Z',
      app_metadata: {
        provider: 'email',
        must_change_password: session.mustChangePassword === true,
      },
      // Deliberately empty. The app must never read a role from here, and a
      // stub that supplied one could hide a regression that started doing so.
      user_metadata: {},
      factors: this.factors.map((factor) => ({ ...factor })),
      created_at: '2026-01-01T00:00:00Z',
    }
  }

  /**
   * Supabase Auth's MFA endpoints: enrol, challenge, verify and unenrol a
   * TOTP factor. A verified code raises the session to `aal2` and returns
   * the raised session, as Supabase Auth does.
   */
  private async handleFactors(route: Route, url: URL): Promise<void> {
    const request = route.request()
    const method = request.method()
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })

    if (!this.session) {
      await json(401, { error_code: 'no_authorization', msg: 'not signed in' })
      return
    }

    const [, factorId, action] =
      url.pathname.match(/\/factors(?:\/([^/]+))?(?:\/(challenge|verify))?$/) ?? []

    if (method === 'POST' && !factorId) {
      const now = new Date().toISOString()
      const factor: StubFactor = {
        id: crypto.randomUUID(),
        friendly_name: '',
        factor_type: 'totp',
        status: 'unverified',
        created_at: now,
        updated_at: now,
      }
      this.factors = [...this.factors, factor]
      await json(200, {
        id: factor.id,
        type: 'totp',
        friendly_name: '',
        totp: {
          qr_code:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4"/></svg>',
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/RecoverEase:stub?secret=JBSWY3DPEHPK3PXP&issuer=RecoverEase',
        },
      })
      return
    }

    const factor = this.factors.find((candidate) => candidate.id === factorId)
    if (!factor) {
      await json(404, { error_code: 'mfa_factor_not_found', msg: 'Factor not found' })
      return
    }

    if (method === 'DELETE' && !action) {
      this.factors = this.factors.filter((candidate) => candidate.id !== factor.id)
      await json(200, { id: factor.id })
      return
    }

    if (method === 'POST' && action === 'challenge') {
      await json(200, {
        id: crypto.randomUUID(),
        type: 'totp',
        expires_at: Math.floor(Date.now() / 1000) + 300,
      })
      return
    }

    if (method === 'POST' && action === 'verify') {
      const body = JSON.parse(request.postData() ?? '{}') as { code?: string }
      if (body.code !== STUB_TOTP_CODE) {
        await json(422, {
          error_code: 'mfa_verification_failed',
          msg: 'Invalid TOTP code entered',
        })
        return
      }
      factor.status = 'verified'
      this.aal = 'aal2'
      await json(200, this.sessionPayload(this.session))
      return
    }

    await json(405, { msg: 'unsupported' })
  }

  private async handleAuth(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    this.requests.push(`${request.method()} ${url.pathname}`)

    if (/\/factors(\/|$)/.test(url.pathname)) {
      await this.handleFactors(route, url)
      return
    }

    if (url.pathname.endsWith('/token')) {
      const body = JSON.parse(request.postData() ?? '{}') as {
        email?: string
        password?: string
      }

      // A refresh exchanges the existing session for a token minted now, so
      // it must reflect the current account state rather than replaying what
      // was issued at sign-in. The app relies on this to observe a cleared
      // `must_change_password`.
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        if (!this.session) {
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'invalid claim' }),
          })
          return
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(this.sessionPayload(this.session)),
        })
        return
      }

      const account = this.rowsIn('user_account').find(
        (row) => row['user_email'] === body.email?.toLowerCase(),
      )

      // Wrong password, or unknown address, must be indistinguishable.
      if (!account || body.password !== this.password) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Invalid login credentials',
          }),
        })
        return
      }

      const session: StubSession = {
        userId: account['user_id'] as string,
        email: account['user_email'] as string,
      }
      this.setSession(session)
      // A password alone: the session starts at aal1, whatever factors the
      // account has.
      this.aal = 'aal1'

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.sessionPayload(session)),
      })
      return
    }

    if (url.pathname.endsWith('/logout')) {
      this.setSession(null)
      this.aal = 'aal1'
      await route.fulfill({ status: 204, body: '' })
      return
    }

    if (url.pathname.endsWith('/user')) {
      if (!this.session) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'invalid claim' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.authUser(this.session)),
      })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  }

  private async handleRest(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const table = url.pathname.split('/rest/v1/')[1]?.split('?')[0] ?? ''
    const method = request.method()
    this.requests.push(`${method} ${table}`)

    const wantsSingle = (request.headers()['accept'] ?? '').includes(
      'pgrst.object',
    )

    // supabase-js sends .rpc() as POST /rest/v1/rpc/<name>. It is a function
    // call, not an insert, so it must not fall through to the table routing.
    if (table.startsWith('rpc/')) {
      const name = table.slice('rpc/'.length)
      let result: unknown
      if (this.rpcResults.has(name)) {
        result = this.rpcResults.get(name)
      } else if (name === 'super_admin_assured') {
        // The database's answer, from this session: the real one also
        // checks the session, factor and code against Supabase Auth's
        // tables (tests/db/super-admin.test.ts).
        result = this.isAssured()
      } else {
        result = this.rowsIn(table)[0] ?? null
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(result),
      })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      let rows = this.rowsIn(table)

      for (const [key, expression] of url.searchParams.entries()) {
        if (NON_FILTER_PARAMS.has(key)) continue
        rows = rows.filter((row) => matches(row, key, expression))
      }

      const order = url.searchParams.get('order')
      if (order) {
        const [column, direction] = order.split('.')
        rows = [...rows].sort((a, b) => {
          const left = String(a[column as string] ?? '')
          const right = String(b[column as string] ?? '')
          return direction === 'desc'
            ? right.localeCompare(left)
            : left.localeCompare(right)
        })
      }

      if (method === 'HEAD') {
        // Used by the notification bell's exact-count query. The request is
        // cross-origin, so the browser hides `content-range` from the page
        // unless it is exposed — which Supabase does, and without which the
        // bell here would always read zero.
        await route.fulfill({
          status: 200,
          headers: {
            'content-range': `0-${rows.length}/${rows.length}`,
            'access-control-expose-headers': 'content-range',
          },
          body: '',
        })
        return
      }

      if (wantsSingle) {
        if (rows.length === 0) {
          await route.fulfill({
            status: 406,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'PGRST116',
              message: 'No rows found',
            }),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(rows[0]),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rows),
      })
      return
    }

    if (method === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}') as
        | Record<string, unknown>
        | Record<string, unknown>[]
      const incoming = Array.isArray(payload) ? payload : [payload]

      // Postgres refuses a second row under a primary key it already holds,
      // and PostgREST reports it as 409 with the SQLSTATE in `code`. The
      // guidance chat relies on exactly that to never save a message twice.
      const key = primaryKeyOf(table)
      const taken = incoming.find(
        (row) =>
          row[key] !== undefined &&
          this.rowsIn(table).some((existing) => existing[key] === row[key]),
      )
      if (taken) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: '23505',
            message: `duplicate key value violates unique constraint "${table}_pkey"`,
            details: `Key (${key})=(${String(taken[key])}) already exists.`,
            hint: null,
          }),
        })
        return
      }

      const created = incoming.map((row) => ({
        [primaryKeyOf(table)]: crypto.randomUUID(),
        ...this.defaultsFor(table),
        ...row,
      }))

      this.tables[table] = [...this.rowsIn(table), ...created]
      for (const row of created) this.link(table, row)

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(wantsSingle ? created[0] : created),
      })
      return
    }

    if (method === 'PATCH') {
      const changes = JSON.parse(request.postData() ?? '{}') as Record<
        string,
        unknown
      >

      let updated: Record<string, unknown>[] = []
      this.tables[table] = this.rowsIn(table).map((row) => {
        const isMatch = [...url.searchParams.entries()]
          .filter(([key]) => !NON_FILTER_PARAMS.has(key))
          .every(([key, expression]) => matches(row, key, expression))

        if (!isMatch) return row
        const next = { ...row, ...changes }
        updated.push(next)
        return next
      })

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(wantsSingle ? updated[0] : updated),
      })
      return
    }

    if (method === 'DELETE') {
      this.tables[table] = this.rowsIn(table).filter(
        (row) =>
          ![...url.searchParams.entries()]
            .filter(([key]) => !NON_FILTER_PARAMS.has(key))
            .every(([key, expression]) => matches(row, key, expression)),
      )
      await route.fulfill({ status: 204, body: '' })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  }

  /**
   * Attaches a freshly inserted row to the parent it is read through.
   *
   * PostgREST resolves an embedded select (`treatment_plan(*, treatment_goal
   * (*))`) through the foreign key at read time. The fixtures carry those
   * embeds as literal nested objects, so a row inserted during a test would
   * otherwise be invisible to the very query that is meant to show it — and
   * `fetchTreatmentPlans` sorts `plan.treatment_goal`, so a plan created
   * without the key would throw rather than render.
   */
  private link(table: string, row: Record<string, unknown>): void {
    if (table === 'treatment_goal') {
      for (const plan of this.rowsIn('treatment_plan')) {
        if (plan['treatment_plan_id'] !== row['treatment_plan_id']) continue
        const goals = Array.isArray(plan['treatment_goal'])
          ? (plan['treatment_goal'] as Record<string, unknown>[])
          : []
        plan['treatment_goal'] = [...goals, row]
      }
      return
    }

    if (table === 'medication_schedule') {
      // The schedule is read filtered by `prescription.pat_id`, so it needs
      // the prescription hanging off it exactly as the fixture rows do.
      const prescription = this.rowsIn('prescription').find(
        (candidate) =>
          candidate['prescription_id'] === row['prescription_id'],
      )
      if (prescription) row['prescription'] = prescription
    }
  }

  /** Server-side defaults the database would supply on insert. */
  private defaultsFor(table: string): Record<string, unknown> {
    const now = new Date().toISOString()
    switch (table) {
      case 'recovery_log':
        return { recovery_log_created_at: now }
      case 'appointment':
        return {
          appointment_status: 'scheduled',
          appointment_created_at: now,
        }
      case 'reschedule_request':
        return {
          reschedule_request_status: 'pending',
          reschedule_request_responded_at: null,
          reschedule_request_created_at: now,
        }
      case 'doctor_note':
        return { doctor_note_created_at: now }
      case 'treatment_plan':
        return {
          treatment_plan_status: 'active',
          treatment_plan_created_at: now,
          treatment_plan_updated_at: now,
          // The embed the read query expects, empty until goals are added.
          treatment_goal: [],
        }
      case 'treatment_goal':
        return {
          treatment_goal_status: 'pending',
          treatment_goal_created_at: now,
        }
      case 'prescription':
        return {
          prescription_issued_date: now.slice(0, 10),
          prescription_created_at: now,
        }
      case 'medication_schedule':
        return { medication_schedule_created_at: now }
      case 'chat_session':
        return {
          chat_session_started_at: now,
          chat_session_ended_at: null,
          chat_session_has_critical_flag: false,
          chat_session_summary: null,
        }
      case 'chat_message':
        return { chat_message_created_at: now }
      case 'notification':
        return {
          notification_is_read: false,
          notification_created_at: now,
        }
      default:
        return {}
    }
  }
}
