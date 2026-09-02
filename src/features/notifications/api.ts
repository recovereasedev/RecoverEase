import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

export type Notification = Tables<'notification'>
export type NotificationType = Enums<'notification_type'>

/**
 * Notifications addressed to the current user.
 *
 * No user filter is applied in the query: the RLS policy on `notification`
 * already restricts rows to `user_id = auth.uid()`. Adding a redundant
 * `.eq('user_id', …)` here would imply the filter is what provides the
 * privacy, which it is not.
 */
export async function fetchNotifications(limit = 50): Promise<Notification[]> {
  const { data, error } = await supabase
    .from('notification')
    .select('*')
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
