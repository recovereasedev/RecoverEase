import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  History,
  RotateCw,
  Send,
  SquarePen,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  appendPatientMessage,
  ChatbotUnavailableError,
  type ChatMessage,
  createChatSession,
  EarlierVersionSavedError,
  fetchChatMessages,
  fetchChatSessions,
  fetchGuidanceAssistantAvailable,
  findOwnMessage,
  MessageNotSentError,
  newChatId,
  requestAssistantReply,
  SaveFailedError,
} from '@/features/chat/api'
import { AssistantAvatar } from '@/features/chat/components/assistant-avatar'
import {
  FLAGGED_CONVERSATION_BADGE,
  FLAGGED_CONVERSATION_NOTICE,
} from '@/features/chat/flag-notice'
import {
  forgetPendingSend,
  loadPendingSends,
  type PendingSend,
  pendingSendFor,
  rememberPendingSend,
} from '@/features/chat/pending-send'
import {
  canRetry,
  MAX_REPLY_RETRIES,
  type ReplyFailure,
  SLOW_REPLY_MS,
} from '@/features/chat/reply-failure'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateRelative, formatDateTime, formatTime } from '@/lib/format'
import { refocusAfterKeyboardSubmit } from '@/lib/form-focus'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'

const ASSISTANT = 'Recovery Guidance Assistant'

/** Matches the `chat-fit` variant in index.css. */
const FITTED = '(min-width: 64rem) and (min-height: 50rem)'

/**
 * Openers for a new conversation. Choosing one only fills the composer - the
 * patient still reads it, can change it, and sends it themselves.
 */
const SUGGESTIONS = [
  'How can I stay on track with my recovery plan?',
  'What should I remember before my follow-up appointment?',
  'How can I keep track of my recovery progress?',
]

/** How the last send, or request for a reply, in a conversation ended. */
type Failure =
  | ReplyFailure
  /** The message is known not to have been saved. */
  | 'not_sent'
  /** The message's save could not be confirmed either way. */
  | 'unconfirmed'
  /** An unconfirmed message turned out to be saved, as sent. */
  | 'sent_after_all'
  /** It turned out to be saved as sent before the patient edited it. */
  | 'sent_earlier_version'

/** The outcomes that are about the reply, not about the patient's message. */
function isReplyFailure(failure: Failure): failure is ReplyFailure {
  return (
    failure !== 'not_sent' &&
    failure !== 'unconfirmed' &&
    failure !== 'sent_after_all' &&
    failure !== 'sent_earlier_version'
  )
}

/** A send: the ids of its submission, and the text sent this time. */
type Send = { pending: PendingSend; content: string }

/**
 * What the patient is told when no reply came back. Every message says
 * whether their own message is safe. Those that can be retried say nothing
 * about retrying - the Try again button under them does.
 */
function failureMessage(failure: Failure, retriesLeft: number): string {
  if (failure === 'not_sent') {
    return 'Your message wasn’t sent. Check your internet connection, then send it again.'
  }
  if (failure === 'unconfirmed') {
    // Never "wasn't sent": it may have been. Sending again is safe - it
    // reuses the same message, so it cannot be saved twice.
    return 'We couldn’t confirm your message was sent. Check your internet connection, then send it again. It won’t be sent twice.'
  }
  if (failure === 'sent_after_all') {
    return 'Your message was sent.'
  }
  if (failure === 'sent_earlier_version') {
    return 'Your message was sent before you changed it, so your changes weren’t sent. They’re still in the message box if you want to send them.'
  }
  if (canRetry(failure) && retriesLeft <= 0) {
    return 'The guidance assistant still isn’t replying. Your message has been saved, and your care team can still see it.'
  }
  switch (failure) {
    case 'timeout':
      return 'The guidance assistant took too long to reply. Your message has been saved.'
    case 'network':
      return 'The guidance assistant couldn’t be reached. Check your internet connection. Your message has been saved.'
    case 'busy':
      return 'The guidance assistant is busy right now. Your message has been saved.'
    case 'not_allowed':
      return 'The guidance assistant couldn’t answer in this conversation. Your message has been saved, and your care team can still see it.'
    case 'unavailable':
    case 'not_configured':
      return 'The guidance assistant is not available at the moment. Your message has been saved, and your care team can still see it.'
    case 'disabled':
      // This refusal never asks for a review - chatbot-reply refuses before
      // the step that does - so nothing here suggests anyone will follow the
      // message up: the patient is told to reach their care team instead.
      // Nor does it say no one was alerted: an earlier failed attempt at the
      // same message may have asked for a review.
      return 'The guidance assistant is turned off, so it won’t answer this message. Your message has been saved. For anything about your recovery, contact your care team.'
  }
}

/** Said where the message box would be while the assistant is switched off. */
const ASSISTANT_OFF_MESSAGE =
  'The guidance assistant is turned off, so new messages can’t be sent here. Your conversations are still here. For anything about your recovery, contact your care team.'

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
  useDocumentTitle('Guidance Chat')
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  /**
   * The conversation a reply is being prepared for, only while that request
   * is in flight - after the patient's message is saved and shown, until the
   * assistant answers, the request fails, or it times out. It drives the
   * "preparing a response" state, so that state never shows without a real
   * request behind it, and only in the conversation the request belongs to.
   */
  const [awaitingReplyFor, setAwaitingReplyFor] = useState<string | null>(null)
  /** Why the last request left a conversation without a reply, if it did. */
  const [failure, setFailure] = useState<{
    sessionId: string | null
    /**
     * A new conversation's own id, when the failure happened while starting
     * it: if it was in fact created, the page opens it, and the failure
     * belongs there too.
     */
    newSessionId?: string
    kind: Failure
  } | null>(null)
  /** Times the patient has asked again since the last reply; bounded. */
  const [retries, setRetries] = useState(0)
  /** The reply has taken longer than usual - still a real, pending request. */
  const [slowReply, setSlowReply] = useState(false)
  /**
   * Set the moment a request starts, before React re-renders: a second Enter
   * or a quick second click on Try again can arrive before the page has
   * caught up, and must not start a second request.
   */
  const requestInFlight = useRef(false)
  /** The conversation the request in flight belongs to. */
  const requestSessionRef = useRef<string | null>(null)
  /**
   * Sends not yet confirmed as saved, with their ids (`pending-send.ts`).
   * Read from browser storage once, so a refresh does not forget them; kept
   * here so they also work where storage is blocked.
   */
  const pendingSendsRef = useRef<PendingSend[] | null>(null)
  /** What each unconfirmed send said - in memory only, never stored. */
  const pendingTextRef = useRef(new Map<string, string>())
  /**
   * The edit a submission is held open for, when its earlier version turned
   * out to be saved while the patient had changed the text (see below).
   */
  const heldEditRef = useRef(new Map<string, string>())
  /** Phones only: the past-conversations list in place of the conversation. */
  const [showHistory, setShowHistory] = useState(false)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const historyHeadingRef = useRef<HTMLHeadingElement>(null)
  const assistantHeadingRef = useRef<HTMLHeadingElement>(null)
  /** Where focus goes when the phone's view changes; null leaves it alone. */
  const focusAfterViewChange = useRef<(() => HTMLElement | null) | null>(null)
  const hasSentRef = useRef(false)
  const pastHeadingId = useId()

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

  const selectSession = (sessionId: string | null) => {
    setActiveSessionId(sessionId)
    setRetries(0)
  }

  const pendingSends = (): PendingSend[] => {
    pendingSendsRef.current ??= loadPendingSends(patientId)
    return pendingSendsRef.current
  }

  const rememberSend = (pending: PendingSend, content: string) => {
    pendingSendsRef.current = [
      ...pendingSends().filter((entry) => entry.messageId !== pending.messageId),
      pending,
    ]
    pendingTextRef.current.set(pending.messageId, content)
    rememberPendingSend(patientId, pending)
  }

  /** The submission is settled: it is saved. Its ids are not used again. */
  const settleSend = (messageId: string) => {
    pendingSendsRef.current = pendingSends().filter(
      (entry) => entry.messageId !== messageId,
    )
    pendingTextRef.current.delete(messageId)
    heldEditRef.current.delete(messageId)
    forgetPendingSend(patientId, messageId)
  }

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messagesFor(activeSessionId ?? ''),
    queryFn: () => fetchChatMessages(activeSessionId as string),
    enabled: Boolean(activeSessionId),
  })

  const awaitingReply =
    awaitingReplyFor !== null && awaitingReplyFor === activeSessionId
  const lastMessage = messagesQuery.data?.at(-1)
  // A failure stands only while the message is still unanswered: a reply
  // that was saved even though its response never arrived replaces it.
  const shownFailure =
    failure !== null &&
    (failure.sessionId === activeSessionId ||
      (failure.newSessionId !== undefined &&
        failure.newSessionId === activeSessionId)) &&
    (failure.kind === 'not_sent' ||
      failure.kind === 'unconfirmed' ||
      lastMessage?.chat_message_role !== 'assistant')
      ? failure.kind
      : null

  useEffect(() => {
    // A send that could not be confirmed can turn out to be saved after
    // all: it shows up in the conversation. Then it is settled - its ids are
    // not reused - and the patient is told, instead of being left to send
    // it again as a second message.
    const loaded = messagesQuery.data
    if (!loaded) return
    for (const entry of pendingSends()) {
      const saved = loaded.find((message) => message.chat_message_id === entry.messageId)
      if (!saved) continue
      const sentText = pendingTextRef.current.get(entry.messageId)
      if (sentText === undefined) {
        // From before a refresh: nothing on screen to update.
        settleSend(entry.messageId)
        continue
      }
      const typed = draftRef.current?.value.trim() ?? ''
      const edited = typed !== '' && typed !== sentText
      // An edit in the box keeps the submission open for that edit, so
      // sending it - even at the very moment this is found - meets the same
      // id and is refused, never saved as a second message.
      if (edited) heldEditRef.current.set(entry.messageId, typed)
      else settleSend(entry.messageId)
      setDraft((current) => (current.trim() === sentText ? '' : current))
      setFailure((current) =>
        current?.kind === 'unconfirmed'
          ? {
              sessionId: saved.chat_session_id,
              kind: edited ? 'sent_earlier_version' : 'sent_after_all',
            }
          : current,
      )
    }
    // Runs when the conversation's messages change, which is when a save
    // can be seen; the helpers only read refs.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [messagesQuery.data])

  useEffect(() => {
    // After the phone switches between the conversation and its history, a
    // keyboard or screen-reader user is taken to the top of what is now
    // showing, instead of being left on a control that has just gone.
    focusAfterViewChange.current?.()?.focus()
    focusAfterViewChange.current = null
  }, [showHistory])

  const onReplied = () => {
    requestInFlight.current = false
    setAwaitingReplyFor(null)
    setFailure(null)
    setRetries(0)
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
  }

  const onReplyFailed = (error: unknown) => {
    requestInFlight.current = false
    // Cleared in the same update that shows the reason, so the waiting
    // state and the failure are never both on screen - and every way of
    // failing, a timeout included, ends the waiting state.
    setAwaitingReplyFor(null)
    setFailure({
      sessionId: requestSessionRef.current,
      kind:
        error instanceof ChatbotUnavailableError ? error.reason : 'unavailable',
    })
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
  }

  const sendMessage = useMutation({
    mutationFn: async ({ pending, content }: Send) => {
      let sessionId = pending.sessionId

      if (!sessionId) {
        try {
          const session = await createChatSession(patientId, pending.newSessionId)
          sessionId = session.chat_session_id
          requestSessionRef.current = sessionId
          setActiveSessionId(sessionId)
        } catch (cause) {
          // Not even the conversation: the message itself was never sent. A
          // refused start used none of its ids; an unconfirmed one keeps the
          // conversation's id, so sending again cannot start a second one.
          if (cause instanceof SaveFailedError && cause.certain) {
            settleSend(pending.messageId)
          }
          throw new MessageNotSentError(true, { cause })
        }
      }

      let saved: ChatMessage | null
      try {
        saved = await appendPatientMessage({
          sessionId,
          content,
          messageId: pending.messageId,
        })
      } catch (cause) {
        if (cause instanceof SaveFailedError && cause.certain) {
          // Refused: the id was never used, and a fresh one is used next time.
          settleSend(pending.messageId)
          throw new MessageNotSentError(true, { cause })
        }
        // No answer: the database may have saved it all the same. Look
        // before saying anything about it.
        saved = await findOwnMessage(pending.messageId).catch(() => null)
        if (!saved) throw new MessageNotSentError(false, { cause })
      }

      // Saved - in this version or an earlier one. The submission is settled.
      settleSend(pending.messageId)
      if (saved.chat_message_content !== content) {
        throw new EarlierVersionSavedError(saved)
      }

      // Show the patient's own message immediately, before waiting on a reply
      // that may not come.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chat.messagesFor(sessionId),
      })

      setAwaitingReplyFor(sessionId)
      return requestAssistantReply(sessionId)
    },
    onSuccess: onReplied,
    onError: (error, { pending, content }) => {
      if (error instanceof EarlierVersionSavedError) {
        // The earlier version stands - not overwritten, and the edit not
        // saved beside it as a second message. The edit goes back in the
        // composer, and nothing is asked of the assistant until the patient
        // chooses to.
        requestInFlight.current = false
        setAwaitingReplyFor(null)
        setDraft((current) => (current.trim() ? current : content))
        setFailure({
          sessionId: error.saved.chat_session_id,
          kind: 'sent_earlier_version',
        })
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
        return
      }
      if (!(error instanceof MessageNotSentError)) {
        onReplyFailed(error)
        return
      }
      requestInFlight.current = false
      setAwaitingReplyFor(null)
      // Back in the composer - unless something new has been typed there in
      // the meantime - so it can be sent again under the same ids.
      setDraft((current) => (current.trim() ? current : content))
      setFailure({
        sessionId: requestSessionRef.current,
        newSessionId: pending.newSessionId,
        kind: error.certain ? 'not_sent' : 'unconfirmed',
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
    },
  })

  /**
   * Asks again for a reply to the message already saved. Nothing is sent or
   * saved a second time: the function answers the conversation's latest
   * unanswered message, or reports that it has been answered after all.
   */
  const retryReply = useMutation({
    mutationFn: (sessionId: string) => {
      setAwaitingReplyFor(sessionId)
      return requestAssistantReply(sessionId)
    },
    onSuccess: onReplied,
    onError: onReplyFailed,
  })

  // Migration 38: the assistant can be switched off, for the platform or
  // this patient's clinic. The server refuses it either way; this lets the
  // page say so, and stop offering to send, instead of failing each send.
  // Unknown (null) behaves as before.
  const assistantQuery = useQuery({
    queryKey: queryKeys.chat.assistant(),
    queryFn: fetchGuidanceAssistantAvailable,
    staleTime: 60_000,
  })
  const assistantOff = assistantQuery.data === false || shownFailure === 'disabled'
  // A refusal as switched off, before the page knew: ask again, so the rest
  // of the page - the message box, the openers - follows.
  useEffect(() => {
    if (shownFailure === 'disabled' && assistantQuery.data !== false) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.assistant() })
    }
  }, [shownFailure, assistantQuery.data, queryClient])

  const isBusy = sendMessage.isPending || retryReply.isPending
  // The conversation ends on the patient's own message and nothing is on
  // its way: after a refresh, say, following a reply that never came.
  const noReplyYet =
    Boolean(activeSessionId) &&
    lastMessage?.chat_message_role === 'patient' &&
    !awaitingReply &&
    !isBusy &&
    shownFailure === null &&
    !messagesQuery.isFetching &&
    !assistantOff

  useEffect(() => {
    // On a desktop screen tall enough (`chat-fit`), the transcript is its own
    // scrolling box, fitted to the viewport, and the newest message is
    // brought into it. Elsewhere the conversation is part of the page, so
    // scrolling to its end would move the whole page - past the safety
    // notice the moment the chat opened.
    // There, only once the patient has sent something is the composer
    // brought back into view: the new messages land above it and push it
    // down, behind the bottom bar, with the cursor still in it.
    if (window.matchMedia(FITTED).matches) {
      // The transcript box itself is scrolled, not the end marker scrolled
      // into view: `scrollIntoView` also moved the browser's starting point
      // for Tab, so the first Tab after opening the chat skipped the skip
      // link and navigation and landed in the composer.
      const transcript = transcriptEndRef.current?.parentElement
      if (transcript) transcript.scrollTop = transcript.scrollHeight
    } else if (hasSentRef.current) {
      draftRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [messagesQuery.data, awaitingReply, slowReply, shownFailure, noReplyYet])

  useEffect(() => {
    // Only while a real request is pending: after a while the patient is
    // told it is slow, so a long wait does not look like nothing happening.
    if (!awaitingReplyFor) return
    const timer = window.setTimeout(() => setSlowReply(true), SLOW_REPLY_MS)
    return () => {
      window.clearTimeout(timer)
      setSlowReply(false)
    }
  }, [awaitingReplyFor])

  const askAgain = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (requestInFlight.current || !activeSessionId) return
    requestInFlight.current = true
    requestSessionRef.current = activeSessionId
    // From the keyboard, focus would drop to the page when this button goes;
    // it moves to the composer, where the conversation carries on.
    const section = event.currentTarget.closest('section')
    if (section) refocusAfterKeyboardSubmit(section, draftRef.current)
    setRetries((count) => count + 1)
    setFailure(null)
    retryReply.mutate(activeSessionId)
  }

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    // One message at a time: while a reply is on its way, Enter in the
    // composer does nothing, and what the patient has typed stays there.
    if (requestInFlight.current) return
    const content = draft.trim()
    if (!content) return
    // A send to a conversation with an unconfirmed one is that same
    // submission - edited or not - so it reuses its ids. Whichever attempt
    // the database saved first is the one kept; it never keeps two. Only a
    // conversation with nothing unconfirmed starts a new submission. Worked
    // out before anything is marked as in flight.
    let unconfirmed = pendingSendFor(
      // A new conversation remembered from before a refresh is not continued
      // by whatever new conversation comes next: nothing on screen ties the
      // two, and continuing it would put this message into that one.
      pendingSends().filter(
        (entry) => entry.sessionId !== null || pendingTextRef.current.has(entry.messageId),
      ),
      activeSessionId,
    )
    const held = unconfirmed && heldEditRef.current.get(unconfirmed.messageId)
    if (unconfirmed && held !== undefined && held !== content) {
      // Held open only for the edit that was in the box; anything else the
      // patient writes now is a new message.
      settleSend(unconfirmed.messageId)
      unconfirmed = undefined
    }
    const pending: PendingSend = unconfirmed
      ? { ...unconfirmed, sessionId: activeSessionId ?? unconfirmed.sessionId }
      : {
          messageId: newChatId(),
          sessionId: activeSessionId,
          newSessionId: newChatId(),
          startedAt: Date.now(),
        }
    rememberSend(pending, content)
    requestInFlight.current = true
    requestSessionRef.current = activeSessionId
    hasSentRef.current = true
    // Sent with Send from the keyboard: the button is disabled the moment the
    // draft empties, which dropped focus to the page. Back into the composer,
    // where the next message is written - before the draft clears. Enter in
    // the composer is already there, and a click moves nothing.
    const composer = draftRef.current
    if (composer?.form) refocusAfterKeyboardSubmit(composer.form, composer)
    setDraft('')
    setFailure(null)
    setRetries(0)
    sendMessage.mutate({ pending, content })
  }

  const startNew = () => {
    selectSession(null)
    setFailure(null)
  }

  const openHistory = () => {
    focusAfterViewChange.current = () => historyHeadingRef.current
    setShowHistory(true)
  }

  const closeHistory = (focusTarget: () => HTMLElement | null) => {
    // Only when the phone's history is actually showing: from `lg` it is
    // always beside the conversation, and focus stays where it was.
    if (!showHistory) return
    focusAfterViewChange.current = focusTarget
    setShowHistory(false)
  }

  const activeSession = sessionsQuery.data?.find(
    (session) => session.chat_session_id === activeSessionId,
  )
  const sessionCount = sessionsQuery.data?.length ?? 0
  const lastPatientMessageId = messagesQuery.data
    ?.filter((message) => message.chat_message_role === 'patient')
    .at(-1)?.chat_message_id

  // What the header says about the assistant is only what the page knows:
  // waiting on a reply, or that the last request failed. It never claims the
  // assistant is available after it has just said it is not.
  const isUnavailable =
    !awaitingReply && shownFailure !== null && isReplyFailure(shownFailure)
  const retriesLeft = MAX_REPLY_RETRIES - retries
  const offerRetry =
    shownFailure !== null &&
    isReplyFailure(shownFailure) &&
    canRetry(shownFailure) &&
    retriesLeft > 0
  // Saved after all: the message is safe, and nothing has asked for a reply.
  const sentAfterAll =
    shownFailure === 'sent_after_all' || shownFailure === 'sent_earlier_version'
  const status = awaitingReply
    ? { short: 'Preparing a response…', long: 'Preparing a response…' }
    : assistantOff
      ? { short: 'Turned off', long: 'Turned off' }
      : isUnavailable
      ? { short: 'Not available right now', long: 'Not available right now' }
      : {
          short: 'Available',
          long: 'Available for general recovery guidance',
        }

  return (
    <>
      {/* On a phone the assistant's header is the first thing on screen, as
          in the approved design; the page title stays for screen readers. */}
      <PageHeader title="Guidance chat" className="max-lg:sr-only" />

      <div className="grid gap-6 chat-fit:h-[calc(100dvh-14rem)] lg:grid-cols-[minmax(0,1fr)_18.75rem]">
        {/*
          On a desktop screen tall enough (`chat-fit`, see index.css) the
          conversation is sized from the viewport, not from its contents: the
          grid above takes the viewport's height, the transcript is the only
          thing that scrolls, and the composer stays in view.

          Elsewhere it is not sized at all, and flows with the page. A phone
          cannot spare the height: a card fitted to the rest of a 390x844
          screen left 218px for the conversation - 110px at 320px wide, with
          the composer behind the bottom bar - and that box scrolled inside a
          page that scrolled too. The page is now the one thing that scrolls.
          On a phone the conversation also runs edge to edge, under the app
          header, as the design has it.
        */}
        <section
          aria-labelledby={`${pastHeadingId}-assistant`}
          className={cn(
            'flex flex-col overflow-hidden bg-surface',
            'max-lg:-mx-4 max-lg:-mt-6 sm:max-lg:-mx-6',
            'chat-fit:min-h-0 lg:rounded-[var(--radius-lg)] lg:border lg:border-[var(--color-border)]',
            showHistory && 'max-lg:hidden',
          )}
        >
          {/* --- The assistant ------------------------------------------- */}
          <header
            data-surface="dark"
            className="flex shrink-0 items-center gap-2.5 bg-brand-800 py-2.5 pl-3.5 pr-1.5 lg:h-20 lg:gap-4 lg:py-0 lg:pl-6 lg:pr-5"
          >
            <div className="relative shrink-0">
              <AssistantAvatar size="md" />
              {isUnavailable ? null : (
                <span
                  aria-hidden="true"
                  className="absolute bottom-px right-0 size-3 rounded-full border-2 border-brand-800 bg-accent-400"
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2
                ref={assistantHeadingRef}
                id={`${pastHeadingId}-assistant`}
                tabIndex={-1}
                className="text-[15px] font-semibold leading-5 text-white sm:text-base lg:text-[17px] lg:leading-[22px]"
              >
                {ASSISTANT}
              </h2>
              <p className="mt-0.5 text-xs leading-4 text-brand-100 lg:text-[13px] lg:leading-[18px]">
                <span className="font-semibold text-white">RecoverEase</span>
                <span aria-hidden="true"> · </span>
                <span className="sr-only">, </span>
                <span className="lg:hidden">{status.short}</span>
                <span className="max-lg:hidden">{status.long}</span>
              </p>
            </div>

            {/* Phones: the history and a new conversation, as icons in the
                header, side by side - each still a 44px target. From `lg`
                the history is always beside the chat. */}
            <div className="flex lg:hidden">
              <Button
                id={`${pastHeadingId}-open`}
                variant="ghost"
                size="icon"
                aria-label="Past conversations"
                className="text-white hover:bg-white/15 active:bg-white/25"
                onClick={openHistory}
              >
                <History aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Start new conversation"
                className="text-white hover:bg-white/15 active:bg-white/25"
                onClick={() => {
                  startNew()
                  draftRef.current?.focus()
                }}
              >
                <SquarePen aria-hidden="true" />
              </Button>
            </div>
            <Button
              variant="ghost"
              className="border border-white/40 bg-white/10 text-white hover:bg-white/20 active:bg-white/25 max-lg:hidden"
              onClick={startNew}
            >
              <SquarePen aria-hidden="true" />
              Start new
            </Button>
          </header>

          {/* Stated before the conversation, not buried under it. Standing
              guidance, so it is not announced: it was on the page all along.
              At body size: this is what to do if something is urgent. */}
          <Notice
            tone="info"
            size="base"
            className="mx-4 mt-4 shrink-0 lg:mx-0 lg:mt-0 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:px-6"
          >
            This assistant offers general guidance about recovery. It does not
            diagnose conditions and cannot change your treatment. If you feel
            unwell or something is urgent, contact your doctor or emergency
            services directly.
          </Notice>

          {/*
            `min-h-0` is load-bearing. A flex child defaults to `min-height:
            auto`, which refuses to shrink below its content, so without it
            `flex-1 overflow-y-auto` never scrolls - the section just grows
            and takes the composer with it. All three with `chat-fit` only:
            elsewhere the transcript is part of the page and does not scroll
            by itself.

            Named, because when fitted a long conversation makes this a
            scrolling box the browser puts in the Tab order - and a focused
            region with no name says nothing about what it holds.
          */}
          <div
            role="region"
            aria-label="Conversation"
            className="px-4 py-5 chat-fit:min-h-0 chat-fit:flex-1 chat-fit:overflow-y-auto lg:px-8 lg:py-6"
          >
            {/* What the flag means, and no more: whether the alert reached
                anyone is not something this page knows (flag-notice.ts). */}
            {activeSession?.chat_session_has_critical_flag ? (
              <Notice tone="warning" className="mb-5">
                {FLAGGED_CONVERSATION_NOTICE}
              </Notice>
            ) : null}

            {!activeSessionId ? (
              <NewConversation
                assistantOff={assistantOff}
                onChoose={(suggestion) => {
                  setDraft(suggestion)
                  draftRef.current?.focus()
                }}
              />
            ) : (
              <StateView
                isPending={messagesQuery.isPending}
                // A reload that fails - offline, just after a send - leaves
                // the conversation already on screen in place; only a first
                // load that fails shows the error.
                error={messagesQuery.data ? null : messagesQuery.error}
                data={messagesQuery.data}
                onRetry={() => void messagesQuery.refetch()}
                empty={
                  <p className="py-10 text-center text-sm text-muted">
                    No messages in this conversation yet.
                  </p>
                }
              >
                {(messages) => (
                  <>
                    {activeSession ? (
                      <p className="mb-5 flex items-center gap-3 text-xs text-muted">
                        <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-border)]" />
                        <span>
                          {formatDateRelative(activeSession.chat_session_started_at)}
                          <span aria-hidden="true"> · </span>
                          <span className="sr-only">, </span>
                          <span className="max-lg:hidden">Conversation started </span>
                          {formatTime(activeSession.chat_session_started_at)}
                        </span>
                        <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-border)]" />
                      </p>
                    ) : null}

                    {/* `gap`, not `space-y`: the spacing from `space-y` is a
                        margin on every item but the last, and when a message
                        is added the one before it took that margin a frame
                        late - after the transcript had been scrolled to its
                        end, so it stopped a message-gap short. */}
                    <ul className="flex flex-col gap-5 lg:gap-6">
                      {messages.map((message) => {
                        const isPatient = message.chat_message_role === 'patient'
                        const time = formatTime(message.chat_message_created_at)

                        if (isPatient) {
                          return (
                            <li
                              key={message.chat_message_id}
                              className="flex flex-col items-end gap-1.5"
                            >
                              <p className="flex items-center gap-2 text-xs text-muted">
                                <span className="font-semibold text-body">You</span>
                                <span>{time}</span>
                              </p>
                              <p className="max-w-[min(32.5rem,88%)] whitespace-pre-wrap rounded-[16px_4px_16px_16px] bg-brand-700 px-3.5 py-2.5 text-base leading-relaxed text-white lg:px-[18px] lg:py-3">
                                {message.chat_message_content}
                              </p>
                              {awaitingReply &&
                              message.chat_message_id === lastPatientMessageId ? (
                                <p className="flex items-center gap-1.5 text-xs font-semibold text-accent-700">
                                  <CheckCheck className="size-3.5" aria-hidden="true" />
                                  Received
                                </p>
                              ) : null}
                            </li>
                          )
                        }

                        return (
                          <li key={message.chat_message_id} className="flex gap-2 lg:gap-3">
                            <AssistantAvatar />
                            <div className="flex min-w-0 max-w-[35rem] flex-col gap-1.5">
                              <p className="flex items-center gap-2 text-xs text-muted">
                                <span className="font-semibold text-body">
                                  <span className="max-lg:hidden">Recovery </span>
                                  Guidance Assistant
                                </span>
                                <span>{time}</span>
                              </p>
                              <p className="whitespace-pre-wrap rounded-[4px_16px_16px_16px] bg-surface-sunken px-3.5 py-3 text-base leading-relaxed text-heading lg:px-[18px] lg:py-3.5">
                                {message.chat_message_content}
                              </p>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </StateView>
            )}

            {awaitingReply ? (
              // Announced once, when it appears; it goes the moment the reply
              // arrives or the request fails.
              <div role="status" className="mt-5 flex gap-2 lg:mt-6 lg:gap-3">
                <AssistantAvatar />
                <div className="flex min-w-0 max-w-[35rem] flex-col gap-1.5">
                  <p className="text-xs font-semibold text-body">{ASSISTANT}</p>
                  <div className="flex flex-col gap-2 rounded-[4px_16px_16px_16px] bg-surface-sunken px-4 py-3 lg:flex-row lg:items-center lg:gap-4 lg:pl-4 lg:pr-5">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-4 items-center gap-[5px] lg:h-8 lg:w-12 lg:shrink-0 lg:justify-center lg:rounded-full lg:border lg:border-[var(--color-border)] lg:bg-surface"
                    >
                      <span className="typing-dot size-[7px] rounded-full bg-brand-700" />
                      <span className="typing-dot size-[7px] rounded-full bg-brand-700" />
                      <span className="typing-dot size-[7px] rounded-full bg-brand-700" />
                    </span>
                    <div>
                      <p className="font-semibold leading-snug text-heading">
                        Guidance chat is processing…
                      </p>
                      <p className="text-sm text-body">
                        Please wait while I prepare a response.
                      </p>
                      {slowReply ? (
                        <p className="mt-1 text-sm text-body">
                          This is taking longer than usual.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {shownFailure !== null ? (
              // Announced once, when it appears. Never on screen together
              // with the waiting state: both are cleared and set in the same
              // update, so the page has one status at a time.
              <Notice
                tone={sentAfterAll ? 'info' : 'warning'}
                live="polite"
                className="mt-5"
              >
                <p>{failureMessage(shownFailure, retriesLeft)}</p>
                {/* Under the message rather than beside it, so a phone
                    keeps the message at a readable width. */}
                {offerRetry ? (
                  <Button variant="outline" className="mt-3" onClick={askAgain}>
                    <RotateCw aria-hidden="true" />
                    Try again
                  </Button>
                ) : sentAfterAll ? (
                  <Button variant="outline" className="mt-3" onClick={askAgain}>
                    <RotateCw aria-hidden="true" />
                    Get a reply
                  </Button>
                ) : null}
              </Notice>
            ) : noReplyYet ? (
              // Not announced: it describes the conversation as it was found,
              // not something that just happened.
              <Notice tone="info" className="mt-5">
                <p>Your last message hasn’t had a reply yet.</p>
                <Button variant="outline" className="mt-3" onClick={askAgain}>
                  <RotateCw aria-hidden="true" />
                  Get a reply
                </Button>
              </Notice>
            ) : null}

            <div ref={transcriptEndRef} />
          </div>

          {/* --- Composer ------------------------------------------------ */}
          <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2.5 lg:px-6 lg:pb-3.5 lg:pt-4">
            {assistantOff ? (
              // No message box to type into and be refused: what can be done
              // instead, and that nothing already written is lost.
              <Notice tone="info" live="polite">
                <p>{ASSISTANT_OFF_MESSAGE}</p>
              </Notice>
            ) : (
              <>
                <form onSubmit={onSubmit} className="flex items-end gap-2 lg:gap-3">
                  <label htmlFor="chat-draft" className="sr-only">
                    Your message
                  </label>
                  {/* `scroll-mb-24` below `md` clears the bottom bar - the same
                      6rem the page keeps under its content - whenever the
                      composer is scrolled to, by focus or after sending. */}
                  <textarea
                    ref={draftRef}
                    id="chat-draft"
                    rows={1}
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
                    placeholder="Ask a question about your recovery..."
                    // 16px keeps iOS from zooming the viewport on focus, which
                    // would push the composer out of view the moment the keyboard
                    // opens. Two lines at 320px, where the prompt wraps.
                    className="h-12 min-w-0 flex-1 resize-none rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-surface px-3.5 py-3 text-base leading-snug text-heading placeholder:text-muted max-md:scroll-mb-24 max-[359px]:h-[4.375rem] lg:h-14 lg:px-4 lg:py-4"
                  />
                  <Button
                    type="submit"
                    disabled={!draft.trim()}
                    isLoading={isBusy}
                    loadingLabel="Sending…"
                    aria-label="Send message"
                    className="size-12 shrink-0 rounded-[var(--radius-lg)] bg-brand-700 px-0 text-[15px] hover:bg-brand-800 lg:h-14 lg:w-auto lg:px-5 [&_svg]:size-5"
                  >
                    {/* The button shows its own spinner while sending. */}
                    {sendMessage.isPending ? null : <Send aria-hidden="true" />}
                    <span className="max-lg:hidden">Send</span>
                  </Button>
                </form>
                <p className="mt-2.5 text-center text-xs text-muted max-lg:hidden">
                  {awaitingReply
                    ? 'You can send your next message once this response is ready'
                    : 'General guidance only · Your care team makes decisions about your treatment'}
                </p>
              </>
            )}
          </div>
        </section>

        {/* --- Past conversations — module 8.4 ---------------------------
            Beside the conversation from `lg`. On a phone it takes the
            conversation's place, opened from the header, as the design has
            it. Rendered once either way: rendering it twice would put every
            history button in the document twice. */}
        <aside
          aria-labelledby={pastHeadingId}
          className={cn(
            'bg-surface',
            'max-lg:-mx-4 max-lg:-mt-6 sm:max-lg:-mx-6',
            'lg:self-start lg:rounded-[var(--radius-lg)] lg:border lg:border-[var(--color-border)] chat-fit:max-h-full chat-fit:min-h-0 chat-fit:overflow-y-auto',
            !showHistory && 'max-lg:hidden',
          )}
        >
          <div className="flex items-center gap-1 border-b border-[var(--color-border)] py-3 pl-1.5 pr-3 lg:items-baseline lg:justify-between lg:px-5 lg:pb-3.5 lg:pt-[18px]">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to conversation"
              className="text-heading lg:hidden"
              onClick={() =>
                closeHistory(() =>
                  document.getElementById(`${pastHeadingId}-open`),
                )
              }
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <h2
              ref={historyHeadingRef}
              id={pastHeadingId}
              tabIndex={-1}
              className="flex-1 text-lg font-bold leading-6 text-heading lg:flex-none lg:text-base lg:font-semibold"
            >
              Past conversations
            </h2>
            {sessionCount > 0 ? (
              <span className="text-xs text-muted max-lg:hidden">
                {sessionCount}
                <span className="sr-only"> conversations</span>
              </span>
            ) : null}
            <Button
              variant="outline"
              className="border-brand-700 text-brand-700 hover:bg-brand-50 lg:hidden"
              onClick={() => {
                startNew()
                closeHistory(() => draftRef.current)
              }}
            >
              <SquarePen aria-hidden="true" />
              Start new
            </Button>
          </div>

          <p className="px-4 pb-2 pt-4 text-sm text-muted lg:hidden">
            Your conversations with the {ASSISTANT}.
          </p>

          <StateView
            isPending={sessionsQuery.isPending}
            error={sessionsQuery.error}
            data={sessionsQuery.data}
            empty={
              <p className="px-4 py-6 text-sm text-muted lg:px-5">
                Your previous conversations will be listed here.
              </p>
            }
          >
            {(sessions) => (
              <ul className="lg:space-y-0.5 lg:p-2">
                {sessions.map((session) => {
                  const isOpen = session.chat_session_id === activeSessionId
                  return (
                    <li
                      key={session.chat_session_id}
                      className="border-b border-[var(--color-border)] last:border-b-0 lg:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          selectSession(session.chat_session_id)
                          closeHistory(() => assistantHeadingRef.current)
                        }}
                        aria-current={isOpen ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-neutral-50 lg:rounded-[var(--radius-md)] lg:px-3 lg:py-3.5',
                          isOpen && 'bg-brand-50 hover:bg-brand-50',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-heading lg:text-sm">
                              {formatDateTime(session.chat_session_started_at)}
                            </span>
                            {isOpen ? (
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-700">
                                Open
                              </span>
                            ) : null}
                          </span>
                          {session.chat_session_summary ? (
                            <span className="mt-1 block line-clamp-2 text-sm text-muted lg:text-[13px] lg:leading-[18px]">
                              {session.chat_session_summary}
                            </span>
                          ) : null}
                          {session.chat_session_has_critical_flag ? (
                            <span className="mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-warning-50 px-2 py-0.5 text-xs font-semibold text-warning-800">
                              <AlertTriangle className="size-3.5" aria-hidden="true" />
                              {FLAGGED_CONVERSATION_BADGE}
                            </span>
                          ) : null}
                        </span>
                        <ChevronRight
                          className="size-[18px] shrink-0 text-neutral-500 lg:hidden"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </StateView>
        </aside>
      </div>
    </>
  )
}

/**
 * A conversation not yet started: who the assistant is, what it is for, and
 * three ways to begin. Choosing one fills the composer; nothing is sent until
 * the patient sends it.
 */
function NewConversation({
  onChoose,
  assistantOff = false,
}: {
  onChoose: (text: string) => void
  /** Switched off (migration 38): no openers to fill a message box that is not there. */
  assistantOff?: boolean
}) {
  if (assistantOff) {
    return (
      <div className="flex flex-col items-center gap-3 text-center lg:py-6 chat-fit:min-h-full chat-fit:justify-center">
        <AssistantAvatar size="lg" />
        <div>
          <p className="text-sm font-semibold text-accent-800">{ASSISTANT}</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-muted">Turned off</p>
        </div>
        <h2 className="mt-1 text-balance text-[22px] font-bold leading-[29px] tracking-[-0.01em] text-heading lg:text-[28px] lg:leading-9">
          The guidance assistant is turned off
        </h2>
        <p className="max-w-[32.5rem] text-body">
          Your past conversations are still here. For anything about your
          recovery, contact your care team.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 lg:items-center lg:gap-9 lg:py-6 chat-fit:min-h-full chat-fit:justify-center">
      <div className="flex flex-col items-center gap-3 text-center lg:max-w-[32.5rem]">
        <AssistantAvatar size="lg" />
        <div>
          <p className="text-sm font-semibold text-accent-800">{ASSISTANT}</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-muted">
            <span className="max-lg:hidden">RecoverEase · </span>
            Available for general recovery guidance
          </p>
        </div>
        <h2 className="mt-1 text-balance text-[22px] font-bold leading-[29px] tracking-[-0.01em] text-heading lg:text-[28px] lg:leading-9">
          How can I support you with your recovery today?
        </h2>
      </div>

      <div className="flex w-full flex-col gap-2.5 lg:items-center lg:gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">
          You could ask
        </p>
        <ul className="flex flex-col gap-2.5 lg:items-center lg:gap-3">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => onChoose(suggestion)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[18px] border border-[var(--color-border-strong)] bg-surface px-4 py-3 text-left font-medium text-brand-700 transition-colors hover:border-brand-700 hover:bg-brand-50 lg:w-auto lg:rounded-full lg:pl-5 lg:pr-[18px]"
              >
                {suggestion}
                <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
