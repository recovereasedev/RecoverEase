import { describe, expect, it, vi } from 'vitest'

import {
  buildInteractionRequest,
  GEMINI_API_REVISION,
  GEMINI_ENDPOINT,
  GEMINI_MODEL,
} from '../../supabase/functions/_shared/assistant'
import {
  ProviderError,
  ProviderReplyError,
  requestGeminiReply,
} from '../../supabase/functions/_shared/gemini-call'

/**
 * The Gemini call in `chatbot-reply`, against a fake provider. Nothing here
 * reaches Gemini, and the "patient" text is invented.
 */

const PATIENT_TEXT = 'Is some swelling normal after the operation?'
const KEY = 'test-key-not-real'

const body = buildInteractionRequest({
  systemInstruction: 'test guidance',
  turns: [{ type: 'user_input', content: [{ type: 'text', text: PATIENT_TEXT }] }],
})

const reply = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'Some swelling is common. Contact your care team if it worsens.',
              safety_level: 'normal',
              should_contact_provider: false,
              ...overrides,
            }),
          },
        ],
      },
    ],
  })

const json = (text: string, status = 200) =>
  new Response(text, { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that honours the abort signal, answering after `delayMs`. */
const slowFetch =
  (delayMs: number, answer: () => Response): typeof fetch =>
  (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal!.reason)
      })
    })

/** Headers at once; the body then never finishes until aborted. */
const stallingBodyFetch: typeof fetch = (_input, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"steps":['))
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
        },
      }),
      { status: 200 },
    ),
  )

const call = (fetchImpl: typeof fetch, options: { timeoutMs?: number; apiKey?: string } = {}) => {
  const lines: string[] = []
  const promise = requestGeminiReply({
    apiKey: 'apiKey' in options ? options.apiKey : KEY,
    body,
    timeoutMs: options.timeoutMs ?? 2_000,
    fetchImpl,
    log: (line) => lines.push(line),
  })
  return { promise, lines }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('the request sent to Gemini', () => {
  it('uses the documented endpoint, revision, key header, model, structured output and no storage', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(reply()))
    await call(fetchImpl).promise
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(GEMINI_ENDPOINT)
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe(KEY)
    expect(headers['Api-Revision']).toBe(GEMINI_API_REVISION)
    expect(headers).not.toHaveProperty('Authorization')
    const sent = JSON.parse(init!.body as string)
    expect(sent.model).toBe(GEMINI_MODEL)
    expect(sent.store).toBe(false)
    expect(sent.generation_config).toEqual({ thinking_level: 'low' })
    expect(sent.response_format).toMatchObject({ type: 'text', mime_type: 'application/json' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('a reply', () => {
  it('fast: returns the validated reply with its timings and size', async () => {
    const result = await call(async () => json(reply())).promise
    expect(result.reply.safety_level).toBe('normal')
    expect(result.providerStatus).toBe(200)
    expect(result.responseBytes).toBeGreaterThan(0)
    expect(result.timings.headersMs).toBeGreaterThanOrEqual(0)
    expect(result.timings.bodyMs).toBeGreaterThanOrEqual(0)
    expect(result.timings.validationMs).toBeGreaterThanOrEqual(0)
  })

  it('slow but inside the deadline: is waited for', async () => {
    const result = await call(slowFetch(150, () => json(reply())), { timeoutMs: 1_000 }).promise
    expect(result.reply.message).toContain('swelling')
    expect(result.timings.headersMs).toBeGreaterThanOrEqual(100)
  })

  it('critical: is returned as the model said it, for escalation to act on', async () => {
    const result = await call(async () =>
      json(reply({ safety_level: 'urgent', should_contact_provider: true })),
    ).promise
    expect(result.reply).toMatchObject({ safety_level: 'urgent', should_contact_provider: true })
  })
})

describe('the deadline', () => {
  it('headers that never arrive: a timeout, not unavailable', async () => {
    const { promise, lines } = call(slowFetch(5_000, () => json(reply())), { timeoutMs: 50 })
    const error = await failure(promise)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ code: 'timeout', status: 504, providerStatus: null })
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'gemini_no_response', timed_out: true })
  })

  it('headers on time, then a body that stalls: the same deadline cuts it off', async () => {
    const { promise, lines } = call(stallingBodyFetch, { timeoutMs: 50 })
    const error = await failure(promise)
    expect(error).toMatchObject({ code: 'timeout', status: 504, providerStatus: 200 })
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'gemini_body_failed', timed_out: true })
  })

  it('a connection that fails outright: unavailable, not a timeout', async () => {
    const { promise, lines } = call(async () => {
      throw new TypeError(`error sending request for url (${GEMINI_ENDPOINT}): ${PATIENT_TEXT}`)
    })
    const error = await failure(promise)
    expect(error).toMatchObject({ code: 'unavailable', status: 503 })
    expect(lines.join('\n')).not.toContain('swelling')
    expect(lines.join('\n')).not.toContain('googleapis')
  })
})

describe('provider errors', () => {
  const googleError = (code: number, status: string, reason?: string) =>
    JSON.stringify({
      error: {
        code,
        status,
        message: `Rejected "${PATIENT_TEXT}"`,
        details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [],
      },
    })

  it.each([
    [429, 'RESOURCE_EXHAUSTED'],
    [500, 'INTERNAL'],
    [503, 'UNAVAILABLE'],
  ])('%i: busy, worth trying again', async (status, name) => {
    const { promise, lines } = call(async () => json(googleError(status, name), status))
    const error = await failure(promise)
    expect(error).toMatchObject({ code: 'busy', status: 429, providerStatus: status })
    expect(lines.join('\n')).not.toContain('swelling')
  })

  it('an invalid key: not configured - trying again cannot help', async () => {
    const { promise } = call(async () =>
      json(googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 400),
    )
    expect(await failure(promise)).toMatchObject({ code: 'not_configured', providerStatus: 400 })
  })

  it.each([401, 403])('%i: a restricted or rejected key is not configured', async (status) => {
    const { promise } = call(async () => json(googleError(status, 'PERMISSION_DENIED'), status))
    expect(await failure(promise)).toMatchObject({ code: 'not_configured', providerStatus: status })
  })

  it('a malformed request (400): unavailable, logged by field path only', async () => {
    const { promise, lines } = call(async () => json(googleError(400, 'INVALID_ARGUMENT'), 400))
    expect(await failure(promise)).toMatchObject({ code: 'unavailable', status: 502 })
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'gemini_error', status: 400 })
  })

  it('no key at all: not configured, and Gemini is never called', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const { promise } = call(fetchImpl, { apiKey: undefined })
    expect(await failure(promise)).toMatchObject({ code: 'not_configured', status: 503 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('an answer that cannot be trusted', () => {
  it('a body that is not JSON: an unusable reply', async () => {
    const error = await failure(call(async () => json('<html>oops</html>')).promise)
    expect(error).toBeInstanceOf(ProviderReplyError)
  })

  it('valid JSON that fails the schema: an unusable reply, never a repaired one', async () => {
    const error = await failure(
      call(async () => json(reply({ safety_level: 'fine', should_contact_provider: 'no' }))).promise,
    )
    expect(error).toBeInstanceOf(ProviderReplyError)
  })

  it('an interaction that did not finish (token limit): refused even if its text parses', async () => {
    const truncated = JSON.parse(reply())
    truncated.status = 'incomplete'
    const { promise, lines } = call(async () => json(JSON.stringify(truncated)))
    expect(await failure(promise)).toBeInstanceOf(ProviderReplyError)
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'gemini_unfinished', interaction_status: 'incomplete' })
  })

  it('an empty answer: refused', async () => {
    const error = await failure(call(async () => json(JSON.stringify({ steps: [] }))).promise)
    expect(error).toBeInstanceOf(ProviderReplyError)
  })
})
