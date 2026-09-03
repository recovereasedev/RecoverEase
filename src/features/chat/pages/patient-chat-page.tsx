import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
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
      {/* No subtitle. "Ask about your recovery between appointments" is
          said better, and at more length, by the notice directly below it -
          and on a phone those two lines came out of the conversation. */}
      <PageHeader eyebrow="Recovery guidance" title="Guidance chat" />

      {/* Stated before the conversation, not buried under it. Standing
          guidance, so it is not announced: it was on the page all along. */}
      <Notice tone="info" className="mb-5">
        This assistant offers general guidance about recovery. It does not
        diagnose conditions and cannot change your treatment. If you feel
        unwell or something is urgent, contact your doctor or emergency
        services directly.
      </Notice>

      <div className="grid gap-5 lg:h-[calc(100dvh-17rem)] lg:grid-cols-[1fr_18rem]">
        {/*
          The conversation is sized from the viewport, not from its contents.

          A cap alone is not enough: the card starts about 400px down the page
          on a phone, under the page heading and the disclaimer, so capping it
          at "a screen" still puts the composer a screen below the fold. The
          subtracted height is everything else that is on screen at the same
          time - the app header, this page's heading, the disclaimer, and the
          bottom navigation bar. `min-h` keeps it usable if that estimate is
          ever wrong on an unusually short viewport, at the cost of the page
          scrolling, which is the safe direction to be wrong in.

          The result is that the transcript is the only thing that scrolls and
          the composer is always where the thumb already is.
        */}
        <Card className="flex h-[calc(100dvh-26rem)] min-h-[20rem] flex-col lg:h-auto lg:min-h-0">
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

          {/*
            `min-h-0` is load-bearing. A flex child defaults to `min-height:
            auto`, which refuses to shrink below its content, so without it
            `flex-1 overflow-y-auto` never scrolls - the card just grows and
            takes the composer with it.
          */}
          <CardBody className="min-h-0 flex-1 overflow-y-auto">
            {activeSession?.chat_session_has_critical_flag ? (
              <Notice tone="warning" className="mb-4">
                Something you raised in this conversation was flagged for your
                doctor, and they have been notified.
              </Notice>
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
                              'max-w-[88%] rounded-[var(--radius-lg)] px-3.5 py-2.5 sm:max-w-[85%] sm:px-4',
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
              <Notice tone="warning" live="polite" className="mt-4">
                {unavailableReason}
              </Notice>
            ) : null}

            <div ref={transcriptEndRef} />
          </CardBody>

          <form
            onSubmit={onSubmit}
            className="flex shrink-0 items-end gap-2 border-t border-[var(--color-border)] p-3 sm:p-4"
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
              // 16px keeps iOS from zooming the viewport on focus, which
              // on a fixed-height conversation would push the composer out of
              // view the moment the keyboard opens.
              className="min-w-0 flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-2.5 text-base text-heading placeholder:text-neutral-400"
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

        {/* --- Past conversations — module 8.4 ---------------------------
            Below the conversation on a phone, beside it from `lg`. Rendered
            once either way: hiding it on small screens would remove module
            8.4, and rendering it twice would put every history button in the
            document twice. */}
        <Card className="h-fit lg:min-h-0 lg:overflow-y-auto">
          <CardHeader title="Past conversations" as="h2" />
          <CardBody className="p-0">
            <StateView
              isPending={sessionsQuery.isPending}
              error={sessionsQuery.error}
              data={sessionsQuery.data}
              empty={
                <p className="px-4 py-6 text-sm text-muted sm:px-5">
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
                          'w-full px-4 py-3 text-left text-sm transition-colors hover:bg-neutral-100 sm:px-5',
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
