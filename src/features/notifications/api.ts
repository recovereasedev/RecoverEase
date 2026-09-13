import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

export type Notification = Tables<'notification'>
export type NotificationType = Enums<'notification_type'>

/**
 * A notification with the patient of the conversation it concerns, which
 * only a critical-chat alert has (module 8.5). Null when there is none, or
 * when the reader may not see that conversation.
 */
export type NotificationWithConversation = Notification & {
  chat_session: Pick<Tables<'chat_session'>, 'pat_id'> | null
}

/**
 * Notifications addressed to the current user.
 *
 * No user filter is applied in the query: the RLS policy on `notification`
 * already restricts rows to `user_id = auth.uid()`. Adding a redundant
 * `.eq('user_id', …)` here would imply the filter is what provides the
 * privacy, which it is not.
 *
 * A critical-chat alert comes back with its conversation's patient, in the
 * same request, so it can link to the transcript. That embed is read through
 * `chat_session`'s own policy: the patient's assigned doctor gets the patient,
 * anyone else gets null and so no link.
 */
export async function fetchNotifications(
  limit = 50,
): Promise<NotificationWithConversation[]> {
  const { data, error } = await supabase
    .from('notification')
    .select('*, chat_session ( pat_id )')
    .order('notification_created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data
}

export async function fetchUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notification')
    .select('notification_id', { count: 'exact', head: true })
    .eq('notification_is_read', false)

  if (error) throw error
  return count ?? 0
}

export async function markNotificationRead(
  notificationId: string,
): Promise<void> {
  const { error } = await supabase
    .from('notification')
    .update({ notification_is_read: true })
    .eq('notification_id', notificationId)

  if (error) throw error
}

export async function markAllNotificationsRead(): Promise<void> {
  const { error } = await supabase
    .from('notification')
    .update({ notification_is_read: true })
    .eq('notification_is_read', false)

  if (error) throw error
}

/** Module 7.1: a doctor sends a notification to one of their own patients. */
export async function sendNotificationToPatient(input: {
  userId: string
  type: NotificationType
  message: string
}): Promise<void> {
  const { error } = await supabase.from('notification').insert({
    user_id: input.userId,
    notification_type: input.type,
    notification_message: input.message,
  })

  if (error) throw error
}
