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
