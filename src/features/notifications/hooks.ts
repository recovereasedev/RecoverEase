import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query-keys'

import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  sendNotificationToPatient,
} from './api'

export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications.list(),
    queryFn: () => fetchNotifications(),
  })
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: fetchUnreadCount,
    // The bell is on every screen. Refetching on an interval keeps it current
    // without opening a realtime subscription for a single integer; a minute
    // is well inside the useful window for a medication or appointment
    // reminder, and cheap.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.notifications.all,
      })
    },
  })
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.notifications.all,
      })
    },
  })
}

/**
 * Module 7.1: a doctor notifies one of their own patients.
 *
 * Nothing of the sender's is invalidated afterwards, because nothing of the
 * sender's changed: the notification is addressed to the patient, and the
 * doctor's own list and unread count are untouched by it.
 */
export function useSendNotificationToPatient() {
  return useMutation({ mutationFn: sendNotificationToPatient })
}
