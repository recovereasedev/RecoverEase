import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai'

import {
  AssistantReplyError,
  type AssistantReply,
  buildResponsesRequest,
  type ConversationTurn,
  type HostedPrompt,
  leadWithEmergencyInstruction,
  parseAssistantReply,
  responseOutputText,
  type ResponsesRequest,
  withoutHostedPrompt,
} from './assistant.ts'
import { isProviderTimeout, providerErrorSummary } from './reply-outcome.ts'

/**
 * One request to OpenAI (Responses API, official SDK) for one reply, and
 * everything that can go wrong with it, told apart.
 *
 * Free of `Deno` and of any database client, like `assistant.ts`: `fetch` is
 * passed in, so every provider failure - no key, a rejected key, 429, 5xx, a
 * timeout, a body that stalls, an unfinished or refused response, malformed
 * or off-schema output, a hosted prompt that no longer exists - is tested in
 * Node against a fake provider, never against OpenAI with patient text.
 *
 * The SDK's own retries are off (`maxRetries: 0`): the request has one time
 * budget (`reply-outcome.ts`), and a retry the budget does not know about
 * could outlive it. The one retry made here is deliberate: a request whose
 * HOSTED PROMPT is refused is sent again without it, because everything the
 * assistant needs is in the request already (`assistant.ts`). That keeps the
 * assistant answering if the prompt is deleted, mistyped, or retired - OpenAI
 * has announced the shutdown of reusable prompt objects for 30 November 2026.
 */

/** Why the provider gave no usable reply - each one tells the patient something different. */
export type ProviderFailureCode = 'timeout' | 'busy' | 'unavailable' | 'not_configured'

export type ProviderTimings = {
  /** From sending the request to the response headers (the last attempt). */
  headersMs: number | null
  /** From the headers to the end of the body. */
  bodyMs: number | null
  /** Parsing and schema validation. */
  validationMs: number | null
}

/**
 * A failure before a reply could be validated. Carries what an operator
 * needs - the HTTP status OpenAI sent, whether the deadline ran out, how long
 * each part took - and nothing the patient or the provider wrote.
 */
export class ProviderError extends Error {
  readonly code: ProviderFailureCode
  /** The status chatbot-reply answers with. */
  readonly status: number
  /** The status OpenAI answered with, when it answered at all. */
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
  /** Size of the request that produced the reply. */
  requestBytes: number
  /** Whether the hosted prompt was part of the request that answered. */
  usedHostedPrompt: boolean
}

export type OpenAIReplyRequest = {
  apiKey: string | undefined
  /** `OPENAI_MODEL`. Required: without a hosted prompt nothing else names one. */
  model: string | undefined
  /** The whole system instruction, from `buildSystemInstruction`. */
  instructions: string
  turns: readonly ConversationTurn[]
  /** `OPENAI_PROMPT_ID` / `OPENAI_PROMPT_VERSION`, when configured. */
  hostedPrompt?: HostedPrompt | null
  /** One deadline for the whole exchange, including any retry. */
  timeoutMs: number
  fetchImpl?: typeof fetch
  /** Only for the offline evaluation script; chatbot-reply never sets it. */
  baseURL?: string
  now?: () => number
  /** Where operator-only lines go; never given anything a patient wrote. */
  log?: (line: string) => void
}

/** A retry without the hosted prompt is made only with at least this long left. */
const MIN_RETRY_MS = 5_000

/**
 * Statuses that mean "this request is wrong", which with a hosted prompt is
 * most likely the prompt itself (not found, retired, a version that does not
 * exist, or a declared variable this request does not send).
 */
const REQUEST_REJECTED = new Set([400, 404, 422])

const bytes = (text: string) => new TextEncoder().encode(text).length

/** Responses that ended without a complete answer are refused, not shown. */
const FINISHED = 'completed'

/**
 * Where requests go. Fixed, rather than left to the SDK, which would
 * otherwise honour an `OPENAI_BASE_URL` environment variable - a stray secret
 * would then send patients' records somewhere else. Only the offline
 * evaluation script passes another.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * How long a hosted prompt OpenAI refused is left out of later requests in
 * the same running instance, so a retired prompt does not cost every reply a
 * second round trip. Kept in memory only; a new instance simply tries again.
 */
export const REFUSED_PROMPT_MEMORY_MS = 10 * 60_000
const refusedPrompts = new Map<string, number>()
const promptKey = (prompt: HostedPrompt) => `${prompt.id}@${prompt.version ?? ''}`

/** For tests: forget every refused prompt. */
export function forgetRefusedHostedPrompts(): void {
  refusedPrompts.clear()
}

export async function requestOpenAIReply(input: OpenAIReplyRequest): Promise<ProviderSuccess> {
  const now = input.now ?? Date.now
  const log = input.log ?? ((line: string) => console.error(line))
  const timings: ProviderTimings = { headersMs: null, bodyMs: null, validationMs: null }
  const notConfigured = (providerStatus: number | null) =>
    new ProviderError('The guidance assistant is not configured.', 'not_configured', 503, providerStatus, timings)

  if (!input.apiKey || !input.model?.trim()) throw notConfigured(null)

  const deadline = now() + input.timeoutMs
  const apiKey = input.apiKey
  let client: OpenAI | null = null
  // Made on first use, inside the error handling below, so even a client
  // that cannot be constructed ends as a clean "unavailable".
  const openai = () =>
    (client ??= new OpenAI({
      apiKey,
      baseURL: input.baseURL ?? OPENAI_BASE_URL,
      maxRetries: 0,
      ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
    }))

  // A prompt refused recently is left out from the start.
  const configured = input.hostedPrompt ?? null
  const refusedUntil = configured ? refusedPrompts.get(promptKey(configured)) : undefined
  const hostedPrompt = refusedUntil !== undefined && now() < refusedUntil ? null : configured

  const first = buildResponsesRequest({
    model: input.model.trim(),
    instructions: input.instructions,
    turns: input.turns,
    hostedPrompt,
  })

  try {
    return await attempt(first)
  } catch (error) {
    const canRetry =
      'prompt' in first &&
      error instanceof APIError &&
      typeof error.status === 'number' &&
      REQUEST_REJECTED.has(error.status) &&
      // An unknown model is not about the prompt: a retry would fail the same way.
      !isConfigurationError(error) &&
      deadline - now() >= MIN_RETRY_MS
    if (!canRetry) throw classify(error)
    if (hostedPrompt) refusedPrompts.set(promptKey(hostedPrompt), now() + REFUSED_PROMPT_MEMORY_MS)
    log(JSON.stringify({ event: 'openai_hosted_prompt_skipped', ...errorFields(error) }))
    try {
      return await attempt(withoutHostedPrompt(first))
    } catch (retryError) {
      throw classify(retryError)
    }
  }

  async function attempt(request: ResponsesRequest): Promise<ProviderSuccess> {
    const remaining = Math.max(1, deadline - now())
    const signal = AbortSignal.timeout(remaining)
    const body = JSON.stringify(request)
    const sentAt = now()
    timings.headersMs = null
    timings.bodyMs = null

    let response: Response
    try {
      response = await openai()
        .responses // The request is built field by field in `assistant.ts` against the
        // SDK's documented parameters; the cast only bridges our literal
        // types to the SDK's parameter type.
        .create(request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming, {
          signal,
          timeout: remaining,
        })
        .asResponse()
    } finally {
      timings.headersMs = now() - sentAt
    }
    const headersAt = now()

    // Read under the same deadline, so a stalled body is the timeout it is.
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      timings.bodyMs = now() - headersAt
      log(JSON.stringify({ event: 'openai_body_failed', timed_out: isProviderTimeout(cause), provider_status: response.status }))
      throw isProviderTimeout(cause) || signal.aborted
        ? new ProviderError('The guidance assistant took too long to respond.', 'timeout', 504, response.status, timings)
        : new ProviderError('The guidance assistant is unavailable.', 'unavailable', 503, response.status, timings)
    }
    timings.bodyMs = now() - headersAt
    const responseBytes = bytes(text)

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

    const status = (payload as { status?: unknown } | null)?.status
    if (status !== FINISHED) {
      // The status only: an incomplete response's details are not needed.
      log(JSON.stringify({ event: 'openai_unfinished', response_status: typeof status === 'string' ? status.slice(0, 32) : null }))
      return reject('The assistant did not finish its reply')
    }

    const { text: output, refused } = responseOutputText(payload)
    if (refused) {
      log(JSON.stringify({ event: 'openai_refusal' }))
      return reject('The assistant declined to answer')
    }

    let reply: AssistantReply
    try {
      reply = leadWithEmergencyInstruction(parseAssistantReply(output))
    } catch (error) {
      return reject(error instanceof Error ? error.message : 'The assistant returned unusable output')
    }
    timings.validationMs = now() - validatingAt

    return {
      reply,
      providerStatus: response.status,
      timings,
      responseBytes,
      requestBytes: bytes(body),
      usedHostedPrompt: 'prompt' in request,
    }
  }

  /** An SDK or network failure, as the patient-facing outcome it means. */
  function classify(error: unknown): unknown {
    if (error instanceof ProviderError || error instanceof ProviderReplyError) return error

    if (
      error instanceof APIConnectionTimeoutError ||
      error instanceof APIUserAbortError ||
      isProviderTimeout(error)
    ) {
      log(JSON.stringify({ event: 'openai_no_response', timed_out: true }))
      return new ProviderError('The guidance assistant took too long to respond.', 'timeout', 504, null, timings)
    }
    if (error instanceof APIConnectionError) {
      log(JSON.stringify({ event: 'openai_no_response', timed_out: false }))
      return new ProviderError('The guidance assistant is unavailable.', 'unavailable', 503, null, timings)
    }
    if (error instanceof APIError && typeof error.status === 'number') {
      log(providerErrorSummary(error.status, errorFields(error)))
      // A rejected key, an empty account or an unknown model is
      // configuration: trying again cannot help. Checked before 429, because
      // `insufficient_quota` arrives as a 429 and is not "busy".
      if (error.status === 401 || error.status === 403 || isConfigurationError(error)) {
        return notConfigured(error.status)
      }
      const busy = error.status === 429 || error.status >= 500
      return new ProviderError(
        busy ? 'The guidance assistant is busy. Try again in a moment.' : 'The guidance assistant is unavailable.',
        busy ? 'busy' : 'unavailable',
        busy ? 429 : 502,
        error.status,
        timings,
      )
    }
    log(JSON.stringify({ event: 'openai_failed', error: error instanceof Error ? error.name : 'unknown' }))
    return new ProviderError('The guidance assistant is unavailable.', 'unavailable', 503, null, timings)
  }
}

/**
 * OpenAI error codes that mean this deployment is misconfigured or out of
 * credit, rather than OpenAI being down (as production v31 already treats
 * them).
 */
const CONFIGURATION_CODES = new Set([
  'invalid_api_key',
  'insufficient_quota',
  'model_not_found',
  'billing_not_active',
])

function isConfigurationError(error: APIError): boolean {
  return typeof error.code === 'string' && CONFIGURATION_CODES.has(error.code)
}

/** The machine-readable parts of an SDK error: never its message. */
function errorFields(error: APIError): { status: number | null; type: unknown; code: unknown; param: unknown } {
  return {
    status: typeof error.status === 'number' ? error.status : null,
    type: error.type,
    code: error.code,
    param: error.param,
  }
}
