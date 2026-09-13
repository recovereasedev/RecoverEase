import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 8.5: a critical-chat alert opens the conversation it is about. Every
 * other notification is left exactly as it was.
 */

const state = vi.hoisted(() => ({ notifications: [] as unknown[], markRead: vi.fn() }))

vi.mock('@/features/notifications/hooks', () => ({
  useNotifications: () => ({
    data: state.notifications,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMarkNotificationRead: () => ({ mutate: state.markRead, isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { NotificationsPage } = await import('@/features/notifications/pages/notifications-page')

const ALERT_TEXT = 'A patient raised a concern in the guidance chat that may need your attention.'

function notification(overrides: Record<string, unknown>) {
  return {
    notification_id: 'n-1',
    user_id: 'doctor-user',
    chat_session_id: null,
    notification_type: 'appointment',
    notification_message: 'Appointment tomorrow at 09:30.',
    notification_is_read: false,
    notification_created_at: '2026-09-13T01:00:00Z',
    chat_session: null,
    ...overrides,
  }
}

const row = (text: string) => within(screen.getByText(text).closest('li') as HTMLElement)

function renderPage() {
  return render(
    <MemoryRouter>
      <NotificationsPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state.markRead.mockReset()
})

describe('a critical-chat alert', () => {
  it('links to that patient’s conversation, on the Chat tab', () => {
    state.notifications = [
      notification({
        notification_id: 'n-crit',
        notification_type: 'chat_critical',
        notification_message: ALERT_TEXT,
        chat_session_id: 's-1',
        chat_session: { pat_id: 'p-1' },
      }),
    ]
    renderPage()

    expect(
      row(ALERT_TEXT).getByRole('link', { name: /^View conversation/ }),
    ).toHaveAttribute('href', '/doctor/patients/p-1?tab=chat&session=s-1')
    // Still markable as read, as before.
    expect(row(ALERT_TEXT).getByRole('button', { name: /^Mark read/ })).toBeInTheDocument()
  })

  it('offers no link when the reader may not see the conversation', () => {
    state.notifications = [
      notification({
        notification_type: 'chat_critical',
        notification_message: ALERT_TEXT,
        chat_session_id: 's-1',
        chat_session: null,
      }),
    ]
    renderPage()

    expect(screen.queryByRole('link', { name: /View conversation/ })).not.toBeInTheDocument()
  })
})

describe('every other notification', () => {
  it('stays as it was: no link, and Mark read while unread', () => {
    state.notifications = [
      notification({ notification_id: 'n-a', notification_type: 'appointment' }),
      notification({
        notification_id: 'n-m',
        notification_type: 'medication',
        notification_message: 'Time for your 08:00 dose.',
        notification_is_read: true,
      }),
    ]
    renderPage()

    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(
      row('Appointment tomorrow at 09:30.').getByRole('button', { name: /^Mark read/ }),
    ).toBeInTheDocument()
    expect(row('Time for your 08:00 dose.').queryByRole('button')).not.toBeInTheDocument()
  })

  it('gets no link even if it happens to carry a conversation', () => {
    state.notifications = [
      notification({
        notification_type: 'general',
        notification_message: 'A general update.',
        chat_session_id: 's-1',
        chat_session: { pat_id: 'p-1' },
      }),
    ]
    renderPage()

    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})
