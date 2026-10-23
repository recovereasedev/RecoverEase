import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 7.1 from the doctor's Notifications page: choose one of your own
 * patients, then write to them. The list is the doctor's own patients as Row
 * Level Security returns them (`useMyPatients`); the database checks the
 * insert again either way (tests/db/doctor-notifications.test.ts).
 */

const state = vi.hoisted(() => ({
  patients: {
    isPending: false,
    error: null as unknown,
    data: [] as unknown[] | undefined,
    refetch: vi.fn(),
  },
  send: vi.fn(),
}))

vi.mock('@/features/patients/hooks', () => ({
  useMyPatients: () => state.patients,
}))

vi.mock('@/features/notifications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/notifications/api')>()),
  sendNotificationToPatient: state.send,
  fetchNotifications: async () => [],
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-doctor',
    role: 'doctor',
    profile: { kind: 'doctor', doctor: { doc_id: 'd-1' } },
  }),
}))

const { SendPatientNotification } = await import(
  '@/features/notifications/components/send-patient-notification'
)
const { NotificationsPage } = await import('@/features/notifications/pages/notifications-page')

const ALICE = { pat_id: 'p-alice', user_id: 'u-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' }
const BOB = { pat_id: 'p-bob', user_id: 'u-bob', pat_first_name: 'Bob', pat_last_name: 'Reyes' }

function withQueries(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Picks a patient the way a person does: types, then chooses from the list. */
function choosePatient(name: string) {
  const picker = screen.getByRole('combobox', { name: 'Patient' })
  fireEvent.focus(picker)
  fireEvent.change(picker, { target: { value: name.split(' ')[0] } })
  fireEvent.mouseDown(screen.getByRole('option', { name }))
}

beforeEach(() => {
  state.patients = { isPending: false, error: null, data: [ALICE, BOB], refetch: vi.fn() }
  state.send.mockReset().mockResolvedValue(undefined)
})

describe('sending a notification from the Notifications page', () => {
  it('offers only the doctor’s own patients', () => {
    render(withQueries(<SendPatientNotification />))

    const picker = screen.getByRole('combobox', { name: 'Patient' })
    fireEvent.focus(picker)
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Alice Santos', 'Bob Reyes'])
    expect(screen.getByText('Only your own patients are listed.')).toBeInTheDocument()
  })

  it('asks for a patient before there is anything to write', () => {
    render(withQueries(<SendPatientNotification />))

    expect(screen.getByText('Choose a patient to write to them.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('sends the message to the patient chosen', async () => {
    render(withQueries(<SendPatientNotification />))
    choosePatient('Bob Reyes')

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'See you on Thursday.' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send notification/i }))
    })

    expect(state.send).toHaveBeenCalledTimes(1)
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({
      userId: 'u-bob',
      type: 'general',
      message: 'See you on Thursday.',
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to Bob Reyes.')
  })

  it('starts an empty message when another patient is chosen', () => {
    render(withQueries(<SendPatientNotification />))
    choosePatient('Alice Santos')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'For Alice only.' } })

    choosePatient('Bob Reyes')

    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('says so when the doctor has no patients yet', () => {
    state.patients = { ...state.patients, data: [] }
    render(withQueries(<SendPatientNotification />))

    expect(screen.getByText('You have no patients to notify yet.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('says so, and offers a retry, when the patients could not be loaded', () => {
    state.patients = { ...state.patients, data: undefined, error: new Error('Failed to fetch') }
    render(withQueries(<SendPatientNotification />))

    expect(screen.getByRole('alert')).toHaveTextContent('No connection')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(state.patients.refetch).toHaveBeenCalled()
  })
})

describe('the Notifications page', () => {
  function renderAt(path: string) {
    render(
      withQueries(
        <MemoryRouter initialEntries={[path]}>
          <NotificationsPage />
        </MemoryRouter>,
      ),
    )
  }

  it('offers a doctor the form beside their notifications', () => {
    renderAt('/doctor/notifications')
    expect(screen.getByRole('heading', { name: 'Send a notification' })).toBeInTheDocument()
  })

  it.each(['/patient/notifications', '/admin/notifications'])(
    'offers nothing to send at %s',
    (path) => {
      renderAt(path)
      expect(screen.queryByRole('heading', { name: 'Send a notification' })).not.toBeInTheDocument()
    },
  )
})
