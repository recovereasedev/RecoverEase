import {
  classifyReplyError,
  REPLY_TIMEOUT_MS,
  type ReplyFailure,
} from '@/features/chat/reply-failure'
import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type ChatSession = Tables<'chat_session'>
export type ChatMessage = Tables<'chat_message'>

/**
 * How long a read or write of the chat tables may take. Without a limit, a
 * request that is never answered keeps the page waiting with no way out -
 * the same failure the reply request had - so each one gives up and reports
 * an error instead.
 */
const DATA_TIMEOUT_MS = 15_000

function dataTimeout(): AbortSignal {
  return AbortSignal.timeout(DATA_TIMEOUT_MS)
}

/**
 * A new random id (UUID v4) for a message or conversation, chosen in the
 * browser so a save can be repeated without being duplicated.
 * `crypto.randomUUID` is missing from some older phones still in use (iOS
 * Safari before 15.4), so the same id is built from `getRandomValues`, which
 * they have.
 */
export function newChatId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 9562 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Postgres's "duplicate key" error. A save that comes back with it under an
 * id the browser chose was already made by an earlier attempt whose answer
 * was lost - a timeout after the database had committed it.
 */
function isDuplicateKey(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

/**
 * A save that did not come back saved.
 *
 * `certain` says whether it is known not to have happened. The server
 * refusing it (a 4xx answer) is certain. No answer at all - a dropped
 * connection, the browser's time limit, a gateway error - is not: the
 * database may have committed it before the answer was lost, so the patient
 * must not be told it failed.
 */
export class SaveFailedError extends Error {
  readonly certain: boolean

  constructor(certain: boolean, options?: { cause?: unknown }) {
    super(certain ? 'The save was refused.' : 'The save could not be confirmed.', options)
    this.name = 'SaveFailedError'
    this.certain = certain
  }
}

/** Whether a failed save's HTTP status leaves its outcome unknown. */
export function saveOutcomeUnknown(status: number): boolean {
  // 0: no answer (postgrest-js reports a dropped connection or an abort so).
  // 408 and 5xx: an intermediary gave up; the database may still have saved.
  return status === 0 || status === 408 || status >= 500
}

/**
 * Whether the guidance assistant is switched on for the signed-in patient:
 * the platform's switch and their clinic's both on (migration 38). The
 * server enforces it whatever this says - `chatbot-reply` refuses a
 * switched-off assistant before anything reaches the provider - so this only
 * lets the page say so instead of offering a message box that would be
 * refused.
 *
 * `null` when it cannot be told: the page then behaves as it always has, and
 * the server still decides.
 */
export async function fetchGuidanceAssistantAvailable(): Promise<boolean | null> {
  const { data, error } = await supabase
    .rpc('guidance_assistant_available')
    .abortSignal(dataTimeout())
  if (error) return null
  return typeof data === 'boolean' ? data : null
}

/** Module 8.4 "View Chat History / Past Conversations". */
export async function fetchChatSessions(
  patientId: string,
): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_session')
    .select('*')
    .eq('pat_id', patientId)
    .order('chat_session_started_at', { ascending: false })
    .abortSignal(dataTimeout())

  if (error) throw error
  return data
}

/** Modules 8.4 (patient) and 8.5 (doctor viewing a patient's transcript). */
export async function fetchChatMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_message')
    .select('*')
    .eq('chat_session_id', sessionId)
    .order('chat_message_created_at', { ascending: true })
    .abortSignal(dataTimeout())

  if (error) throw error
  return data
}

/** One of the patient's own conversations, by id, or null if there is none. */
export async function findOwnSession(sessionId: string): Promise<ChatSession | null> {
  const { data, error } = await supabase
    .from('chat_session')
    .select('*')
    .eq('chat_session_id', sessionId)
    .abortSignal(dataTimeout())
    .maybeSingle()

  if (error) throw error
  return data
}

/** One of the patient's own messages, by id, or null if there is none. */
export async function findOwnMessage(messageId: string): Promise<ChatMessage | null> {
  const { data, error } = await supabase
    .from('chat_message')
    .select('*')
    .eq('chat_message_id', messageId)
    .abortSignal(dataTimeout())
    .maybeSingle()

  if (error) throw error
  return data
}

/**
 * Starts a conversation under an id the browser chose. Sending again with
 * the same id never starts a second one: if an earlier attempt already
 * created it - and only its answer was lost - that conversation is returned.
 */
export async function createChatSession(
  patientId: string,
  sessionId: string,
): Promise<ChatSession> {
  const { data, error, status } = await supabase
    .from('chat_session')
    .insert({ chat_session_id: sessionId, pat_id: patientId })
    .select()
    .abortSignal(dataTimeout())
    .single()

  if (isDuplicateKey(error)) {
    const existing = await findOwnSession(sessionId)
    if (existing) return existing
  }
  if (error) {
    throw new SaveFailedError(!saveOutcomeUnknown(status), { cause: error })
  }
  return data
}

/**
 * Saves the patient's message under an id the browser chose. Sending it
 * again with the same id never saves it twice: if an earlier attempt already
 * saved it - and only its answer was lost - the saved message is returned,
 * as it was saved. If the patient has edited the text since, the returned
 * message is the earlier version: the caller compares and says so, rather
 * than saving the edit as a second message or overwriting the first.
 */
export async function appendPatientMessage(input: {
  sessionId: string
  content: string
  messageId: string
}): Promise<ChatMessage> {
  const { data, error, status } = await supabase
    .from('chat_message')
    .insert({
      chat_message_id: input.messageId,
      chat_session_id: input.sessionId,
      chat_message_role: 'patient',
      chat_message_content: input.content,
    })
    .select()
    .abortSignal(dataTimeout())
    .single()

  if (isDuplicateKey(error)) {
    const existing = await findOwnMessage(input.messageId)
    if (existing && existing.chat_session_id === input.sessionId) return existing
  }
  if (error) {
    throw new SaveFailedError(!saveOutcomeUnknown(status), { cause: error })
  }
  return data
}

/**
 * The patient's message is saved, but no reply came back. `reason` says
 * why, so the page can say what - if anything - the patient can do.
 */
export class ChatbotUnavailableError extends Error {
  readonly reason: ReplyFailure

  constructor(message: string, reason: ReplyFailure) {
    super(message)
    this.name = 'ChatbotUnavailableError'
    this.reason = reason
  }
}

/**
 * The patient's message is not known to be saved, so no reply was asked for.
 * `certain` is true when it is known not to have been saved, false when its
 * save could not be confirmed either way. Distinct from
 * `ChatbotUnavailableError`, after which the message is safe.
 */
export class MessageNotSentError extends Error {
  readonly certain: boolean

  constructor(certain: boolean, options?: { cause?: unknown }) {
    super(
      certain ? 'The message was not sent.' : 'The message could not be confirmed as sent.',
      options,
    )
    this.name = 'MessageNotSentError'
    this.certain = certain
  }
}

/**
 * An earlier version of this submission was saved - its answer was lost,
 * and the patient edited the text before sending again. The saved version
 * stands; the edit was not saved, and is not saved as a second message.
 */
export class EarlierVersionSavedError extends Error {
  readonly saved: ChatMessage

  constructor(saved: ChatMessage) {
    super('An earlier version of the message was saved.')
    this.name = 'EarlierVersionSavedError'
    this.saved = saved
  }
}

export type ChatReply = {
  /**
   * The reply, or null when there was nothing left to answer: a retry that
   * found the reply had been saved after all. Either way the conversation
   * is refetched to show it.
   */
  message: ChatMessage | null
  /**
   * True when module 8.2 flagged a critical concern. Not that a doctor was
   * told: the alert may be waiting for a clinician, or have failed to be
   * written (docs/critical-alert-escalation.md).
   */
  raisedCriticalConcern: boolean
}

/**
 * Module 8.1 "Chat with AI for Post-Treatment Guidance".
 *
 * The reply is produced by the `chatbot-reply` Edge Function, never in the
 * browser. Three things force that:
 *
 *   - the provider credential must not be in a client bundle;
 *   - module 8.7 lets an administrator set the system prompt, and a prompt
 *     the client supplies is a prompt the client can replace;
 *   - module 8.2 requires critical-concern detection to raise a doctor
 *     notification, and a check the patient's browser performs is a check the
 *     patient's browser can skip.
 *
 * If no reply comes back - the function is not deployed or has no provider
 * key, the provider is slow or busy, the connection drops - this throws
 * `ChatbotUnavailableError` with the reason, and the UI says so. It never
 * fabricates a reply: an invented answer in a health product is worse than
 * no answer.
 *
 * It only ever asks for a reply. The patient's message is saved first, by
 * `appendPatientMessage`, so calling this again - a retry - cannot send the
 * same message twice: the function answers whatever the latest unanswered
 * message is, or reports that there is none.
 */
export async function requestAssistantReply(
  sessionId: string,
): Promise<ChatReply> {
  const { data, error } = await supabase.functions.invoke<{
    message: ChatMessage
    raisedCriticalConcern: boolean
  }>('chatbot-reply', {
    body: { chatSessionId: sessionId },
    timeout: REPLY_TIMEOUT_MS,
  })

  if (error) {
    const outcome = await classifyReplyError(error)
    if (outcome === 'already_answered') {
      return { message: null, raisedCriticalConcern: false }
    }
    throw new ChatbotUnavailableError(
      'The guidance assistant did not reply.',
      outcome,
    )
  }

  if (!data?.message) {
    throw new ChatbotUnavailableError(
      'The guidance assistant did not return a reply.',
      'unavailable',
    )
  }

  return {
    message: data.message,
    raisedCriticalConcern: data.raisedCriticalConcern ?? false,
  }
}
