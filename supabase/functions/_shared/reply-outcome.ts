/**
 * How `chatbot-reply` reports the outcome of a request: a stable code the
 * browser can act on, and one log line an operator can read.
 *
 * Free of `Deno` and of any client, like `assistant.ts`, so it is tested in
 * Node.
 */

/**
 * Sent as `code` beside the human-readable `error`. The browser decides from
 * it whether trying again can help; the status alone could not tell a
 * provider that was too slow from one that is down.
 */
export type ReplyErrorCode =
  /** Not signed in, not this patient's conversation, or not found. */
  | 'not_allowed'
  /** The latest message already has its reply - a retry after a slow one. */
  | 'already_answered'
  /** The request itself was malformed. */
  | 'bad_request'
  /** No provider key on this deployment. */
  | 'not_configured'
  /** The provider did not answer within the time limit. */
  | 'timeout'
  /** The provider is rate limited or under load. */
  | 'busy'
  /** The provider could not be reached, or failed. */
  | 'unavailable'
  /** The provider answered, in a shape that cannot be trusted. */
  | 'invalid_reply'
  /** The reply could not be saved. */
  | 'save_failed'
  /**
   * The guidance assistant is switched off, for the platform or for the
   * patient's clinic (migration 38). Trying again cannot help.
   */
  | 'disabled'

/** The code for a refusal known only by its status, such as from `requireCaller`. */
export function codeForStatus(status: number): ReplyErrorCode {
  if (status === 401 || status === 403 || status === 404) return 'not_allowed'
  if (status === 400) return 'bad_request'
  if (status === 429) return 'busy'
  if (status === 504) return 'timeout'
  return 'unavailable'
}

/**
 * Whether a provider request failed because its own time limit ran out.
 * `AbortSignal.timeout` rejects with a `TimeoutError`, which is reported
 * differently from a connection that failed outright.
 */
export function isProviderTimeout(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  )
}

/** Longer than any error the provider sends; anything bigger is not parsed. */
const MAX_PROVIDER_ERROR_BYTES = 65_536
/** At most this many reasons, and this many fields, per line. */
const MAX_PROVIDER_ERROR_ITEMS = 5
/** `RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`: an enum name, never prose. */
const PROVIDER_STATUS = /^[A-Z][A-Z_]{0,63}$/
/** `API_KEY_INVALID`, `RATE_LIMIT_EXCEEDED`. */
const PROVIDER_REASON = /^[A-Z][A-Z0-9_]{0,63}$/
/** A path into the request such as `input[1].type` - never a value. */
const PROVIDER_FIELD = /^[A-Za-z0-9_.[\]]{1,120}$/

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What of a provider's error response may be logged: its status, and the
 * machine-readable parts of a Google API error - the code, the status name,
 * each `ErrorInfo` reason and each `BadRequest` field path. Never its
 * `message` or any `description`: those are prose, and prose can quote the
 * request, which is a patient's conversation.
 *
 * The field paths are what made the `model_output` turn-type failure
 * diagnosable (`input[1].type`), so they stay; anything that does not look
 * like an enum name or a path is dropped rather than escaped.
 */
export function providerErrorSummary(status: number, body: string): string {
  let error: UnknownRecord = {}
  if (body.length <= MAX_PROVIDER_ERROR_BYTES) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (isRecord(parsed) && isRecord(parsed.error)) error = parsed.error
    } catch {
      // Not JSON: nothing of it is logged.
    }
  }

  const details = Array.isArray(error.details) ? error.details.filter(isRecord) : []
  const matching = (values: unknown[], pattern: RegExp) => [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && pattern.test(value)),
    ),
  ].slice(0, MAX_PROVIDER_ERROR_ITEMS)

  const code = error.code
  const providerStatus = error.status

  return JSON.stringify({
    event: 'gemini_error',
    status,
    provider_code:
      typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
        ? code
        : null,
    provider_status:
      typeof providerStatus === 'string' && PROVIDER_STATUS.test(providerStatus)
        ? providerStatus
        : null,
    reasons: matching(details.map((detail) => detail.reason), PROVIDER_REASON),
    fields: matching(
      details
        .flatMap((detail) => (Array.isArray(detail.fieldViolations) ? detail.fieldViolations : []))
        .filter(isRecord)
        .map((violation) => violation.field),
      PROVIDER_FIELD,
    ),
  })
}

export type ReplyLogEntry = {
  requestId: string
  status: number
  code: ReplyErrorCode | null
  durationMs: number
}

/**
 * One line per request: an id to find it by, how it ended and how long it
 * took. Built from these four fields only, so nothing a patient wrote, no
 * reply, no token and no key can reach the log by accident.
 */
export function replyLogLine(entry: ReplyLogEntry): string {
  return JSON.stringify({
    event: 'chatbot_reply',
    request_id: entry.requestId,
    status: entry.status,
    outcome: entry.code ?? 'replied',
    duration_ms: Math.round(entry.durationMs),
  })
}
