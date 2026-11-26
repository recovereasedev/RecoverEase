import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isProviderTimeout,
  providerErrorSummary,
} from '../../supabase/functions/_shared/reply-outcome'

/**
 * How `chatbot-reply` treats a provider that fails after answering: what of
 * an error reaches the log, and how a body that stops arriving is reported.
 */

const PATIENT_TEXT = 'Is some swelling normal after the operation?'

describe('providerErrorSummary', () => {
  it('keeps the status and the machine-readable parts of an OpenAI error', () => {
    expect(
      JSON.parse(
        providerErrorSummary(400, { type: 'invalid_request_error', code: 'invalid_value', param: 'input[1].content' }),
      ),
    ).toEqual({
      event: 'openai_error',
      status: 400,
      error_type: 'invalid_request_error',
      error_code: 'invalid_value',
      param: 'input[1].content',
    })
  })

  it('drops anything that is not shaped like a code or a request path', () => {
    const line = providerErrorSummary(429, {
      type: `Rate limit reached: ${PATIENT_TEXT}`,
      code: 42,
      param: `input[0].content = ${PATIENT_TEXT}`,
    })
    expect(JSON.parse(line)).toEqual({
      event: 'openai_error',
      status: 429,
      error_type: null,
      error_code: null,
      param: null,
    })
    expect(line).not.toContain('swelling')
  })

  it('cannot log a message, even when handed one', () => {
    const line = providerErrorSummary(400, {
      type: 'invalid_request_error',
      ...({ message: `Could not process "${PATIENT_TEXT}"` } as object),
    })
    expect(line).not.toContain('swelling')
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['error_code', 'error_type', 'event', 'param', 'status'])
  })
})

describe('a provider that stalls after its headers', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  })

  it('fails the body read with the time limit’s own error, which counts as a timeout', async () => {
    // Node's fetch. Deno 2.1.4's rejects the same way; that was checked
    // outside this suite, since there is no Deno here.
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"output": [')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    // The time limit starts once the headers are in. Started with the
    // request, it raced the headers themselves, and a busy suite sometimes
    // lost: the request failed before the body read this test is about. The
    // request's signal is aborted with the limit's own reason, as
    // `AbortSignal.timeout` passed to `fetch` aborts it in chatbot-reply.
    const request = new AbortController()
    const response = await fetch(url, { method: 'POST', signal: request.signal })
    expect(response.ok).toBe(true)
    const limit = AbortSignal.timeout(100)
    limit.addEventListener('abort', () => request.abort(limit.reason), { once: true })
    const cause = await response.json().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(cause).toBeDefined()
    // The time limit's own error, not a stand-in for it.
    expect(cause).toBe(limit.reason)
    expect((cause as Error).name).toBe('TimeoutError')
    expect(isProviderTimeout(cause)).toBe(true)
  })
})

// How chatbot-reply reads the provider's body and logs its errors is tested
// against a fake provider in tests/unit/openai-call.test.ts.
