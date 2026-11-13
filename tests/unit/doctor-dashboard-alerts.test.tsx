import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CRITICAL_ALERT_MESSAGE } from '../../supabase/functions/_shared/critical-escalation'
import { NEEDS_REVIEW_MESSAGE } from '../../supabase/functions/_shared/escalation'

/**
 * Phase 2B: on the doctor's "Needs attention" list a possible clinical
 * concern and an assistant that could not reply no longer look alike. A
 * concern is amber and comes first; an unanswered message is neutral. Both
 * still open the conversation, and neither shows what the patient wrote.
 */

const state = vi.hoisted(() => ({ notifications: [] as unknown[] }))
const ok = (data: unknown) => ({ data, isPending: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() })

vi.mock('@/features/notifications/hooks', () => ({
  useNotifications: () => ok(state.notifications),
}))
vi.mock('@/features/appointments/hooks', () => ({
  useAppointments: () => ok([]),
  useRescheduleRequests: () => ok([]),
  useDecideRescheduleRequest: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/features/patients/hooks', () => ({ useMyPatients: () => ok([]) }))

const { DoctorDashboard } = await import('@/features/dashboard/pages/doctor-dashboard')

function alert(id: string, message: string, createdAt: string) {
  return {
    notification_id: id,
    user_id: 'doctor-user',
    chat_session_id: `s-${id}`,
    notification_type: 'chat_critical',
    notification_message: message,
    notification_is_read: false,
    notification_created_at: createdAt,
    chat_session: { pat_id: 'p-1' },
  }
}

const rowOf = (label: string) => screen.getByText(label).closest('li') as HTMLElement

beforeEach(() => {
  // Newest first, as the query returns them: the unanswered one is newer.
  state.notifications = [
    alert('u', NEEDS_REVIEW_MESSAGE, '2026-11-13T02:00:00Z'),
    alert('c', CRITICAL_ALERT_MESSAGE, '2026-11-13T01:00:00Z'),
  ]
  render(
    <MemoryRouter>
      <DoctorDashboard />
    </MemoryRouter>,
  )
})

describe('Needs attention', () => {
  it('shows a possible concern in amber, first', () => {
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]!).getByText('Possible concern')).toBeInTheDocument()
    expect(rowOf('Possible concern').className).toMatch(/bg-warning-50/)
  })

  it('shows an assistant that could not reply as a neutral, unanswered message', () => {
    const row = rowOf('Unanswered message')
    expect(row.className).not.toMatch(/warning/)
    expect(row.innerHTML).not.toMatch(/warning|danger/)
    expect(within(row).getByText(/couldn't answer a patient's message/)).toBeInTheDocument()
  })

  it('opens each conversation, as before', () => {
    expect(within(rowOf('Possible concern')).getByRole('link', { name: 'View conversation' })).toHaveAttribute(
      'href',
      '/doctor/patients/p-1?tab=chat&session=s-c',
    )
    expect(within(rowOf('Unanswered message')).getByRole('link', { name: 'View conversation' })).toHaveAttribute(
      'href',
      '/doctor/patients/p-1?tab=chat&session=s-u',
    )
  })

  it('says no more than it needs to', () => {
    expect(screen.queryByText('Waiting on your decision or your review.')).not.toBeInTheDocument()
    expect(screen.queryByText('Flagged conversation')).not.toBeInTheDocument()
  })
})
