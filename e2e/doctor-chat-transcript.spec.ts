import { expect, IDS, test } from './support/fixtures'

/**
 * Module 8.5 "View Patient Chat Transcript": the doctor reads a patient's
 * guidance chat from their record, and a critical-chat alert opens the
 * conversation it is about. Read-only throughout.
 */

const FLAGGED = 'c5a11111-1111-4111-8111-111111111111'
const EARLIER = 'c5a22222-2222-4222-8222-222222222222'
const ALERT_TEXT =
  'A patient raised a concern in the guidance chat that may need your attention.'

const chat = {
  chat_session: [
    {
      chat_session_id: FLAGGED,
      pat_id: IDS.alicePat,
      chat_session_external_ref: null,
      chat_session_started_at: '2026-03-05T02:00:00Z',
      chat_session_ended_at: null,
      chat_session_has_critical_flag: true,
      chat_session_summary: 'The assistant advised seeking care now.',
    },
    {
      chat_session_id: EARLIER,
      pat_id: IDS.alicePat,
      chat_session_external_ref: null,
      chat_session_started_at: '2026-03-01T02:00:00Z',
      chat_session_ended_at: null,
      chat_session_has_critical_flag: false,
      chat_session_summary: null,
    },
  ],
  chat_message: [
    {
      chat_message_id: 'm1111111-1111-4111-8111-111111111111',
      chat_session_id: FLAGGED,
      chat_message_role: 'patient',
      chat_message_content: 'My wound is hot and swollen.',
      chat_message_created_at: '2026-03-05T02:00:00Z',
    },
    {
      chat_message_id: 'm2222222-2222-4222-8222-222222222222',
      chat_session_id: FLAGGED,
      chat_message_role: 'assistant',
      chat_message_content: 'Please contact your doctor or emergency services now.',
      chat_message_created_at: '2026-03-05T02:00:05Z',
    },
    {
      chat_message_id: 'm3333333-3333-4333-8333-333333333333',
      chat_session_id: EARLIER,
      chat_message_role: 'patient',
      chat_message_content: 'Is it normal for the knee to click?',
      chat_message_created_at: '2026-03-01T02:00:00Z',
    },
  ],
  notification: [
    {
      notification_id: 'n1111111-1111-4111-8111-111111111111',
      user_id: IDS.doctorAUser,
      chat_session_id: FLAGGED,
      notification_type: 'chat_critical',
      notification_message: ALERT_TEXT,
      notification_is_read: false,
      notification_created_at: '2026-03-05T02:00:06Z',
      // PostgREST embeds this through the foreign key; the stub carries it.
      chat_session: { pat_id: IDS.alicePat },
    },
  ],
}

test.describe('a patient’s guidance chat, as their doctor reads it', () => {
  test('opens from the patient record and reads top to bottom', async ({ page, signInAs }) => {
    await signInAs('doctor', chat)
    await page.goto('/doctor/patients')
    await page.getByRole('link', { name: 'Alice Santos' }).first().click()

    await page.getByRole('tab', { name: 'Chat' }).click()

    await expect(page.getByRole('heading', { name: 'Guidance chat' })).toBeVisible()
    // `exact`: the list of conversations beside it is "Conversations".
    const conversation = page.getByRole('list', { name: 'Conversation', exact: true })
    await expect(conversation.getByRole('listitem')).toHaveText([
      /Patient\s*My wound is hot and swollen\./,
      /Assistant\s*Please contact your doctor or emergency services now\./,
    ])
    await expect(page.getByText(/flagged for your attention/)).toBeVisible()

    // The earlier conversation is one choice away.
    await page
      .getByRole('list', { name: 'Conversations', exact: true })
      .getByRole('button')
      .last()
      .click()
    await expect(conversation.getByText('Is it normal for the knee to click?')).toBeVisible()

    // Read-only: nothing to type into, nothing to send.
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /send/i })).toHaveCount(0)
  })

  test('a critical-chat alert opens the conversation it is about', async ({ page, signInAs }) => {
    await signInAs('doctor', chat)
    await page.goto('/doctor/notifications')

    await page.getByRole('link', { name: /^View conversation/ }).click()

    await expect(page).toHaveURL(
      new RegExp(`/doctor/patients/${IDS.alicePat}\\?tab=chat&session=${FLAGGED}$`),
    )
    await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { level: 1, name: 'Alice Santos' })).toBeVisible()
    await expect(page.getByText('My wound is hot and swollen.')).toBeVisible()
    await expect(page.getByText('Is it normal for the knee to click?')).toHaveCount(0)
  })

  test('says so when the patient has not used the chat', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=chat`)

    await expect(page.getByText('This patient has not used the guidance chat.')).toBeVisible()
  })
})
