import { AlertTriangle, MessageSquareOff, type LucideIcon } from 'lucide-react'

import type { NotificationType } from '@/features/notifications/api'

/**
 * The two things a `chat_critical` notification can mean.
 *
 * - `concern`: the guidance assistant judged that the patient raised
 *   something that may need the doctor (module 8.2). Clinical attention,
 *   so amber.
 * - `unanswered`: the assistant could not reply at all - a timeout, an
 *   outage. Nothing is known about what the patient wrote, so it is shown
 *   as the service fault it is, in neutral grey.
 *
 * Both share one type, so the backend tells them apart by its own fixed
 * message (`supabase/functions/_shared/critical-escalation.ts` and
 * `escalation.ts`; tests/unit/chat-alert.test.ts keeps these copies equal).
 * Nothing here reads what the patient wrote. Any other chat-alert wording is
 * treated as a concern, so a real one is never played down.
 */
export type ChatAlertKind = 'concern' | 'unanswered'

const UNANSWERED_MESSAGE =
  "The guidance assistant could not answer a patient's message. Please review the conversation."

export function chatAlertKind(notification: {
  notification_type: NotificationType
  notification_message: string
}): ChatAlertKind | null {
  if (notification.notification_type !== 'chat_critical') return null
  return notification.notification_message === UNANSWERED_MESSAGE ? 'unanswered' : 'concern'
}

export const CHAT_ALERT: Record<
  ChatAlertKind,
  { label: string; summary: string; icon: LucideIcon; tone: 'warning' | 'neutral' }
> = {
  concern: {
    label: 'Possible concern',
    summary: 'A patient raised a concern in the guidance chat.',
    icon: AlertTriangle,
    tone: 'warning',
  },
  unanswered: {
    label: 'Unanswered message',
    summary: "The assistant couldn't answer a patient's message.",
    icon: MessageSquareOff,
    tone: 'neutral',
  },
}
