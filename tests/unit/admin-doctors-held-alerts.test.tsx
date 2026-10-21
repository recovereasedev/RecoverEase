import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Doctor } from '@/features/patients/api'

/**
 * Doctor accounts shows, against a deactivated doctor, how many critical
 * alerts from the guidance chat are waiting for a clinician (migration 38) -
 * beside "Reassign patients", which is what delivers them. A count, never a
 * patient or a conversation.
 */

const api = vi.hoisted(() => ({
  fetchAllDoctors: vi.fn(),
  fetchHeldChatAlertCounts: vi.fn(),
}))

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  ...api,
}))

const { AdminDoctorsPage, heldAlertsLine } = await import(
  '@/features/patients/pages/admin-doctors-page'
)

function doctor(id: string, first: string, last: string, active: boolean): Doctor {
  return {
    doc_id: id,
    user_id: `u-${id}`,
    clinic_id: 'c-1',
    doc_first_name: first,
    doc_last_name: last,
    doc_specialization: null,
    doc_license_no: `LIC-${id}`,
    doc_contact_no: null,
    doc_is_active: active,
    doc_created_at: '2026-01-01T00:00:00Z',
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/doctors']}>
        <AdminDoctorsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** A doctor's row, found by the name at its head (the buttons repeat it, unseen). */
const nameOf = (name: string) => new RegExp(`^Dr\\s+${name}$`)
const rowOf = (name: string) =>
  within(screen.getByText(nameOf(name), { selector: 'p' }).closest('li') as HTMLElement)

beforeEach(() => {
  api.fetchAllDoctors.mockResolvedValue([
    doctor('d-a', 'Alan', 'Cruz', true),
    doctor('d-c', 'Cay', 'Tan', false),
    doctor('d-x', 'Xen', 'Ong', false),
  ])
})

describe('alerts waiting for a clinician, on Doctor accounts', () => {
  it('shows the count against the deactivated doctor, beside Reassign patients, and nowhere else', async () => {
    api.fetchHeldChatAlertCounts.mockResolvedValue({ 'd-c': 2 })
    renderPage()

    await screen.findByText(nameOf('Cay Tan'), { selector: 'p' })
    expect(
      await rowOf('Cay Tan').findByText(
        '2 alerts from the guidance chat are waiting for a clinician. Reassign these patients or reactivate the account to deliver them.',
      ),
    ).toBeInTheDocument()
    expect(rowOf('Cay Tan').getByRole('button', { name: /^Reassign patients/ })).toBeInTheDocument()
    expect(rowOf('Xen Ong').queryByText(/waiting for a clinician/)).not.toBeInTheDocument()
    expect(rowOf('Alan Cruz').queryByText(/waiting for a clinician/)).not.toBeInTheDocument()
  })

  it('says one alert in the singular', () => {
    expect(heldAlertsLine(1)).toBe(
      '1 alert from the guidance chat is waiting for a clinician. Reassign these patients or reactivate the account to deliver it.',
    )
  })

  it('shows nothing when no alert is waiting', async () => {
    api.fetchHeldChatAlertCounts.mockResolvedValue({})
    renderPage()

    await screen.findByText(nameOf('Cay Tan'), { selector: 'p' })
    expect(screen.queryByText(/waiting for a clinician\./)).not.toBeInTheDocument()
  })

  it('says so when the alerts could not be checked, rather than showing none', async () => {
    api.fetchHeldChatAlertCounts.mockRejectedValue(new Error('network'))
    renderPage()

    expect(
      await screen.findByText(/Alerts from the guidance chat waiting for a clinician could not be checked/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
