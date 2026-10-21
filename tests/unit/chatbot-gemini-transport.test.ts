import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildInteractionRequest,
  buildSystemInstruction,
  GEMINI_API_REVISION,
  GEMINI_ENDPOINT,
  GEMINI_MODEL,
  toInteractionInput,
} from '../../supabase/functions/_shared/assistant'
import {
  GEMINI_USER_AGENT,
  geminiClientOptions,
  geminiRequestInit,
  providerClientOnce,
} from '../../supabase/functions/_shared/gemini-transport'
import { isProviderTimeout } from '../../supabase/functions/_shared/reply-outcome'

/**
 * How chatbot-reply reaches Gemini: HTTP/1.1 only, a connection per request,
 * as `node` (_shared/gemini-transport.ts). An experiment for the timeouts,
 * not a proven fix, so what is pinned is that the request is otherwise the
 * one it was, and that a runtime without the client falls back to it.
 *
 * Node's fetch ignores `client`, so nothing here shows what Deno or the
 * hosted runtime negotiates, which Accept-Encoding it adds or what it
 * decodes - there is no Deno here, and none of it is claimed.
 */

const body = buildInteractionRequest({
  systemInstruction: buildSystemInstruction(null),
  turns: toInteractionInput([
    { chat_message_role: 'patient', chat_message_content: 'Is some swelling normal?' },
  ]),
})

const client = { kind: 'stand-in for Deno.HttpClient' }

describe('the client Gemini is reached with', () => {
  it('speaks HTTP/1.1 only, never HTTP/2, and keeps no idle connection', () => {
    expect(geminiClientOptions()).toEqual({ http1: true, http2: false, poolMaxIdlePerHost: 0 })
  })

  it('is described by a new, writable object each time', () => {
    // Deno 2.1.4's createHttpClient adds `caCerts` to the options it is
    // given and throws on frozen ones; a shared object would carry that on.
    const first = geminiClientOptions()
    Object.assign(first, { caCerts: [] })
    expect(Object.isFrozen(first)).toBe(false)
    expect(geminiClientOptions()).not.toBe(first)
    expect(geminiClientOptions()).not.toHaveProperty('caCerts')
  })
})

describe('making the client', () => {
  it('makes it once, on first use, and says so once', () => {
    const create = vi.fn(() => client)
    const log = vi.fn()
    const providerClient = providerClientOnce(create, log)

    expect(create).not.toHaveBeenCalled()
    expect(providerClient()).toBe(client)
    expect(providerClient()).toBe(client)
    expect(create).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([['{"event":"gemini_transport","transport":"http1"}']])
  })

  it('falls back to the default transport when the runtime cannot make it, and does not try again', () => {
    const create = vi.fn((): typeof client => {
      throw new TypeError('Deno.createHttpClient is not a function: GEMINI_API_KEY=…')
    })
    const log = vi.fn()
    const providerClient = providerClientOnce(create, log)

    expect(providerClient()).toBeUndefined()
    expect(providerClient()).toBeUndefined()
    expect(create).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([
      ['{"event":"gemini_transport","transport":"default","reason":"TypeError"}'],
    ])
  })

  it('logs nothing of an error but its kind', () => {
    const log = vi.fn()
    providerClientOnce(() => {
      throw 'not an Error'
    }, log)()
    expect(log.mock.calls).toEqual([
      ['{"event":"gemini_transport","transport":"default","reason":"unknown"}'],
    ])
  })
})

describe('the provider request', () => {
  const signal = AbortSignal.timeout(30_000)
  const init = geminiRequestInit({ apiKey: 'test-gemini-key', body, signal, client })

  it('is the same POST as before, with the User-Agent added', () => {
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'test-gemini-key',
      'Api-Revision': GEMINI_API_REVISION,
      'User-Agent': 'node',
    })
    expect(GEMINI_USER_AGENT).toBe('node')
  })

  it('sends the built request unchanged: model, statelessness and the reply schema', () => {
    expect(init.body).toBe(JSON.stringify(body))
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(body).toMatchObject({ model: GEMINI_MODEL, store: false })
  })

  it('keeps the endpoint, model and API revision', () => {
    expect(GEMINI_ENDPOINT).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(GEMINI_MODEL).toBe('gemini-3.8-flash')
    expect(GEMINI_API_REVISION).toBe('2026-05-20')
  })

  it('passes the time limit and the client through as given', () => {
    expect(init.signal).toBe(signal)
    expect(init.client).toBe(client)
  })

  it('without a client, is exactly the request that ran before: no client, no User-Agent', () => {
    const fallback = geminiRequestInit({ apiKey: 'test-gemini-key', body, signal, client: undefined })
    expect(fallback).not.toHaveProperty('client')
    expect(fallback.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'test-gemini-key',
      'Api-Revision': GEMINI_API_REVISION,
    })
    expect(fallback.method).toBe('POST')
    expect(fallback.body).toBe(init.body)
    expect(fallback.signal).toBe(signal)
  })

  it('leaves Accept-Encoding to the runtime, and never advertises deflate', () => {
    // Deno decodes gzip and br, which it sends by default, and not deflate.
    const names = Object.keys(init.headers as Record<string, string>).map((name) =>
      name.toLowerCase(),
    )
    expect(names).not.toContain('accept-encoding')
    expect(JSON.stringify(init.headers)).not.toMatch(/deflate/i)
  })
})

describe('against a local server', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  })

  async function listen(handler: (request: IncomingMessage, raw: string) => void) {
    server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        handler(request, raw)
        if (request.url !== '/hang') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('arrives as built', async () => {
    let received = undefined as { request: IncomingMessage; raw: string } | undefined
    const url = await listen((request, raw) => (received = { request, raw }))

    const response = await fetch(
      `${url}/interactions`,
      geminiRequestInit({ apiKey: 'test-gemini-key', body, signal: AbortSignal.timeout(5_000), client: undefined }),
    )

    expect(response.status).toBe(200)
    expect(received!.request.method).toBe('POST')
    // No User-Agent here: Node's fetch sends `node` of its own accord, so
    // seeing it would prove nothing. The header is pinned above.
    expect(received!.request.headers).toMatchObject({
      'content-type': 'application/json',
      'x-goog-api-key': 'test-gemini-key',
      'api-revision': GEMINI_API_REVISION,
    })
    expect(received!.raw).toBe(JSON.stringify(body))
  })

  it('reports a provider slower than the limit as a timeout', async () => {
    const url = await listen(() => {})

    const cause = await fetch(
      `${url}/hang`,
      geminiRequestInit({ apiKey: 'test-gemini-key', body, signal: AbortSignal.timeout(50), client: undefined }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(cause).toBeDefined()
    expect(isProviderTimeout(cause)).toBe(true)
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const handler = source.slice(source.indexOf('Deno.serve('))
  const providerCall = handler.slice(
    handler.indexOf('let response: Response'),
    handler.indexOf('} catch (cause) {'),
  )

  it('makes one client for the worker, from fresh options, falling back to the default', () => {
    expect(source.split('Deno.createHttpClient(').length - 1).toBe(1)
    expect(source).toMatch(
      /const providerClient = providerClientOnce\(\s*\(\) => Deno\.createHttpClient\(geminiClientOptions\(\)\),\s*\(line\) => console\.log\(line\),\s*\)/,
    )
    expect(source.indexOf('Deno.createHttpClient(')).toBeLessThan(source.indexOf('Deno.serve('))
    expect(handler).not.toContain('createHttpClient')
    expect(handler).not.toMatch(/\.close\(\)/)
  })

  it('sends through the transport, with the 30 s limit, inside the provider call’s try', () => {
    expect(source).toContain('const REQUEST_TIMEOUT_MS = 30_000')
    expect(handler).toContain('const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS)')
    expect(providerCall).toContain('try {')
    expect(providerCall).toMatch(
      /fetch\(GEMINI_ENDPOINT, geminiRequestInit\(\{\s*apiKey,\s*body,\s*signal: abort,\s*client: providerClient\(\),\s*\}\)\)/,
    )
    // The headers are built in one place only.
    expect(source).not.toContain("'x-goog-api-key'")
  })

  it('still reads the key from the environment and reports failures as before', () => {
    expect(handler).toContain("const apiKey = Deno.env.get('GEMINI_API_KEY')")
    expect(handler).toContain("504, 'timeout'")
    expect(handler).toContain("new ReplyError('The guidance assistant is unavailable.', 503, 'unavailable')")
  })
})
