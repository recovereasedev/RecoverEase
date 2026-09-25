import type { Page } from '@playwright/test'

import { expect, test } from './support/fixtures'

/**
 * Where keyboard focus goes after sending a guidance-chat message.
 *
 * Send is disabled while the composer is empty, and sending empties it, so a
 * keyboard user who tabbed to Send and pressed it was left with focus on the
 * page itself. Focus now returns to the composer, where the next message is
 * written. Enter in the composer - the usual way to send - already kept it
 * there, and still does.
 */

/** A well-formed assistant reply, so the send completes (see patient-workflows). */
async function answerChat(page: Page) {
  await page.route('**/functions/v1/chatbot-reply', (route) =>
    route.fulfill({
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
    }),
  )
}

test.describe('sending a chat message from the keyboard', () => {
  test('Send, reached with Tab, leaves focus in the composer', async ({ page, signInAs }) => {
    await signInAs('patient')
    await answerChat(page)
    await page.goto('/patient/chat')
    const composer = page.getByLabel(/your message/i)

    await composer.fill('Is swelling normal after two weeks?')
    await page.keyboard.press('Shift')
    await composer.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: /send message/i })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page.getByText('Is swelling normal after two weeks?')).toBeVisible()
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('')
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  })

  test('Enter in the composer still sends and keeps focus there', async ({ page, signInAs }) => {
    await signInAs('patient')
    await answerChat(page)
    await page.goto('/patient/chat')
    const composer = page.getByLabel(/your message/i)

    await composer.focus()
    await page.keyboard.type('Can I shower normally?')
    await page.keyboard.press('Enter')

    await expect(page.getByText('Can I shower normally?')).toBeVisible()
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('')
  })

  test('Shift+Enter still makes a new line rather than sending', async ({ page, signInAs }) => {
    await signInAs('patient')
    await answerChat(page)
    await page.goto('/patient/chat')
    const composer = page.getByLabel(/your message/i)

    await composer.focus()
    await page.keyboard.type('First line')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('second line')

    await expect(composer).toHaveValue('First line\nsecond line')
    await expect(composer).toBeFocused()
  })
})
