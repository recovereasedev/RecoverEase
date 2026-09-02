import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type ChatSession = Tables<'chat_session'>
export type ChatMessage = Tables<'chat_message'>

/** Module 8.4 "View Chat History / Past Conversations". */
export async function fetchChatSessions(
  patientId: string,
): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_session')
    .select('*')
    .eq('pat_id', patientId)
    .order('chat_session_started_at', { ascending: false })

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
    .single()

  if (error) throw error
  return data
}

export class ChatbotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatbotUnavailableError'
  }
}

export type ChatReply = {
  message: ChatMessage
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
 * If the function is not deployed or has no provider key, this throws
 * `ChatbotUnavailableError` and the UI says the assistant is unavailable. It
 * does not fabricate a reply: an invented answer in a health product is worse
 * than no answer.
 */
export async function requestAssistantReply(
  sessionId: string,
): Promise<ChatReply> {
  const { data, error } = await supabase.functions.invoke<{
    message: ChatMessage
    raisedCriticalConcern: boolean
  }>('chatbot-reply', {
    body: { chatSessionId: sessionId },
  })

  if (error) {
    throw new ChatbotUnavailableError(
      'The guidance assistant is not available right now.',
    )
  }

  if (!data?.message) {
    throw new ChatbotUnavailableError(
      'The guidance assistant did not return a reply.',
    )
  }

  return {
    message: data.message,
    raisedCriticalConcern: data.raisedCriticalConcern ?? false,
  }
}
