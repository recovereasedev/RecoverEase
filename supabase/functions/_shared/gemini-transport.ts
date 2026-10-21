/**
 * How `chatbot-reply` reaches Gemini: over HTTP/1.1 only, introducing itself
 * as `node`.
 *
 * A candidate, not a proven fix. With Deno's default transport (HTTP/2, the
 * `Deno/…` User-Agent) diagnostic requests ran into the 30 s limit again and
 * again, while Node.js's fetch answered in about 14 s - with its own `node`
 * User-Agent and with the production-style one alike. Of the Deno requests,
 * HTTP/1.1 alone still timed out; HTTP/1.1 with `node` answered 200 once and
 * 503 once. That is the request reproduced here. With Accept-Encoding
 * `br, gzip, deflate` as well, one answered in 22.8 s and the next timed out.
 * Too few requests to say which change, if any, made the difference.
 *
 * Accept-Encoding is left to the runtime. Deno 2.1.4 sends `gzip,br` - what
 * the HTTP/1.1 request that answered 200 sent - and decodes both. It does not
 * decode deflate, so advertising it as Node does would let the provider send
 * a body nothing here can read.
 *
 * Supabase Edge Runtime 1.77.0 adds its own identification after an explicit
 * User-Agent, so the provider sees `node` followed by it.
 *
 * Free of `Deno`, like `assistant.ts`, so it is tested in Node; the client
 * itself is created in `chatbot-reply/index.ts`.
 */

import { GEMINI_API_REVISION } from './assistant.ts'

/** For `Deno.createHttpClient`: HTTP/1.1, and never HTTP/2. */
export const GEMINI_CLIENT_OPTIONS = { http1: true, http2: false } as const

/** What Node.js's fetch sends. */
export const GEMINI_USER_AGENT = 'node'

/**
 * The provider request's options: the same method, headers and body as
 * before, plus the User-Agent and the client to send it with.
 */
export function geminiRequestInit<Client>(input: {
  apiKey: string
  body: Record<string, unknown>
  signal: AbortSignal
  client: Client
}): RequestInit & { client: Client } {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': input.apiKey,
      'Api-Revision': GEMINI_API_REVISION,
      'User-Agent': GEMINI_USER_AGENT,
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
    client: input.client,
  }
}
