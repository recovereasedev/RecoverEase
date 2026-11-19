import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

/**
 * The empty notifications page says what will arrive there, in the reader's
 * own terms. A patient gets medication and appointment reminders; a doctor
 * gets chat alerts and appointment reminders (migrations 18 and 42); an
 * administrator is promised neither.
 */

vi.mock('@/features/notifications/hooks', () => ({
  useNotifications: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useMarkNotificationRead: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
}))
// The doctor's form beside the list has its own tests; it is not under test here.
vi.mock('@/features/notifications/components/send-patient-notification', () => ({
  SendPatientNotification: () => null,
}))

const { NotificationsPage } = await import('@/features/notifications/pages/notifications-page')

const PATIENT_LINE = 'Medication and appointment reminders will show here.'
const DOCTOR_LINE = 'Chat alerts and appointment reminders will show here.'

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NotificationsPage />
    </MemoryRouter>,
  )
}

describe('an empty notifications page', () => {
  it('tells a patient to expect medication and appointment reminders', () => {
    renderAt('/patient/notifications')

    expect(screen.getByText('You’re all caught up')).toBeInTheDocument()
    expect(screen.getByText(PATIENT_LINE)).toBeInTheDocument()
    expect(screen.queryByText(DOCTOR_LINE)).not.toBeInTheDocument()
  })

  it('tells a doctor to expect chat alerts and appointment reminders', () => {
    renderAt('/doctor/notifications')

    expect(screen.getByText('You’re all caught up')).toBeInTheDocument()
    expect(screen.getByText(DOCTOR_LINE)).toBeInTheDocument()
    expect(screen.queryByText(PATIENT_LINE)).not.toBeInTheDocument()
  })

  it('promises an administrator neither', () => {
    renderAt('/admin/notifications')

    expect(screen.getByText('You’re all caught up')).toBeInTheDocument()
    expect(screen.queryByText(PATIENT_LINE)).not.toBeInTheDocument()
    expect(screen.queryByText(DOCTOR_LINE)).not.toBeInTheDocument()
    expect(screen.queryByText(/reminders will show here/)).not.toBeInTheDocument()
  })
})
