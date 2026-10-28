import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 7.1, "Send Notification to Patient".
 *
 * A clinician writing to a patient, from the patient's record. What it says
 * has to be unmistakably *to* the patient: the same screen carries clinical
 * notes, which the patient never sees, and the two must not be confusable.
 *
 * Who may be notified is the database's decision, not this component's - the
 * insert policy allows a doctor only their own patients, and that is covered
 * in `tests/db/rls.test.ts`. What is covered here is that the message the
 * clinician wrote is the message that is sent, to the patient whose record is
 * open, and that they are told whether it went.
 */

const api = vi.hoisted(() => ({ sendNotificationToPatient: vi.fn() }))

vi.mock('@/features/notifications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/notifications/api')>()),
  sendNotificationToPatient: api.sendNotificationToPatient,
}))

/** The id each call was sent under. */
const sentIds = () =>
  api.sendNotificationToPatient.mock.calls.map(
    (call) => (call[0] as { notificationId: string }).notificationId,
  )

const { NotifyPatient } = await import(
  '@/features/notifications/components/notify-patient'
)

const PATIENT = {
  patientUserId: '11111111-1111-4111-8111-111111111111',
  patientName: 'Alice Santos',
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <NotifyPatient {...PATIENT} />
    </QueryClientProvider>,
  )
}

const messageBox = () => screen.getByLabelText('Message')
const sendButton = () => screen.getByRole('button', { name: /send notification/i })

async function send(text: string) {
  fireEvent.change(messageBox(), { target: { value: text } })
  await act(async () => {
    fireEvent.click(sendButton())
  })
}

beforeEach(() => {
  api.sendNotificationToPatient.mockReset()
  api.sendNotificationToPatient.mockResolvedValue(undefined)
})

describe('notifying a patient', () => {
  it('says who reads it, and that it is not a clinical note', () => {
    renderCard()

    expect(
      screen.getByRole('heading', { name: 'Send a notification' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Alice Santos reads this in their notifications. It is not a clinical note.',
      ),
    ).toBeInTheDocument()
  })

  it('sends what was written, to the patient whose record is open', async () => {
    renderCard()

    await send('  Bring your medication list on Thursday.  ')

    expect(api.sendNotificationToPatient).toHaveBeenCalledTimes(1)
    expect(api.sendNotificationToPatient.mock.calls[0]?.[0]).toEqual({
      notificationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      userId: PATIENT.patientUserId,
      type: 'general',
      message: 'Bring your medication list on Thursday.',
    })
  })

  it('confirms it was sent, and clears the box for the next one', async () => {
    renderCard()

    await send('Bring your medication list on Thursday.')

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent to Alice Santos.',
    )
    expect(messageBox()).toHaveValue('')
  })

  it('drops the confirmation once the next message is being written', async () => {
    renderCard()
    await send('Bring your medication list on Thursday.')

    fireEvent.change(messageBox(), { target: { value: 'One more thing' } })

    // SavedNotice keeps the status region in the document and changes only
    // its text: no confirmation is an empty region, not a missing one.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('sends nothing at all when there is nothing to send, and says so', async () => {
    renderCard()

    // Pressable, rather than disabled with no reason given (M7).
    expect(sendButton()).toBeEnabled()
    await send('')
    await send('   ')

    expect(api.sendNotificationToPatient).not.toHaveBeenCalled()
    // Said beside the box, which is marked and takes focus.
    expect(screen.getByRole('alert')).toHaveTextContent('Write the message.')
    expect(messageBox()).toHaveAttribute('aria-invalid', 'true')
    expect(messageBox()).toHaveFocus()

    // Writing clears it.
    fireEvent.change(messageBox(), { target: { value: 'Bring your list.' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(messageBox()).not.toHaveAttribute('aria-invalid')
  })

  it('says so when it was not sent, and keeps what was written', async () => {
    api.sendNotificationToPatient.mockRejectedValue(new Error('the server said no'))
    renderCard()

    await send('Bring your medication list on Thursday.')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The notification was not sent',
    )
    expect(messageBox()).toHaveValue('Bring your medication list on Thursday.')
    // SavedNotice keeps the status region in the document and changes only
    // its text: no confirmation is an empty region, not a missing one.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('does not repeat the database at a clinician when the insert is refused', async () => {
    api.sendNotificationToPatient.mockRejectedValue(
      new Error('new row violates row-level security policy for table "notification"'),
    )
    renderCard()

    await send('Bring your medication list on Thursday.')

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent('You do not have access to this')
    expect(refusal).not.toHaveTextContent(/row-level security/)
  })

  it('never sends as a kind the system raises for itself', async () => {
    renderCard()

    await send('Bring your medication list on Thursday.')

    const [sent] = api.sendNotificationToPatient.mock.calls[0] as [
      { type: string },
    ]
    expect(sent.type).toBe('general')
    expect(['chat_critical', 'medication', 'appointment']).not.toContain(sent.type)
  })
})

describe('sending once', () => {
  it('sends a retry of the same message under the same id, so it cannot arrive twice', async () => {
    api.sendNotificationToPatient
      .mockRejectedValueOnce(new Error('the server said no'))
      .mockResolvedValueOnce(undefined)
    renderCard()

    await send('Bring your medication list on Thursday.')
    expect(await screen.findByRole('alert')).toHaveTextContent('The notification was not sent')
    await act(async () => {
      fireEvent.click(sendButton())
    })

    expect(api.sendNotificationToPatient).toHaveBeenCalledTimes(2)
    const [first, retry] = sentIds()
    expect(retry).toBe(first)
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to Alice Santos.')
  })

  it('ignores a second press while the first is still on its way', async () => {
    let finish: () => void = () => {}
    api.sendNotificationToPatient.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    renderCard()

    await send('Bring your medication list on Thursday.')
    await waitFor(() => expect(sendButton()).toHaveAttribute('aria-busy', 'true'))
    await act(async () => {
      fireEvent.click(sendButton())
    })
    expect(api.sendNotificationToPatient).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to Alice Santos.')
  })

  it('sends two submits in the same instant under one id, which the database stores once', async () => {
    renderCard()
    fireEvent.change(messageBox(), { target: { value: 'Bring your medication list on Thursday.' } })

    // Before the first has re-rendered the button as busy.
    const form = sendButton().closest('form')!
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    const ids = sentIds()
    expect(ids.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ids).size).toBe(1)
  })

  it('gives the next message, and any edited one, an id of its own', async () => {
    api.sendNotificationToPatient.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderCard()

    await send('Bring your list.')
    // Changed after a failure: a different message now, so a new id.
    await send('Bring your medication list.')
    // And the one after a successful send is new again.
    await send('One more thing.')

    const [failed, edited, next] = sentIds()
    expect(new Set([failed, edited, next]).size).toBe(3)
  })
})

describe('the message’s length', () => {
  it('allows up to 1,000 characters, and says so', () => {
    renderCard()

    expect(messageBox()).toHaveAttribute('maxlength', '1000')
    expect(messageBox()).toHaveAccessibleDescription('Up to 1,000 characters.')
    expect(screen.getByText('0 / 1,000')).toBeInTheDocument()
    fireEvent.change(messageBox(), { target: { value: 'Bring your list.' } })
    expect(screen.getByText('16 / 1,000')).toBeInTheDocument()
  })

  it('sends nothing longer, and says why', async () => {
    renderCard()

    await send('x'.repeat(1001))

    expect(api.sendNotificationToPatient).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Keep the message to 1,000 characters or fewer.',
    )
    expect(messageBox()).toHaveFocus()
  })

  it('sends exactly 1,000', async () => {
    renderCard()

    await send('x'.repeat(1000))

    expect(api.sendNotificationToPatient).toHaveBeenCalledTimes(1)
  })
})
