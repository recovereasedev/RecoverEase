import type { Page, Route } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * The adviser's "AI Chatbot On/Off" in a real browser (migration 38).
 *
 * The server enforces it - `chatbot-reply` refuses a switched-off assistant
 * before anything reaches the provider (unit and database tests). These check
 * what each person sees: the patient finds the assistant off instead of a
 * message box that would be refused, and keeps their history; a refusal that
 * arrives while they are sending turns the page off too; a Clinic Admin turns
 * it off for their clinic; a Super Admin turns it off for every clinic, and is
 * asked first. The record is served by the browser-only stub.
 */

const SESSION = 'c3333333-3333-4333-8333-333333333333'
const EARLIER = 'Can I shower with the dressing on?'

const CONVERSATION = {
  chat_session: [
    {
      chat_session_id: SESSION,
      pat_id: IDS.alicePat,
      chat_session_external_ref: null,
      chat_session_started_at: '2026-03-05T02:00:00Z',
      chat_session_ended_at: null,
      chat_session_has_critical_flag: false,
      chat_session_summary: null,
    },
  ],
  chat_message: [
    {
      chat_message_id: 'patient-earlier',
      chat_session_id: SESSION,
      chat_message_role: 'patient',
      chat_message_content: EARLIER,
      chat_message_created_at: '2026-03-05T02:01:00Z',
    },
    {
      chat_message_id: 'assistant-earlier',
      chat_session_id: SESSION,
      chat_message_role: 'assistant',
      chat_message_content: 'Keep it dry; ask your care team when it can come off.',
      chat_message_created_at: '2026-03-05T02:01:30Z',
    },
  ],
}

const OFF_MESSAGE = 'The guidance assistant is turned off, so new messages can’t be sent here.'

function watchReplies(page: Page) {
  const counts = { replyRequests: 0 }
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/functions/v1/chatbot-reply')) {
      counts.replyRequests += 1
    }
  })
  return counts
}

test.describe('the patient, when the guidance assistant is off', () => {
  test('finds it off, with no message box and no openers, and keeps their history', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', CONVERSATION)
    stub.setRpcResult('guidance_assistant_available', false)
    const counts = watchReplies(page)

    await page.goto('/patient/chat')

    await expect(page.getByText(OFF_MESSAGE)).toBeVisible()
    await expect(page.getByLabel(/your message/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /send message/i })).toHaveCount(0)

    // The latest conversation still opens, and reads as it was.
    await expect(page.getByText(EARLIER)).toBeVisible()
    await expect(page.getByRole('button', { name: /5 March at 10:00/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Get a reply' })).toHaveCount(0)

    // A new conversation offers nothing to fill a box that is not there.
    await page.getByRole('button', { name: /start new/i }).first().click()
    await expect(page.getByRole('heading', { name: 'The guidance assistant is turned off' })).toBeVisible()
    await expect(page.getByText('You could ask')).toHaveCount(0)

    expect(counts.replyRequests).toBe(0)
  })

  test('is told it was turned off when the server refuses mid-send, and the page follows', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', CONVERSATION)
    // Switched off between the page loading and the patient sending.
    await page.route('**/functions/v1/chatbot-reply', (route: Route) => {
      stub.setRpcResult('guidance_assistant_available', false)
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The guidance assistant is turned off.', code: 'disabled' }),
      })
    })

    await page.goto('/patient/chat')
    await page.getByLabel(/your message/i).fill('Is mild swelling normal?')
    await page.getByRole('button', { name: /send message/i }).click()

    // No review is asked for while it is off, so nothing suggests anyone will
    // follow the message up.
    await expect(
      page.getByText(
        'The guidance assistant is turned off. Your message has been saved, but no one has been alerted to it. For anything about your recovery, contact your care team.',
      ),
    ).toBeVisible()
    await expect(page.getByText(/care team can still see it/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    await expect(page.getByText(OFF_MESSAGE)).toBeVisible()
    await expect(page.getByLabel(/your message/i)).toHaveCount(0)
  })
})

test.describe('the Clinic Admin', () => {
  test('turns guidance chat off for their clinic', async ({ page, signInAs }) => {
    await signInAs('admin')
    const writes: unknown[] = []
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/system_setting') && ['POST', 'PATCH'].includes(request.method())) {
        writes.push(request.postDataJSON())
      }
    })

    await page.goto('/admin/settings')
    // The card: the innermost element holding both its heading and its choices.
    const card = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Guidance chat' }) })
      .filter({ has: page.getByRole('radio', { name: /^On/ }) })
      .last()
    await expect(card.getByText('On · Never changed')).toBeVisible()
    await expect(card.getByRole('radio', { name: /^On/ })).toBeChecked()
    await expect(card.getByRole('button', { name: 'Save' })).toBeDisabled()

    await card.getByRole('radio', { name: /^Off/ }).check()
    await card.getByRole('button', { name: 'Save' }).click()

    await expect
      .poll(() => writes)
      .toEqual([
        {
          admin_id: IDS.admin,
          clinic_id: 'clinic-harborview',
          system_setting_key: 'chatbot.enabled',
          system_setting_value: 'false',
        },
      ])
  })
})

test.describe('the Super Admin', () => {
  test('turns the assistant off for every clinic, after saying what that does', async ({ page, signInAs }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    stub.setRpcResult('super_admin_get_guidance_assistant', [{ enabled: true, updated_at: null }])
    const sent: unknown[] = []
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/rpc/super_admin_set_guidance_assistant')) {
        sent.push(request.postDataJSON())
      }
    })

    await page.goto('/platform')
    await expect(page.getByText('On for every clinic', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Turn off for every clinic' }).click()
    const dialog = page.getByRole('dialog', { name: 'Turn the guidance assistant off for every clinic?' })
    await expect(dialog).toContainText('No patient in any clinic gets an answer')
    // Nothing is sent until it is confirmed.
    expect(sent).toEqual([])

    stub.setRpcResult('super_admin_set_guidance_assistant', false)
    stub.setRpcResult('super_admin_get_guidance_assistant', [
      { enabled: false, updated_at: new Date().toISOString() },
    ])
    await dialog.getByRole('button', { name: 'Turn off for every clinic' }).click()

    await expect.poll(() => sent).toEqual([{ enabled: false }])
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Off for every clinic', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn on for every clinic' })).toBeVisible()
  })

  test('says it was not turned off when turning it off fails, also once the dialog is closed', async ({ page, signInAs }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    stub.setRpcResult('super_admin_get_guidance_assistant', [{ enabled: true, updated_at: null }])
    await page.route('**/rest/v1/rpc/super_admin_set_guidance_assistant', (route: Route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'XX000', message: 'could not save', details: null, hint: null }),
      }),
    )

    await page.goto('/platform')
    await page.getByRole('button', { name: 'Turn off for every clinic' }).click()
    const dialog = page.getByRole('dialog', { name: 'Turn the guidance assistant off for every clinic?' })
    await dialog.getByRole('button', { name: 'Turn off for every clinic' }).click()
    await expect(dialog).toContainText('The guidance assistant was not turned off')

    await dialog.getByRole('button', { name: 'Keep it on' }).click()
    await expect(dialog).toBeHidden()
    // The closed dialog keeps its own copy in the page, hidden; roles skip it.
    const alerts = page.getByRole('alert')
    await expect(alerts.filter({ hasText: 'The guidance assistant was not turned off' })).toBeVisible()
    await expect(alerts.filter({ hasText: 'was not turned on' })).toHaveCount(0)
    await expect(page.getByText('On for every clinic', { exact: true })).toBeVisible()
  })
})
