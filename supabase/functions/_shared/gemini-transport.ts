/**
 * How `chatbot-reply` reaches Gemini: over HTTP/1.1 only, on a new connection
 * each time, introducing itself as `node`.
 *
 * An experiment, not a proven fix, and not verified in the hosted Supabase
 * Edge Runtime. With Deno's default transport (HTTP/2, the `Deno/…`
 * User-Agent) diagnostic requests ran into the 30 s limit again and again,
 * while Node.js's fetch answered in about 14 s - with its own `node`
 * User-Agent and with the production-style one alike. Of the Deno requests,
 * HTTP/1.1 alone still timed out; HTTP/1.1 with `node` answered 200 once and
 * 503 once. That is the request reproduced here. With Accept-Encoding
 * `br, gzip, deflate` as well, one answered in 22.8 s and the next timed out.
 * Too few requests to say which change, if any, made the difference.
 *
 * Each diagnostic request went out on a connection of its own, and so does
 * each request here: a pooled HTTP/1.1 connection the provider closes just
 * as a request is written to it fails that request, and Deno 2.1.4 does not
 * retry it. A new TLS connection costs far less than a reply takes.
 *
 * If the runtime cannot make the client, the request goes out exactly as it
 * did before this experiment - the default transport and the runtime's own
 * User-Agent - and the worker says which it uses, once, in the log.
 *
 * Accept-Encoding is left to the runtime. Deno 2.1.4 sends `gzip,br` - what
 * the HTTP/1.1 request that answered 200 sent - and decodes both. It does not
 * decode deflate, so advertising it as Node does would let the provider send
 * a body nothing here can read.
 *
 * Reportedly (Supabase Edge Runtime 1.77.0's source, not checked here) the
 * hosted runtime adds its own identification after an explicit User-Agent,
 * so the provider would see `node` followed by it.
 *
 * Free of `Deno`, like `assistant.ts`, so it is tested in Node; the client
 * itself is created in `chatbot-reply/index.ts`.
 */

import { GEMINI_API_REVISION } from './assistant.ts'

/**
 * For `Deno.createHttpClient`: HTTP/1.1 and never HTTP/2, keeping no idle
 * connection. A new object each call, never a shared one: Deno 2.1.4 writes
 * into the options it is given (it adds `caCerts`), and throws if they are
 * frozen.
 */
export function geminiClientOptions() {
  return { http1: true, http2: false, poolMaxIdlePerHost: 0 }
}

/** What Node.js's fetch sends. */
export const GEMINI_USER_AGENT = 'node'

/**
 * The client to send the provider request with: made by `create` on first
 * use and kept, or - if it cannot be made - none, so the default transport
 * is used. Either way `log` hears which, once, and never an error's message.
 */
export function providerClientOnce<Client>(
  create: () => Client,
  log: (line: string) => void,
): () => Client | undefined {
  let made: { client: Client | undefined } | undefined
  return () => {
    if (!made) {
      try {
        made = { client: create() }
        log(JSON.stringify({ event: 'gemini_transport', transport: 'http1' }))
      } catch (error) {
        made = { client: undefined }
        log(
          JSON.stringify({
            event: 'gemini_transport',
            transport: 'default',
            reason: error instanceof Error ? error.name : 'unknown',
          }),
        )
      }
    }
    return made.client
  }
}

/**
 * The provider request's options: the same method, headers and body as
 * before. With a client, the experiment: that client, and `node` as the
 * User-Agent. Without one, nothing more - the request that ran before.
 */
export function geminiRequestInit<Client>(input: {
  apiKey: string
  body: Record<string, unknown>
  signal: AbortSignal
  client: Client | undefined
}): RequestInit & { client?: Client } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-goog-api-key': input.apiKey,
    'Api-Revision': GEMINI_API_REVISION,
  }
  if (input.client === undefined) {
    return { method: 'POST', headers, body: JSON.stringify(input.body), signal: input.signal }
  }
  return {
    method: 'POST',
    headers: { ...headers, 'User-Agent': GEMINI_USER_AGENT },
    body: JSON.stringify(input.body),
    signal: input.signal,
    client: input.client,
  }
}
