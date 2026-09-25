import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ClipboardList,
  Megaphone,
  Pill,
  type LucideIcon,
} from 'lucide-react'
import { useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import type { UserRole } from '@/features/auth/types'
import type { NotificationType } from '@/features/notifications/api'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/features/notifications/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
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

/**
 * What this page holds, in the reader's own terms. The same page is mounted in
 * all three portals - /patient, /doctor and /admin - and "about your care" is
 * only true for a patient. Read from the route, which is where the portal is
 * already decided.
 */
const DESCRIPTION: Record<UserRole, string> = {
  patient: 'Reminders and updates about your care.',
  doctor: 'Alerts and updates about your patients.',
  admin: 'Updates about the system.',
}

/** Module 7.3 "View Notifications and Reminders". */
export function NotificationsPage() {
  useDocumentTitle('Notifications')
  const portal = useLocation().pathname.split('/')[1]
  const role: UserRole =
    portal === 'doctor' || portal === 'admin' ? portal : 'patient'
  const notificationsQuery = useNotifications()
  const markRead = useMarkNotificationRead()
  // The notifications being marked read right now. "Mark read" shows no
  // saving state, so a second press before its row updates sent the same
  // request again; it is now ignored until the first has finished.
  const markingRead = useRef(new Set<string>())
  const markOneRead = (id: string) => {
    if (markingRead.current.has(id)) return
    markingRead.current.add(id)
    // mutateAsync, so this runs for every press: mutate's own callbacks run
    // only for the latest call, and a failure must be retryable.
    void markRead
      .mutateAsync(id)
      .catch(() => undefined)
      .finally(() => markingRead.current.delete(id))
  }
  const markAllRead = useMarkAllNotificationsRead()
  // "Mark read" leaves with its row's unread state, and "Mark all as read"
  // with the last unread one: keyboard focus moves on to the next
  // notification's control, or to the page, rather than to its top. A plain
  // block around the header and the list, so both are inside it.
  const focusRecovery = useFocusRecovery()

  const unreadCount =
    notificationsQuery.data?.filter((n) => !n.notification_is_read).length ?? 0

  return (
    <div ref={focusRecovery}>
      <PageHeader
        title="Notifications"
        description={DESCRIPTION[role]}
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              className="max-sm:w-full"
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
              <EmptyState
                icon={Bell}
                title="You are all caught up"
                description="Reminders about medication and appointments will appear here."
              />
            }
          >
            {(notifications) => (
              <ul className="divide-y divide-[var(--color-border)]">
                {notifications.map((notification) => {
                  const Icon = TYPE_ICON[notification.notification_type]
                  const isUnread = !notification.notification_is_read
                  const isCritical =
                    notification.notification_type === 'chat_critical'
                  // Module 8.5: a critical-chat alert opens the conversation
                  // it is about. The patient is only there when the database
                  // lets this reader see that conversation, which is the
                  // patient's assigned doctor; otherwise there is no link.
                  const conversationPatientId = isCritical
                    ? notification.chat_session?.pat_id
                    : undefined
                  const conversationPath =
                    conversationPatientId && notification.chat_session_id
                      ? `/doctor/patients/${conversationPatientId}?tab=chat&session=${notification.chat_session_id}`
                      : null

                  return (
                    <li
                      key={notification.notification_id}
                      // Stacks on a phone: a "Mark read" button competing with
                      // the message for a 311px line leaves the message about
                      // 150px, which turns two lines of text into five.
                      className={cn(
                        'relative flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-start sm:gap-3 sm:px-5',
                        // Unread carries three cues, none of them colour on
                        // its own: an accent down the leading edge, a tint,
                        // and the weight of the message itself. A flagged
                        // conversation keeps the warning tone it has
                        // everywhere else in the application rather than the
                        // portal's accent.
                        //
                        // The bar is its own layer, drawn inside the row's
                        // box so marking one read moves nothing, and it
                        // leaves by opacity alone: the compositor fades it,
                        // where a box-shadow fade repainted the row's whole
                        // shadow stack on every frame. Its colour is set in
                        // both states, so it fades rather than vanishing.
                        "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:opacity-0 before:content-['']",
                        isCritical
                          ? 'before:bg-[var(--color-warning-600)]'
                          : 'before:bg-[var(--color-role)]',
                        // Marking one read is a state change the reader just
                        // made: the tint and the bar ease out together rather
                        // than the row blinking to plain under the pointer.
                        'transition-colors duration-[var(--duration-base)] ease-[var(--ease-out-soft)]',
                        'before:transition-opacity before:duration-[var(--duration-base)] before:ease-[var(--ease-out-soft)]',
                        isUnread &&
                          (isCritical
                            ? 'bg-warning-50 before:opacity-100'
                            : 'bg-role-soft/40 before:opacity-100'),
                      )}
                    >
                      <div className="flex min-w-0 gap-3 sm:flex-1">
                        {/* The glyph says what kind of update this is. It
                            needs no tile of its own to do that - the tinted
                            circle was the 2.0 pattern this application took
                            off every other screen. */}
                        <Icon
                          className={cn(
                            'mt-0.5 size-5 shrink-0',
                            isCritical ? 'text-warning-700' : 'text-neutral-500',
                          )}
                          aria-hidden="true"
                        />

                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-body',
                              isUnread && 'font-medium text-heading',
                            )}
                          >
                            {/* Unread is signalled by a word as well as by the
                                tint and weight, so it does not rely on
                                colour. */}
                            {isUnread ? (
                              <span className="sr-only">Unread. </span>
                            ) : null}
                            {notification.notification_message}
                          </p>
                          <p className="mt-0.5 text-sm text-muted">
                            {formatRelative(
                              notification.notification_created_at,
                            )}
                          </p>
                        </div>
                      </div>

                      {isUnread || conversationPath ? (
                        <div className="flex gap-2 max-sm:self-end sm:shrink-0">
                          {conversationPath ? (
                            <Link
                              to={conversationPath}
                              className={buttonVariants({
                                size: 'sm',
                                variant: 'outline',
                              })}
                            >
                              View conversation
                              <span className="sr-only">
                                : {notification.notification_message}
                              </span>
                            </Link>
                          ) : null}
                          {isUnread ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                markOneRead(notification.notification_id)
                              }
                            >
                              Mark read
                              <span className="sr-only">
                                : {notification.notification_message}
                              </span>
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </StateView>
        </CardBody>
      </Card>
    </div>
  )
}
