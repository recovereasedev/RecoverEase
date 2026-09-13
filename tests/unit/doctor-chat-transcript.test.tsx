import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 8.5 "View Patient Chat Transcript": the doctor reads a patient's
 * guidance chat, oldest message first, patient and assistant told apart, and
 * nothing to type into.
 */

const api = vi.hoisted(() => ({
  fetchChatSessions: vi.fn(),
  fetchChatMessages: vi.fn(),
}))

vi.mock('@/features/chat/api', () => api)

const { PatientChatTranscript } = await import(
  '@/features/chat/components/patient-chat-transcript'
)

function session(id: string, startedAt: string, flagged = false, summary: string | null = null) {
  return {
    chat_session_id: id,
    pat_id: 'p-1',
    chat_session_external_ref: null,
    chat_session_started_at: startedAt,
    chat_session_ended_at: null,
    chat_session_has_critical_flag: flagged,
    chat_session_summary: summary,
  }
}

function message(id: string, sessionId: string, role: string, content: string, at: string) {
  return {
    chat_message_id: id,
    chat_session_id: sessionId,
    chat_message_role: role,
    chat_message_content: content,
    chat_message_created_at: at,
  }
}

const RECENT = session('s-2', '2026-09-12T02:00:00Z')
const FLAGGED = session('s-1', '2026-09-10T02:00:00Z', true, 'The assistant advised seeking care now.')

function renderTranscript(initialSessionId?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PatientChatTranscript patientId="p-1" initialSessionId={initialSessionId ?? null} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.fetchChatSessions.mockReset().mockResolvedValue([RECENT, FLAGGED])
  api.fetchChatMessages.mockReset().mockImplementation(async (sessionId: string) =>
    sessionId === 's-2'
      ? [
          message('m-1', 's-2', 'patient', 'Is it normal for the knee to click?', '2026-09-12T02:00:00Z'),
          message('m-2', 's-2', 'assistant', 'Some clicking can be normal while you recover.', '2026-09-12T02:00:05Z'),
          message('m-3', 's-2', 'patient', 'Thank you.', '2026-09-12T02:01:00Z'),
        ]
      : [message('m-9', 's-1', 'patient', 'My wound is hot and swollen.', '2026-09-10T02:00:00Z')],
  )
})

describe('the doctor’s view of a patient’s guidance chat', () => {
  it('shows the most recent conversation, oldest message first, patient and assistant told apart', async () => {
    renderTranscript()

    const conversation = await screen.findByRole('list', { name: 'Conversation' })
    const items = within(conversation).getAllByRole('listitem')

    expect(api.fetchChatSessions).toHaveBeenCalledWith('p-1')
    expect(api.fetchChatMessages).toHaveBeenCalledWith('s-2')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('PatientIs it normal for the knee to click?'),
      expect.stringContaining('AssistantSome clicking can be normal while you recover.'),
      expect.stringContaining('PatientThank you.'),
    ])
  })

  it('keeps each message exactly as it was stored', async () => {
    api.fetchChatMessages.mockResolvedValue([
      message('m-1', 's-2', 'patient', 'Line one\n  indented line two', '2026-09-12T02:00:00Z'),
    ])
    renderTranscript()

    const conversation = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(conversation).getByText('Line one\n  indented line two', {
        normalizer: (text) => text,
      }),
    ).toBeInTheDocument()
  })

  it('opens the conversation an alert points to, and says it was flagged', async () => {
    renderTranscript('s-1')

    expect(await screen.findByText('My wound is hot and swollen.')).toBeInTheDocument()
    expect(api.fetchChatMessages).toHaveBeenCalledWith('s-1')
    expect(api.fetchChatMessages).not.toHaveBeenCalledWith('s-2')
    expect(
      screen.getByText(/flagged for your attention\. The assistant advised seeking care now\./),
    ).toBeInTheDocument()
  })

  it('opens the most recent conversation when asked for one that is not this patient’s', async () => {
    renderTranscript('someone-elses')

    expect(await screen.findByText('Thank you.')).toBeInTheDocument()
    expect(api.fetchChatMessages).toHaveBeenCalledWith('s-2')
  })

  it('switches to another conversation from the list', async () => {
    renderTranscript()
    await screen.findByText('Thank you.')

    const conversations = within(
      screen.getByRole('list', { name: 'Conversations' }),
    ).getAllByRole('button')
    expect(conversations).toHaveLength(2)
    expect(conversations[0]).toHaveAttribute('aria-current', 'true')

    fireEvent.click(conversations[1] as HTMLElement)

    expect(await screen.findByText('My wound is hot and swollen.')).toBeInTheDocument()
    expect(conversations[1]).toHaveAttribute('aria-current', 'true')
  })

  it('has nothing to type into and nothing to send', async () => {
    renderTranscript()
    await screen.findByText('Thank you.')

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })

  it('shows a loading state while the conversations load', () => {
    api.fetchChatSessions.mockReturnValue(new Promise(() => {}))
    renderTranscript()

    expect(screen.getByText('Loading conversations…')).toBeInTheDocument()
  })

  it('says so when the conversations cannot be loaded', async () => {
    api.fetchChatSessions.mockRejectedValue(new Error('network down'))
    renderTranscript()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Conversation' })).not.toBeInTheDocument()
  })

  it('says plainly when the patient has not used the chat', async () => {
    api.fetchChatSessions.mockResolvedValue([])
    renderTranscript()

    expect(await screen.findByText('This patient has not used the guidance chat.')).toBeInTheDocument()
    expect(api.fetchChatMessages).not.toHaveBeenCalled()
  })

  it('says so when a conversation has no messages', async () => {
    api.fetchChatMessages.mockResolvedValue([])
    renderTranscript()

    expect(await screen.findByText('No messages in this conversation.')).toBeInTheDocument()
  })

  it('says so when a conversation cannot be loaded', async () => {
    api.fetchChatMessages.mockRejectedValue(new Error('network down'))
    renderTranscript()

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeInTheDocument()
  })
})
