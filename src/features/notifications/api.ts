import { isDuplicateKey } from '@/lib/ids'
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

/**
 * The longest message a doctor may send, as the database's own policy has it
 * from migration 41.
 */
export const NOTIFICATION_MESSAGE_MAX_LENGTH = 1000

/**
 * Module 7.1: a doctor sends a notification to one of their own patients.
 *
 * Who may be notified, and with what, is the database's to decide
 * (`notification_insert_doctor_to_patient`): an active doctor's own patient,
 * a `general` message of up to 1,000 characters.
 *
 * `notificationId` is the id the form chose for this message. Sending it
 * again - a second press that got through, a retry after a timeout whose
 * insert had in fact landed - is refused by the database as a duplicate key,
 * which means the message is already there: it is answered as sent, so the
 * patient gets it once.
 */
export async function sendNotificationToPatient(input: {
  notificationId?: string
  userId: string
  type: NotificationType
  message: string
}): Promise<void> {
  const { error } = await supabase.from('notification').insert({
    ...(input.notificationId ? { notification_id: input.notificationId } : {}),
    user_id: input.userId,
    notification_type: input.type,
    notification_message: input.message,
  })

  if (error && !(input.notificationId && isDuplicateKey(error))) throw error
}
