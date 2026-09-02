import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ClipboardList,
  Megaphone,
  Pill,
  type LucideIcon,
} from 'lucide-react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import type { NotificationType } from '@/features/notifications/api'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/features/notifications/hooks'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Each notification type carries its own icon, so the kind of update is
 * recognisable before the text is read. `chat_critical` is the only one given
 * a warning tone — if everything were urgent, nothing would be.
 */
const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  appointment: CalendarDays,
  medication: Pill,
  treatment: ClipboardList,
  chat_critical: AlertTriangle,
  announcement: Megaphone,
  general: Bell,
}

/** Module 7.3 "View Notifications and Reminders". */
export function NotificationsPage() {
  const notificationsQuery = useNotifications()
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()

  const unreadCount =
    notificationsQuery.data?.filter((n) => !n.notification_is_read).length ?? 0

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Reminders and updates about your care."
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              onClick={() => markAllRead.mutate()}
              isLoading={markAllRead.isPending}
            >
              Mark all as read
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardBody className="p-0">
          <StateView
            isPending={notificationsQuery.isPending}
            error={notificationsQuery.error}
            data={notificationsQuery.data}
            onRetry={() => void notificationsQuery.refetch()}
            empty={
              <div className="px-5 py-12 text-center">
                <Bell
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  You are all caught up
                </p>
                <p className="mt-1 text-sm text-muted">
                  Reminders about medication and appointments will appear here.
                </p>
              </div>
            }
          >
            {(notifications) => (
              <ul className="divide-y divide-[var(--color-border)]">
                {notifications.map((notification) => {
                  const Icon = TYPE_ICON[notification.notification_type]
                  const isUnread = !notification.notification_is_read
                  const isCritical =
                    notification.notification_type === 'chat_critical'

                  return (
                    <li
                      key={notification.notification_id}
                      className={cn(
                        'flex gap-3 px-5 py-4',
                        isUnread && 'bg-brand-50/40',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-full',
                          isCritical ? 'bg-warning-100' : 'bg-neutral-100',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-4',
                            isCritical
                              ? 'text-warning-800'
                              : 'text-neutral-600',
                          )}
                          aria-hidden="true"
                        />
                      </span>

                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'text-body',
                            isUnread && 'font-medium text-heading',
                          )}
                        >
                          {/* Unread is signalled by a word as well as by the
                              tint and weight, so it does not rely on colour. */}
                          {isUnread ? (
                            <span className="sr-only">Unread. </span>
                          ) : null}
                          {notification.notification_message}
                        </p>
                        <p className="mt-0.5 text-sm text-muted">
                          {formatRelative(notification.notification_created_at)}
                        </p>
                      </div>

                      {isUnread ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            markRead.mutate(notification.notification_id)
                          }
                        >
                          Mark read
                          <span className="sr-only">
                            : {notification.notification_message}
                          </span>
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </StateView>
        </CardBody>
      </Card>
    </>
  )
}
