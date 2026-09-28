import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * The redesigned guidance chat: its waiting state, a new conversation, the
 * phone's past-conversations view, how far the transcript scrolls, and the
 * assistant's picture.
 *
 * The waiting state stands for a request that is really in flight - it is
 * shown only while the reply request is pending, and a second message cannot
 * be sent until the first is answered. Choosing a suggested question only
 * fills the composer. Nothing here changes what is stored or sent.
 */

const SESSION = 'c2222222-2222-4222-8222-222222222222'

/** One earlier conversation, so the history has something to open. */
const ONE_CONVERSATION = {
  chat_session: [
    {
      chat_session_id: SESSION,
      pat_id: IDS.alicePat,
      chat_session_external_ref: null,
      chat_session_started_at: '2026-03-05T02:00:00Z',
      chat_session_ended_at: null,
      chat_session_has_critical_flag: false,
      chat_session_summary: 'Keeping a daily log of symptoms and rest',
    },
  ],
  chat_message: [
    {
      chat_message_id: 'm2222222-2222-4222-8222-222222222222',
      chat_session_id: SESSION,
      chat_message_role: 'patient',
      chat_message_content: 'How should I keep a daily log?',
      chat_message_created_at: '2026-03-05T02:00:00Z',
    },
  ],
}

/** The same conversation, long enough that its transcript has to scroll. */
const LONG_CONVERSATION = {
  chat_session: ONE_CONVERSATION.chat_session,
  chat_message: [0, 1, 2, 3, 4, 5].map((n) => ({
    chat_message_id: `m${n}222222-2222-4222-8222-222222222222`,
    chat_session_id: SESSION,
    chat_message_role: n % 2 === 0 ? 'patient' : 'assistant',
    chat_message_content:
      n % 2 === 0
        ? 'How should I keep a daily log?'
        : 'A short note each day about how you slept, any pain, and what you managed to do is enough. Bring it to your next appointment so your care team can see how things are going.',
    chat_message_created_at: `2026-03-05T02:0${n}:00Z`,
  })),
}

/** Holds the assistant's reply until the test lets it go. */
async function holdReply(page: Page) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/functions/v1/chatbot-reply', async (route) => {
    await released
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: {
          chat_message_id: 'assistant-1',
          chat_session_id: 'chat-1',
          chat_message_role: 'assistant',
          chat_message_content: 'Some swelling is common at two weeks.',
          chat_message_created_at: new Date().toISOString(),
        },
        raisedCriticalConcern: false,
        safetyLevel: 'normal',
        shouldContactProvider: false,
      }),
    })
  })
  return () => release()
}

/** Every patient message the page asks the server to store. */
function watchSentMessages(page: Page): string[] {
  const sent: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/rest/v1/chat_message')
    ) {
      sent.push(request.postData() ?? '')
    }
  })
  return sent
}

test.describe('the guidance chat', () => {
  test('shows that a reply is being prepared only while it is, and sends one message at a time', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    const release = await holdReply(page)
    const sent = watchSentMessages(page)
    await page.goto('/patient/chat')
    const composer = page.getByLabel(/your message/i)

    await composer.fill('Is swelling normal after two weeks?')
    await page.getByRole('button', { name: /send message/i }).click()

    const waiting = page.getByRole('status')
    await expect(waiting).toContainText('Guidance chat is processing…')
    await expect(waiting).toContainText('Please wait while I prepare a response.')
    await expect(page.getByText('Received', { exact: true })).toBeVisible()

    // A second message while the first is waiting is not sent, and stays in
    // the composer for when the reply arrives.
    await composer.fill('And what about stairs?')
    await composer.press('Enter')
    await expect(composer).toHaveValue('And what about stairs?')
    expect(sent).toHaveLength(1)

    release()
    await expect(page.getByText('Guidance chat is processing…')).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveCount(0)
    expect(sent).toHaveLength(1)
  })

  test('starts a new conversation with suggestions that only fill the composer', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    const sent = watchSentMessages(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/patient/chat')

    await page.getByRole('button', { name: /^start new$/i }).click()
    await expect(
      page.getByRole('heading', { name: 'How can I support you with your recovery today?' }),
    ).toBeVisible()

    await page
      .getByRole('button', { name: 'What should I remember before my follow-up appointment?' })
      .click()

    const composer = page.getByLabel(/your message/i)
    await expect(composer).toHaveValue('What should I remember before my follow-up appointment?')
    await expect(composer).toBeFocused()
    expect(sent).toHaveLength(0)
  })

  test('on a phone, shows past conversations in place of the chat and returns focus', async ({
    page,
    signInAs,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signInAs('patient', ONE_CONVERSATION)
    await page.goto('/patient/chat')

    const openHistory = page.getByRole('button', { name: 'Past conversations' })
    await expect(openHistory).toBeVisible()
    const box = await openHistory.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)

    await page.keyboard.press('Shift')
    await openHistory.focus()
    await page.keyboard.press('Enter')

    const heading = page.getByRole('heading', { name: 'Past conversations' })
    await expect(heading).toBeFocused()
    await expect(page.getByLabel(/your message/i)).toBeHidden()

    await page.getByRole('button', { name: 'Back to conversation' }).click()
    await expect(page.getByLabel(/your message/i)).toBeVisible()
    await expect(openHistory).toBeFocused()

    // Choosing a conversation opens it and puts focus on its header.
    await openHistory.click()
    await page
      .getByRole('complementary', { name: 'Past conversations' })
      .getByRole('button', { name: /Keeping a daily log/ })
      .click()
    await expect(page.getByRole('heading', { name: 'Recovery Guidance Assistant' })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })

  test('fits the chat to a tall desktop screen and lets a short one scroll', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    const region = page.getByRole('region', { name: 'Conversation' })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/patient/chat')
    await expect(region).toBeVisible()
    expect(await region.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect
      .poll(() => region.evaluate((el) => getComputedStyle(el).overflowY))
      .toBe('visible')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })

  test('on a tall desktop, scrolls the conversation all the way to the newest message', async ({
    page,
    signInAs,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const stub = await signInAs('patient', LONG_CONVERSATION)
    const release = await holdReply(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/patient/chat')
    const region = page.getByRole('region', { name: 'Conversation' })
    await expect(region.getByRole('listitem')).toHaveCount(6)
    expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    const distanceFromEnd = () =>
      region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

    await page.getByLabel(/your message/i).fill('Is swelling normal after two weeks?')
    await page.getByRole('button', { name: /send message/i }).click()
    await expect(page.getByRole('status')).toContainText('Guidance chat is processing…')
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1)

    // The reply, stored as the Edge Function stores it, arrives after the
    // waiting state has gone. The transcript still ends at it - not a
    // message-gap short, which the spacing between messages once caused.
    stub.addRows('chat_message', [
      {
        chat_message_id: 'm9222222-2222-4222-8222-222222222222',
        chat_session_id: SESSION,
        chat_message_role: 'assistant',
        chat_message_content: 'Some swelling is common at two weeks.',
        chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ])
    release()
    await expect(region.getByText('Some swelling is common at two weeks.')).toBeVisible()
    await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1)
  })

  test("shows RecoverEase's own mark as the assistant's picture, without reading it out again", async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/chat')

    const assistant = page.getByRole('region', { name: 'Recovery Guidance Assistant' })
    await expect(assistant.locator('svg[aria-label="RecoverEase"]').first()).toBeVisible()
    // The name is written beside it, so the mark adds nothing to hear.
    await expect(assistant.getByRole('img', { name: 'RecoverEase' })).toHaveCount(0)
  })
})
