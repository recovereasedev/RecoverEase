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

export async function createChatSession(
  patientId: string,
): Promise<ChatSession> {
  const { data, error } = await supabase
    .from('chat_session')
    .insert({ pat_id: patientId })
    .select()
    .abortSignal(dataTimeout())
    .single()

  if (error) throw error
  return data
}

export async function appendPatientMessage(input: {
  sessionId: string
  content: string
}): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from('chat_message')
    .insert({
      chat_session_id: input.sessionId,
      chat_message_role: 'patient',
      chat_message_content: input.content,
    })
    .select()
    .abortSignal(dataTimeout())
    .single()

  if (error) throw error
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
 * The patient's message itself was not saved - nothing was sent to the
 * assistant, and nothing is waiting on a reply. Distinct from
 * `ChatbotUnavailableError`, after which the message is safe.
 */
export class MessageNotSentError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The message was not sent.', options)
    this.name = 'MessageNotSentError'
  }
}

export type ChatReply = {
  /**
   * The reply, or null when there was nothing left to answer: a retry that
   * found the reply had been saved after all. Either way the conversation
   * is refetched to show it.
   */
  message: ChatMessage | null
  /** True when module 8.2 flagged a critical concern and alerted the doctor. */
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
