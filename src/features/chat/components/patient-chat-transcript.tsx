import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, MessagesSquare } from 'lucide-react'
import { useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { fetchChatMessages, fetchChatSessions } from '@/features/chat/api'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'

/**
 * Module 8.5 "View Patient Chat Transcript": a patient's guidance chat as
 * their doctor reads it. Read-only; the doctor cannot write into it.
 *
 * The text is exactly what was stored, and the patient chat stores every
 * message before showing it, so this is exactly what the patient saw. Who may
 * read it is the database's decision: `chat_session` and `chat_message` are
 * readable only by the patient and their assigned, active doctor. This adds a
 * view, not a permission.
 *
 * `initialSessionId` opens one conversation, which is how a critical-chat
 * notification lands on the conversation it is about. An id that is not one
 * of this patient's conversations is ignored in favour of the most recent,
 * rather than leaving the doctor with nothing.
 */
export function PatientChatTranscript({
  patientId,
  initialSessionId,
}: {
  patientId: string
  initialSessionId?: string | null
}) {
  const sessionsQuery = useQuery({
    queryKey: queryKeys.chat.sessionsFor(patientId),
    queryFn: () => fetchChatSessions(patientId),
    enabled: Boolean(patientId),
  })
  const [chosenSessionId, setChosenSessionId] = useState<string | null>(null)

  // Newest first, as the query returns them.
  const sessions = sessionsQuery.data ?? []
  const isListed = (id: string | null | undefined) =>
    sessions.some((session) => session.chat_session_id === id)
  const activeSessionId = isListed(chosenSessionId)
    ? chosenSessionId
    : isListed(initialSessionId)
      ? (initialSessionId ?? null)
      : (sessions[0]?.chat_session_id ?? null)
  const activeSession =
    sessions.find((session) => session.chat_session_id === activeSessionId) ??
    null

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messagesFor(activeSessionId ?? ''),
    queryFn: () => fetchChatMessages(activeSessionId as string),
    enabled: Boolean(activeSessionId),
  })

  return (
    <StateView
      isPending={sessionsQuery.isPending}
      error={sessionsQuery.error}
      data={sessionsQuery.data}
      onRetry={() => void sessionsQuery.refetch()}
      loadingLabel="Loading conversations…"
      empty={
        <Card>
          <CardBody className="py-10 text-center">
            <MessagesSquare
              className="mx-auto size-6 text-neutral-400"
              aria-hidden="true"
            />
            <p className="mt-2 font-medium text-heading">No guidance chat yet</p>
            <p className="mt-1 text-sm text-muted">
              This patient has not used the guidance chat.
            </p>
          </CardBody>
        </Card>
      }
    >
      {(conversations) => (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="min-w-0 lg:col-span-2">
            <CardHeader
              title="Guidance chat"
              description={
                activeSession
                  ? `Started ${formatDateTime(activeSession.chat_session_started_at)}. What the patient and the assistant wrote, exactly as it was recorded.`
                  : undefined
              }
            />
            <CardBody>
              {activeSession?.chat_session_has_critical_flag ? (
                <Notice tone="warning" className="mb-4">
                  This conversation was flagged for your attention.
                  {activeSession.chat_session_summary
                    ? ` ${activeSession.chat_session_summary}`
                    : ''}
                </Notice>
              ) : null}

              <StateView
                isPending={messagesQuery.isPending}
                error={messagesQuery.error}
                data={messagesQuery.data}
                onRetry={() => void messagesQuery.refetch()}
                loadingLabel="Loading conversation…"
                empty={
                  <p className="py-10 text-center text-sm text-muted">
                    No messages in this conversation.
                  </p>
                }
              >
                {(messages) => (
                  // Oldest first, as the query returns them: a conversation
                  // reads top to bottom.
                  <ol className="space-y-3" aria-label="Conversation">
                    {messages.map((message) => {
                      const isPatient = message.chat_message_role === 'patient'
                      return (
                        <li
                          key={message.chat_message_id}
                          className={cn(
                            'flex',
                            isPatient ? 'justify-end' : 'justify-start',
                          )}
                        >
                          <div
                            className={cn(
                              'min-w-0 max-w-[88%] rounded-[var(--radius-lg)] px-3.5 py-2.5 sm:max-w-[85%] sm:px-4',
                              isPatient
                                ? 'bg-brand-600 text-white'
                                : 'bg-surface-sunken text-body',
                            )}
                          >
                            {/* A visible speaker, not only a side and a colour. */}
                            <p
                              className={cn(
                                'text-xs font-semibold',
                                isPatient ? 'text-white/80' : 'text-muted',
                              )}
                            >
                              {isPatient ? 'Patient' : 'Assistant'}
                            </p>
                            {/* `anywhere`, not `break-word`: only it lets an
                                unbroken link shrink the column on a phone. */}
                            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
                              {message.chat_message_content}
                            </p>
                            <p
                              className={cn(
                                'mt-1 text-xs',
                                isPatient ? 'text-white/70' : 'text-muted',
                              )}
                            >
                              <time dateTime={message.chat_message_created_at}>
                                {formatDateTime(message.chat_message_created_at)}
                              </time>
                            </p>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </StateView>
            </CardBody>
          </Card>

          <Card className="h-fit">
            <CardHeader title="Conversations" as="h2" />
            <CardBody className="p-0">
              <ul
                className="divide-y divide-[var(--color-border)]"
                aria-label="Conversations"
              >
                {conversations.map((session) => {
                  const isActive = session.chat_session_id === activeSessionId
                  return (
                    <li key={session.chat_session_id}>
                      <button
                        type="button"
                        onClick={() => setChosenSessionId(session.chat_session_id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={cn(
                          'w-full px-4 py-3 text-left text-sm transition-colors hover:bg-neutral-100 sm:px-5',
                          isActive && 'bg-brand-50',
                        )}
                      >
                        <span className="block font-medium text-heading">
                          {formatDateTime(session.chat_session_started_at)}
                        </span>
                        {session.chat_session_summary ? (
                          <span className="mt-0.5 block line-clamp-2 text-muted">
                            {session.chat_session_summary}
                          </span>
                        ) : null}
                        {session.chat_session_has_critical_flag ? (
                          <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warning-800">
                            <AlertTriangle className="size-3" aria-hidden="true" />
                            Flagged for your attention
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </StateView>
  )
}
