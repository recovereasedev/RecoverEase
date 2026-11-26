// @vitest-environment node
// The OpenAI SDK refuses to run where it sees a browser; the Edge Function
// runs under Deno, which has no DOM, so these tests run in Node.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildSystemInstruction,
  REPLY_FORMAT_NAME,
  toConversationInput,
} from '../../supabase/functions/_shared/assistant'
import {
  forgetRefusedHostedPrompts,
  OPENAI_BASE_URL,
  ProviderError,
  REFUSED_PROMPT_MEMORY_MS,
  ProviderReplyError,
  requestOpenAIReply,
  type OpenAIReplyRequest,
} from '../../supabase/functions/_shared/openai-call'

/**
 * The OpenAI call in `chatbot-reply` (Responses API, official SDK), against a
 * fake `fetch`. Nothing here reaches OpenAI, no key is real, and the
 * "patient" text is invented.
 */

const PATIENT_TEXT = 'Is some swelling normal after the knee operation?'
const turns = toConversationInput([{ chat_message_role: 'patient', chat_message_content: PATIENT_TEXT }])
const instructions = buildSystemInstruction('Clinic guidance')

const GOOD_REPLY = {
  message: 'Some swelling is common; tell your doctor if it gets worse.',
  safety_level: 'caution',
  should_contact_provider: true,
}

/** A Responses API response body. */
const responseBody = (overrides: Record<string, unknown> = {}, text = JSON.stringify(GOOD_REPLY)) => ({
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  ...overrides,
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** An OpenAI error body that quotes the patient, as error prose can. */
const errorBody = (type: string, code: string | null, param: string | null) => ({
  error: { message: `Could not process "${PATIENT_TEXT}"`, type, code, param },
})

type Call = { url: string; body: Record<string, unknown>; authorization: string | null }

function fakeOpenAI(...answers: Array<Response | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      authorization: headers.get('authorization'),
    })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!
    return typeof answer === 'function' ? answer(init ?? {}) : answer.clone()
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function call(
  fetchImpl: typeof fetch,
  overrides: Partial<OpenAIReplyRequest> = {},
  log: string[] = [],
) {
  return requestOpenAIReply({
    apiKey: 'sk-test-not-a-real-key',
    model: 'gpt-test',
    instructions,
    turns,
    timeoutMs: 20_000,
    fetchImpl,
    log: (line) => log.push(line),
    ...overrides,
  })
}

async function failure(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

beforeEach(() => forgetRefusedHostedPrompts())

describe('the request sent to OpenAI', () => {
  it('posts the complete request to the Responses API with the server-side key', async () => {
    const { calls, fetchImpl } = fakeOpenAI(json(200, responseBody()))
    await call(fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0]!.authorization).toBe('Bearer sk-test-not-a-real-key')
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-test',
      instructions,
      input: [{ role: 'user', content: PATIENT_TEXT }],
      store: false,
      text: { format: { type: 'json_schema', name: REPLY_FORMAT_NAME, strict: true } },
    })
  })
})

describe('with and without the hosted prompt', () => {
  it('answers without a hosted prompt, from the code’s instructions alone', async () => {
    const { calls, fetchImpl } = fakeOpenAI(json(200, responseBody()))
    const outcome = await call(fetchImpl, { hostedPrompt: null })

    expect(outcome.reply).toEqual(GOOD_REPLY)
    expect(outcome.usedHostedPrompt).toBe(false)
    expect(calls[0]!.body).not.toHaveProperty('prompt')
  })

  it('adds the hosted prompt when configured, and still sends every instruction', async () => {
    const { calls, fetchImpl } = fakeOpenAI(json(200, responseBody()))
    const outcome = await call(fetchImpl, { hostedPrompt: { id: 'pmpt_test', version: '1' } })

    expect(outcome.usedHostedPrompt).toBe(true)
    expect(calls[0]!.body).toMatchObject({
      prompt: { id: 'pmpt_test', version: '1' },
      instructions,
      text: { format: { strict: true } },
    })
  })

  it.each([
    [404, 'invalid_request_error', 'not_found', 'prompt.id'],
    [400, 'invalid_request_error', 'invalid_value', 'prompt.version'],
    [400, 'invalid_request_error', 'missing_variable', 'prompt.variables'],
  ])(
    'answers without the hosted prompt when OpenAI refuses it (%i %s)',
    async (status, type, code, param) => {
      const log: string[] = []
      const { calls, fetchImpl } = fakeOpenAI(
        json(status, errorBody(type, code, param)),
        json(200, responseBody()),
      )
      const outcome = await call(fetchImpl, { hostedPrompt: { id: 'pmpt_retired', version: '1' } }, log)

      expect(outcome.reply).toEqual(GOOD_REPLY)
      expect(outcome.usedHostedPrompt).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[0]!.body).toHaveProperty('prompt')
      expect(calls[1]!.body).not.toHaveProperty('prompt')
      expect(calls[1]!.body).toMatchObject({ instructions, input: calls[0]!.body.input })
      // The operator can see why, without any of the error's prose.
      expect(log.map((line) => JSON.parse(line))).toContainEqual({
        event: 'openai_hosted_prompt_skipped',
        status,
        type,
        code,
        param,
      })
      expect(log.join('\n')).not.toContain('swelling')
    },
  )

  it.each([401, 403, 429, 500])('does not retry without the prompt after a %i', async (status) => {
    const { calls, fetchImpl } = fakeOpenAI(json(status, errorBody('error', null, null)))
    await failure(call(fetchImpl, { hostedPrompt: { id: 'pmpt_test' } }))
    expect(calls).toHaveLength(1)
  })

  it('does not retry a rejected request that had no hosted prompt', async () => {
    const { calls, fetchImpl } = fakeOpenAI(json(400, errorBody('invalid_request_error', 'invalid_value', 'input')))
    const error = await failure(call(fetchImpl, { hostedPrompt: null }))
    expect(calls).toHaveLength(1)
    expect(error).toMatchObject({ code: 'unavailable', status: 502, providerStatus: 400 })
  })

  it('reports the second failure when the request without the prompt fails too', async () => {
    const { calls, fetchImpl } = fakeOpenAI(
      json(404, errorBody('invalid_request_error', 'not_found', 'prompt.id')),
      json(429, errorBody('rate_limit_error', 'rate_limit_exceeded', null)),
    )
    const error = await failure(call(fetchImpl, { hostedPrompt: { id: 'pmpt_test' } }))
    expect(calls).toHaveLength(2)
    expect(error).toMatchObject({ code: 'busy', status: 429, providerStatus: 429 })
  })
})

describe('a refused hosted prompt', () => {
  it('is left out of later requests for a while, then tried again', async () => {
    let clock = 1_000_000
    const now = () => clock
    const prompt = { id: 'pmpt_retired', version: '1' }
    const { calls, fetchImpl } = fakeOpenAI(
      json(404, errorBody('invalid_request_error', 'not_found', 'prompt.id')),
      json(200, responseBody()),
    )

    await call(fetchImpl, { hostedPrompt: prompt, now })
    expect(calls).toHaveLength(2)

    // Next reply: one request, straight from the code's instructions.
    const second = await call(fetchImpl, { hostedPrompt: prompt, now })
    expect(calls).toHaveLength(3)
    expect(calls[2]!.body).not.toHaveProperty('prompt')
    expect(second.usedHostedPrompt).toBe(false)

    // After the memory lapses the prompt is offered again.
    clock += REFUSED_PROMPT_MEMORY_MS + 1
    await call(fetchImpl, { hostedPrompt: prompt, now })
    expect(calls[3]!.body).toHaveProperty('prompt')
  })

  it('does not affect a different prompt or version', async () => {
    const { calls, fetchImpl } = fakeOpenAI(
      json(404, errorBody('invalid_request_error', 'not_found', 'prompt.id')),
      json(200, responseBody()),
    )
    await call(fetchImpl, { hostedPrompt: { id: 'pmpt_a', version: '1' } })
    await call(fetchImpl, { hostedPrompt: { id: 'pmpt_a', version: '2' } })
    expect(calls[2]!.body).toMatchObject({ prompt: { id: 'pmpt_a', version: '2' } })
  })
})

describe('where requests go', () => {
  const saved = process.env.OPENAI_BASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = saved
  })

  it('is always OpenAI, even if OPENAI_BASE_URL is set in the environment', async () => {
    process.env.OPENAI_BASE_URL = 'https://attacker.example.invalid/v1'
    const { calls, fetchImpl } = fakeOpenAI(json(200, responseBody()))
    await call(fetchImpl)
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')
  })
})

describe('configuration', () => {
  it.each([
    ['no key', { apiKey: undefined }],
    ['an empty key', { apiKey: '' }],
    ['no model', { model: undefined }],
    ['a blank model', { model: '  ' }],
  ])('is not configured with %s, and calls nobody', async (_label, overrides) => {
    const { calls, fetchImpl } = fakeOpenAI(json(200, responseBody()))
    const error = await failure(call(fetchImpl, overrides))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ code: 'not_configured', status: 503 })
    expect(calls).toHaveLength(0)
  })
})

describe('provider failures', () => {
  it.each([
    [401, 'not_configured', 503],
    [403, 'not_configured', 503],
    [429, 'busy', 429],
    [500, 'busy', 429],
    [503, 'busy', 429],
    [400, 'unavailable', 502],
  ])('a %i is reported as %s', async (status, code, replyStatus) => {
    const log: string[] = []
    const { fetchImpl } = fakeOpenAI(json(status, errorBody('some_error', 'some_code', 'input[0].content')))
    const error = await failure(call(fetchImpl, {}, log))
    expect(error).toMatchObject({ code, status: replyStatus, providerStatus: status })
    // Machine-readable fields only: never the message, which quotes the patient.
    expect(log.map((line) => JSON.parse(line))).toContainEqual({
      event: 'openai_error',
      status,
      error_type: 'some_error',
      error_code: 'some_code',
      param: 'input[0].content',
    })
    expect(log.join('\n')).not.toContain('swelling')
  })

  it('times out when OpenAI never answers', async () => {
    const { fetchImpl } = fakeOpenAI(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const error = await failure(call(fetchImpl, { timeoutMs: 50 }))
    expect(error).toMatchObject({ code: 'timeout', status: 504 })
  })

  it('times out when OpenAI sends headers and then stalls', async () => {
    const { fetchImpl } = fakeOpenAI(async (init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'))
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation timed out.', 'TimeoutError')),
          )
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const error = await failure(call(fetchImpl, { timeoutMs: 80 }))
    expect(error).toMatchObject({ code: 'timeout', status: 504, providerStatus: 200 })
  })

  it('is unavailable when OpenAI cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const error = await failure(call(fetchImpl))
    expect(error).toMatchObject({ code: 'unavailable', status: 503 })
  })
})

describe('replies that cannot be trusted', () => {
  it.each([
    ['an incomplete response', responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })],
    ['a failed response', responseBody({ status: 'failed' })],
    ['a response with no output', responseBody({ output: [] })],
    ['a refusal', responseBody({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }] })],
    ['output that is not JSON', responseBody({}, 'Sure! Take two tablets.')],
    ['an invalid safety level', responseBody({}, JSON.stringify({ ...GOOD_REPLY, safety_level: 'fine' }))],
    ['a missing field', responseBody({}, JSON.stringify({ message: 'Hi', safety_level: 'normal' }))],
    ['an empty message', responseBody({}, JSON.stringify({ ...GOOD_REPLY, message: '' }))],
  ])('refuses %s', async (_label, body) => {
    const { fetchImpl } = fakeOpenAI(json(200, body))
    const error = await failure(call(fetchImpl))
    expect(error).toBeInstanceOf(ProviderReplyError)
    expect((error as ProviderReplyError).providerStatus).toBe(200)
  })

  it('refuses a body that is not JSON at all', async () => {
    const { fetchImpl } = fakeOpenAI(new Response('<html>gateway</html>', { status: 200 }))
    expect(await failure(call(fetchImpl))).toBeInstanceOf(ProviderReplyError)
  })

  it('returns a valid reply with its sizes and timings', async () => {
    const { fetchImpl } = fakeOpenAI(json(200, responseBody()))
    const outcome = await call(fetchImpl)
    expect(outcome.providerStatus).toBe(200)
    expect(outcome.responseBytes).toBeGreaterThan(0)
    expect(outcome.requestBytes).toBeGreaterThan(instructions.length)
    expect(outcome.timings.headersMs).not.toBeNull()
    expect(outcome.timings.validationMs).not.toBeNull()
  })
})
