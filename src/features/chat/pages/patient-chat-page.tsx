import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Info, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  appendPatientMessage,
  ChatbotUnavailableError,
  createChatSession,
  fetchChatMessages,
  fetchChatSessions,
  requestAssistantReply,
} from '@/features/chat/api'
import { formatDateTime, formatTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'

/**
 * Modules 8.1 "Chat with AI for Post-Treatment Guidance" and 8.4 "View Chat
 * History".
 *
 * Every message is persisted before anything is displayed, so the transcript
 * a doctor reads under module 8.5 is exactly what the patient saw. Nothing is
 * rendered optimistically and then lost.
 *
 * When the assistant is unavailable the page says so plainly. It never
 * substitutes a canned reply: an invented answer to a question about
 * post-treatment symptoms is worse than no answer at all.
 */
export function PatientChatPage() {
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const sessionsQuery = useQuery({
    queryKey: queryKeys.chat.sessionsFor(patientId),
    queryFn: () => fetchChatSessions(patientId),
    enabled: Boolean(patientId),
  })

  /**
   * Which conversation is open.
   *
   * Three states, which is why this is not a plain `string | null`:
   *   undefined  the patient has not chosen, so show the most recent
   *   null       they explicitly started a new conversation
   *   string     they picked one from the history list
   *
   * Deriving it this way means the newest conversation opens on arrival
   * without an effect copying it into state after the query resolves.
   */
  const [chosenSessionId, setChosenSessionId] = useState<
    string | null | undefined
  >(undefined)

  const activeSessionId =
    chosenSessionId !== undefined
      ? chosenSessionId
      : (sessionsQuery.data?.[0]?.chat_session_id ?? null)

  const setActiveSessionId = setChosenSessionId

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messagesFor(activeSessionId ?? ''),
    queryFn: () => fetchChatMessages(activeSessionId as string),
    enabled: Boolean(activeSessionId),
  })

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messagesQuery.data])

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      let sessionId = activeSessionId

      if (!sessionId) {
        const session = await createChatSession(patientId)
        sessionId = session.chat_session_id
        setActiveSessionId(sessionId)
      }

      await appendPatientMessage({ sessionId, content })

      // Show the patient's own message immediately, before waiting on a reply
      // that may not come.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chat.messagesFor(sessionId),
      })

      return requestAssistantReply(sessionId)
    },
    onSuccess: () => {
      setUnavailableReason(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
    },
    onError: (error) => {
      setUnavailableReason(
        error instanceof ChatbotUnavailableError
          ? 'The guidance assistant is not available at the moment. Your message has been saved, and your care team can still see it.'
          : 'Something went wrong sending that message. Your message has been saved.',
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
    },
  })

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return
    setDraft('')
    sendMessage.mutate(content)
  }

  const activeSession = sessionsQuery.data?.find(
    (session) => session.chat_session_id === activeSessionId,
  )

  return (
    <>
      <PageHeader
        title="Guidance chat"
        description="Ask about your recovery between appointments."
      />

      {/* Stated before the conversation, not buried under it. */}
      <div className="mb-5 flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-info-200 bg-info-50 p-4 text-sm text-info-800">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          This assistant offers general guidance about recovery. It does not
          diagnose conditions and cannot change your treatment. If you feel
          unwell or something is urgent, contact your doctor or emergency
          services directly.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <Card className="flex min-h-[28rem] flex-col">
          <CardHeader
            title={
              activeSession
                ? `Conversation from ${formatDateTime(activeSession.chat_session_started_at)}`
                : 'New conversation'
            }
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setActiveSessionId(null)
                  setUnavailableReason(null)
                }}
              >
                Start new
              </Button>
            }
          />

          <CardBody className="flex-1 overflow-y-auto">
            {activeSession?.chat_session_has_critical_flag ? (
              <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <p>
                  Something you raised in this conversation was flagged for
                  your doctor, and they have been notified.
                </p>
              </div>
            ) : null}

            {!activeSessionId ? (
              <p className="py-10 text-center text-sm text-muted">
                Ask a question below to start a conversation.
              </p>
            ) : (
              <StateView
                isPending={messagesQuery.isPending}
                error={messagesQuery.error}
                data={messagesQuery.data}
                onRetry={() => void messagesQuery.refetch()}
                empty={
                  <p className="py-10 text-center text-sm text-muted">
                    No messages in this conversation yet.
                  </p>
                }
              >
                {(messages) => (
                  <ul className="space-y-3">
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
                              'max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5',
                              isPatient
                                ? 'bg-brand-600 text-white'
                                : 'bg-surface-sunken text-body',
                            )}
                          >
                            <p className="sr-only">
                              {isPatient ? 'You said:' : 'Assistant said:'}
                            </p>
                            <p className="whitespace-pre-wrap text-sm leading-relaxed">
                              {message.chat_message_content}
                            </p>
                            <p
                              className={cn(
                                'mt-1 text-[11px]',
                                isPatient ? 'text-white/70' : 'text-muted',
                              )}
                            >
                              {formatTime(message.chat_message_created_at)}
                            </p>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </StateView>
            )}

            {unavailableReason ? (
              <p
                role="status"
                className="mt-4 rounded-[var(--radius-md)] border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800"
              >
                {unavailableReason}
              </p>
            ) : null}

            <div ref={transcriptEndRef} />
          </CardBody>

          <form
            onSubmit={onSubmit}
            className="flex items-end gap-2 border-t border-[var(--color-border)] p-4"
          >
            <label htmlFor="chat-draft" className="sr-only">
              Your message
            </label>
            <textarea
              id="chat-draft"
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter makes a new line — the convention
                // people already have from every other messaging interface.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onSubmit(event)
                }
              }}
              placeholder="Is it normal for swelling to come back after exercise?"
              className="flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-2.5 text-base text-heading placeholder:text-neutral-400"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!draft.trim()}
              isLoading={sendMessage.isPending}
              loadingLabel="Sending…"
              aria-label="Send message"
            >
              <Send aria-hidden="true" />
            </Button>
          </form>
        </Card>

        {/* --- Past conversations — module 8.4 --------------------------- */}
        <Card className="h-fit">
          <CardHeader title="Past conversations" as="h3" />
          <CardBody className="p-0">
            <StateView
              isPending={sessionsQuery.isPending}
              error={sessionsQuery.error}
              data={sessionsQuery.data}
              empty={
                <p className="px-5 py-6 text-sm text-muted">
                  Your previous conversations will be listed here.
                </p>
              }
            >
              {(sessions) => (
                <ul className="divide-y divide-[var(--color-border)]">
                  {sessions.map((session) => (
                    <li key={session.chat_session_id}>
                      <button
                        type="button"
                        onClick={() =>
                          setActiveSessionId(session.chat_session_id)
                        }
                        aria-current={
                          session.chat_session_id === activeSessionId
                            ? 'true'
                            : undefined
                        }
                        className={cn(
                          'w-full px-5 py-3 text-left text-sm transition-colors hover:bg-neutral-50',
                          session.chat_session_id === activeSessionId &&
                            'bg-brand-50',
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
                            <AlertTriangle
                              className="size-3"
                              aria-hidden="true"
                            />
                            Flagged for your doctor
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </StateView>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
