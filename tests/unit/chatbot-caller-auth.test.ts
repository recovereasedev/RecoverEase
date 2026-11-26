import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `requireCaller` (_shared/auth.ts), which chatbot-reply runs before it reads
 * anything: the caller is whoever Supabase Auth says the bearer token
 * belongs to, and their role is read from `user_account`, never from the
 * token or the request. The Supabase client is replaced with a fake; no
 * network is used.
 */

const state = vi.hoisted(() => ({
  getUser: async (_token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> => ({
    data: { user: null },
    error: { message: 'invalid JWT' },
  }),
  account: null as Record<string, unknown> | null,
  accountError: null as unknown,
}))

vi.mock('jsr:@supabase/supabase-js@2', () => ({
  createClient: () => ({
    auth: { getUser: (token: string) => state.getUser(token) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.account, error: state.accountError }),
        }),
      }),
    }),
  }),
}))

// auth.ts uses the Deno global, so it is loaded by a path the type checker
// does not follow; its shape is declared here instead.
type AuthModule = {
  requireCaller(request: Request): Promise<unknown>
  AuthError: new (message: string, status?: number) => Error & { status: number }
}
const AUTH_MODULE = '../../supabase/functions/_shared/auth'
let auth: AuthModule

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: (name: string) => `test-${name.toLowerCase()}` },
  }
  auth = (await import(/* @vite-ignore */ AUTH_MODULE)) as AuthModule
})

beforeEach(() => {
  state.account = null
  state.accountError = null
  state.getUser = async () => ({ data: { user: null }, error: { message: 'invalid JWT' } })
})

const request = (authorization?: string) =>
  new Request('https://example.invalid/functions/v1/chatbot-reply', {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
    body: JSON.stringify({ chatSessionId: 'chat-alice', patientId: 'pat-bob' }),
  })

async function refusal(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    if (error instanceof auth.AuthError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the chatbot caller', () => {
  it('is refused without a token', async () => {
    const error = await refusal(auth.requireCaller(request()))
    expect(error.status).toBe(401)
  })

  it('is refused with something other than a bearer token', async () => {
    expect((await refusal(auth.requireCaller(request('Basic abc')))).status).toBe(401)
  })

  it('is refused with a token Supabase Auth does not accept', async () => {
    const error = await refusal(auth.requireCaller(request('Bearer forged.jwt.token')))
    expect(error.status).toBe(401)
    expect(error.message).toMatch(/not valid/)
  })

  it('is refused when the verified account is not provisioned', async () => {
    state.getUser = async () => ({ data: { user: { id: 'user-ghost' } }, error: null })
    expect((await refusal(auth.requireCaller(request('Bearer good')))).status).toBe(403)
  })

  it('is refused when the account cannot be checked', async () => {
    state.getUser = async () => ({ data: { user: { id: 'user-alice' } }, error: null })
    state.accountError = { message: 'timeout' }
    expect((await refusal(auth.requireCaller(request('Bearer good')))).status).toBe(500)
  })

  it('is the verified account, with its role from the database - not from the request', async () => {
    let checkedToken = ''
    state.getUser = async (token) => {
      checkedToken = token
      return { data: { user: { id: 'user-alice' } }, error: null }
    }
    state.account = { user_id: 'user-alice', user_email: 'alice@example.invalid', user_role: 'patient' }
    expect(await auth.requireCaller(request('Bearer alice-token'))).toEqual({
      userId: 'user-alice',
      email: 'alice@example.invalid',
      role: 'patient',
    })
    expect(checkedToken).toBe('alice-token')
  })
})
