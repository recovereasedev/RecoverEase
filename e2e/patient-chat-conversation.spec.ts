import { expect, IDS, test } from './support/fixtures'

/**
 * The patient's guidance chat, as a keyboard and screen-reader user meets it.
 *
 * From `lg` a long conversation is its own scrolling box, which the browser
 * puts in the Tab order: it is a region named "Conversation", so focusing it
 * says what it holds. Opening the chat brings the newest message into that
 * box without moving where Tab starts, so the first Tab still reaches the
 * skip link. Below `lg` the conversation stays part of the page (M5).
 */

const SESSION = 'c1111111-1111-4111-8111-111111111111'

const LONG_CONVERSATION = {
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
  chat_message: Array.from({ length: 30 }, (_, index) => ({
    chat_message_id: `m${String(index).padStart(7, '0')}-1111-4111-8111-111111111111`,
    chat_session_id: SESSION,
    chat_message_role: index % 2 === 0 ? 'patient' : 'assistant',
    chat_message_content:
      index === 29
        ? 'The newest reply in this conversation.'
        : `Message ${index + 1} about walking a little further each day.`,
    chat_message_created_at: new Date(Date.UTC(2026, 2, 5, 2, index)).toISOString(),
  })),
}

test.describe('the guidance chat conversation', () => {
  test('is a named region that opens on its newest message', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await signInAs('patient', LONG_CONVERSATION)
    await page.goto('/patient/chat')

    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation.getByText('The newest reply in this conversation.')).toBeVisible()

    const box = await conversation.evaluate((element) => ({
      scrolls: element.scrollHeight > element.clientHeight,
      atEnd: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2,
    }))
    expect(box).toEqual({ scrolls: true, atEnd: true })
  })

  test('still starts Tab at the skip link', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await signInAs('patient', LONG_CONVERSATION)
    await page.goto('/patient/chat')
    await expect(page.getByText('The newest reply in this conversation.')).toBeVisible()

    await page.keyboard.press('Tab')

    await expect(page.getByRole('link', { name: /skip to main content/i })).toBeFocused()
  })

  test('stays part of the page on a phone', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signInAs('patient', LONG_CONVERSATION)
    await page.goto('/patient/chat')

    const conversation = page.getByRole('region', { name: 'Conversation' })
    await expect(conversation.getByText('The newest reply in this conversation.')).toBeAttached()
    // Not a box of its own below `lg`: the page scrolls, the conversation
    // does not (M5), and nothing is wider than the screen.
    expect(await conversation.evaluate((element) => getComputedStyle(element).overflowY)).toBe(
      'visible',
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0)
  })
})
