import {
  AssistantReplyError,
  type AssistantReply,
  extractOutputText,
  GEMINI_API_REVISION,
  GEMINI_ENDPOINT,
  parseAssistantReply,
} from './assistant.ts'
import { isProviderTimeout, providerErrorSummary } from './reply-outcome.ts'

/**
 * One request to Gemini for one reply, and everything that can go wrong with
 * it, told apart.
 *
 * Free of `Deno` and of any database client, like `assistant.ts`: the fetch
 * is passed in, so every provider failure - slow headers, a body that stalls,
 * 429, 5xx, a rejected key, malformed or off-schema output - is tested in
 * Node against a fake provider, never against Gemini with patient text.
 *
 * The time limit is one deadline for the whole exchange. The same signal is
 * given to `fetch` and is still running while the body is read, so a provider
 * that sends its headers and then stalls is cut off at the same moment as one
 * that never answers at all.
 */

/** Why the provider gave no usable reply - each one tells the patient something different. */
export type ProviderFailureCode = 'timeout' | 'busy' | 'unavailable' | 'not_configured'

export type ProviderTimings = {
  /** From sending the request to the response headers. */
  headersMs: number | null
  /** From the headers to the end of the body. */
  bodyMs: number | null
  /** Parsing and schema validation. */
  validationMs: number | null
}

/**
 * A failure before a reply could be validated. Carries what an operator
 * needs - the HTTP status Gemini sent, whether our own deadline ran out, how
 * long each part took - and nothing the patient or the provider wrote.
 */
export class ProviderError extends Error {
  readonly code: ProviderFailureCode
  /** The status chatbot-reply answers with. */
  readonly status: number
  /** The status Gemini answered with, when it answered at all. */
  readonly providerStatus: number | null
  readonly timings: ProviderTimings

  constructor(
    message: string,
    code: ProviderFailureCode,
    status: number,
    providerStatus: number | null,
    timings: ProviderTimings,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.providerStatus = providerStatus
    this.timings = timings
  }
}

/** The model answered, but in a shape that cannot be trusted. */
export class ProviderReplyError extends AssistantReplyError {
  readonly providerStatus: number
  readonly timings: ProviderTimings
  readonly responseBytes: number

  constructor(message: string, providerStatus: number, timings: ProviderTimings, responseBytes: number) {
    super(message)
    this.name = 'ProviderReplyError'
    this.providerStatus = providerStatus
    this.timings = timings
    this.responseBytes = responseBytes
  }
}

export type ProviderSuccess = {
  reply: AssistantReply
  providerStatus: number
  timings: ProviderTimings
  responseBytes: number
}

/** Reasons Google gives for a key that is wrong, rather than a provider that is down. */
const KEY_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED'])

/**
 * Interaction states that mean the model stopped without finishing: a reply
 * cut off by a token limit can still be valid JSON with a truncated message,
 * so it is refused rather than shown.
 */
const UNFINISHED_STATES = new Set([
  'incomplete',
  'failed',
  'cancelled',
  'in_progress',
  'requires_action',
  'requires_continuation',
])

function interactionState(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const inner =
    typeof record.interaction === 'object' && record.interaction !== null
      ? (record.interaction as Record<string, unknown>)
      : record
  return typeof inner.status === 'string' ? inner.status : null
}

export type GeminiRequest = {
  apiKey: string | undefined
  /** The request body, from `buildInteractionRequest`. */
  body: Record<string, unknown>
  timeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** Where operator-only lines go; never given anything a patient wrote. */
  log?: (line: string) => void
}

export async function requestGeminiReply(request: GeminiRequest): Promise<ProviderSuccess> {
  const fetchImpl = request.fetchImpl ?? fetch
  const now = request.now ?? Date.now
  const log = request.log ?? ((line: string) => console.error(line))
  const timings: ProviderTimings = { headersMs: null, bodyMs: null, validationMs: null }

  if (!request.apiKey) {
    throw new ProviderError(
      'The guidance assistant is not configured.',
      'not_configured',
      503,
      null,
      timings,
    )
  }

  const signal = AbortSignal.timeout(request.timeoutMs)
  const sentAt = now()

  let response: Response
  try {
    response = await fetchImpl(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': request.apiKey,
        'Api-Revision': GEMINI_API_REVISION,
      },
      body: JSON.stringify(request.body),
      signal,
    })
  } catch (cause) {
    timings.headersMs = now() - sentAt
    const timedOut = isProviderTimeout(cause)
    // The error's name only: a network error's message can carry the URL,
    // and nothing else of it helps an operator.
    log(
      JSON.stringify({
        event: 'gemini_no_response',
        timed_out: timedOut,
        error: cause instanceof Error ? cause.name : 'unknown',
        headers_ms: timings.headersMs,
      }),
    )
    throw timedOut
      ? new ProviderError('The guidance assistant took too long to respond.', 'timeout', 504, null, timings)
      : new ProviderError('The guidance assistant is unavailable.', 'unavailable', 503, null, timings)
  }
  const headersAt = now()
  timings.headersMs = headersAt - sentAt

  // The body is read as text under the same deadline, so its size can be
  // logged and a stalled body is reported as the timeout it is.
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    timings.bodyMs = now() - headersAt
    const timedOut = isProviderTimeout(cause)
    log(
      JSON.stringify({
        event: 'gemini_body_failed',
        timed_out: timedOut,
        provider_status: response.status,
        body_ms: timings.bodyMs,
      }),
    )
    throw timedOut
      ? new ProviderError(
          'The guidance assistant took too long to respond.',
          'timeout',
          504,
          response.status,
          timings,
        )
      : new ProviderError(
          'The guidance assistant is unavailable.',
          'unavailable',
          503,
          response.status,
          timings,
        )
  }
  timings.bodyMs = now() - headersAt
  const responseBytes = new TextEncoder().encode(text).length

  if (!response.ok) {
    // Only the machine-readable parts: provider error prose can quote the
    // request, which is a patient's conversation.
    const summary = providerErrorSummary(response.status, text)
    log(summary)
    const reasons = (JSON.parse(summary) as { reasons: string[] }).reasons

    // A rejected key is configuration, not an outage: trying again cannot help.
    if (
      response.status === 401 ||
      response.status === 403 ||
      reasons.some((reason) => KEY_REASONS.has(reason))
    ) {
      throw new ProviderError(
        'The guidance assistant is not configured.',
        'not_configured',
        503,
        response.status,
        timings,
      )
    }
    // 429 and 5xx are transient far more often than not - the documented
    // response to "high demand" is to retry - so they are reported as busy.
    const busy = response.status === 429 || response.status >= 500
    throw new ProviderError(
      busy
        ? 'The guidance assistant is busy. Try again in a moment.'
        : 'The guidance assistant is unavailable.',
      busy ? 'busy' : 'unavailable',
      busy ? 429 : 502,
      response.status,
      timings,
    )
  }

  const validatingAt = now()
  const reject = (message: string): never => {
    timings.validationMs = now() - validatingAt
    throw new ProviderReplyError(message, response.status, timings, responseBytes)
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return reject('The assistant returned malformed output')
  }

  const state = interactionState(payload)
  if (state !== null && UNFINISHED_STATES.has(state)) {
    log(JSON.stringify({ event: 'gemini_unfinished', interaction_status: state }))
    return reject('The assistant did not finish its reply')
  }

  let reply: AssistantReply
  try {
    reply = parseAssistantReply(extractOutputText(payload))
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'The assistant returned unusable output')
  }
  timings.validationMs = now() - validatingAt

  return { reply, providerStatus: response.status, timings, responseBytes }
}
