import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js'

/**
 * Why a request for the guidance assistant's reply did not produce one.
 *
 * The patient's own message is already saved by the time this matters, so
 * every one of these is about the reply alone. They are told apart because
 * each asks something different of the patient: wait and try again, check
 * the connection, or nothing they can do.
 */
export type ReplyFailure =
  /** No answer in time: the browser gave up, or the provider was too slow. */
  | 'timeout'
  /** The request never reached the assistant: offline, or the connection dropped. */
  | 'network'
  /** The provider is rate limited or under load (429). */
  | 'busy'
  /** Any other failure on the way to a reply. */
  | 'unavailable'
  /** The assistant is not set up on this deployment. Trying again cannot help. */
  | 'not_configured'
  /** The request was refused - session expired, or not this patient's conversation. */
  | 'not_allowed'
  /**
   * The guidance assistant is switched off, for the platform or the
   * patient's clinic (migration 38). Trying again cannot help.
   */
  | 'disabled'

/**
 * How long the browser waits for a reply before giving up.
 *
 * Longer than the server's own budget - `chatbot-reply` stops waiting for
 * Gemini after 25 s, and answers within a few seconds of that - so a reply
 * the server is still preparing is never abandoned by the browser. Without
 * any limit, a request that is never answered (a dropped connection, a phone
 * that suspended the tab) left the page waiting indefinitely.
 */
export const REPLY_TIMEOUT_MS = 40_000

/** How long a reply may take before the patient is told it is slow. */
export const SLOW_REPLY_MS = 12_000

/**
 * How many times the patient can ask again for one unanswered message.
 * Each attempt is a real request to the provider, so it is bounded.
 */
export const MAX_REPLY_RETRIES = 3

/** Failures worth trying again; the others say so instead. */
export function canRetry(failure: ReplyFailure): boolean {
  return (
    failure === 'timeout' ||
    failure === 'network' ||
    failure === 'busy' ||
    failure === 'unavailable'
  )
}

type ErrorBody = { code?: unknown; error?: unknown }

async function readBody(response: Response): Promise<ErrorBody | null> {
  try {
    return (await response.clone().json()) as ErrorBody
  } catch {
    return null
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

/**
 * Sorts a failed `functions.invoke('chatbot-reply')` into a `ReplyFailure`,
 * or `'already_answered'` when there was nothing left to answer.
 *
 * `already_answered` is not a failure. It is what a retry gets when the
 * reply to the patient's message was saved after all - the browser gave up
 * waiting, or the response was lost on the way back - and the right thing
 * to do is show the conversation, not an error.
 *
 * Reads the function's `code` where it gives one, and otherwise the HTTP
 * status alone, so it works against the function before and after it began
 * returning codes.
 */
export async function classifyReplyError(
  error: unknown,
): Promise<ReplyFailure | 'already_answered'> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response
    const body = await readBody(response)
    const code = typeof body?.code === 'string' ? body.code : null
    const message = typeof body?.error === 'string' ? body.error : ''

    // The function's own code, where it gives one.
    switch (code) {
      case 'already_answered':
        return 'already_answered'
      case 'not_configured':
        return 'not_configured'
      case 'timeout':
        return 'timeout'
      case 'busy':
        return 'busy'
      case 'not_allowed':
        return 'not_allowed'
      case 'disabled':
        return 'disabled'
      case null:
        break
      default:
        return 'unavailable'
    }

    // A function from before codes: its wording and status.
    if (message === 'There is nothing to reply to') return 'already_answered'
    if (message === 'The guidance assistant is not configured.') {
      return 'not_configured'
    }
    if (response.status === 504) return 'timeout'
    if (response.status === 429) return 'busy'
    if ([401, 403, 404].includes(response.status)) return 'not_allowed'
    return 'unavailable'
  }

  if (error instanceof FunctionsRelayError) return 'unavailable'

  // The request's own timeout aborts it. That can surface wrapped, while
  // waiting for the response, or bare, while reading its body.
  if (error instanceof FunctionsFetchError) {
    return isAbort(error.context) ? 'timeout' : 'network'
  }
  if (isAbort(error)) return 'timeout'

  return 'unavailable'
}
