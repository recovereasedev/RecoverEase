import type { Page, Route } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * The guidance chat when a reply does not come back as it should: a request
 * that is never answered, a dropped connection, a slow or failing assistant.
 *
 * Whatever happens, the waiting state ends, the patient's message stays
 * saved and is never sent twice, and the patient is told what happened and
 * - where it can help - offered Try again, a bounded number of times.
 *
 * Every message here is synthetic. Nothing leaves the browser: Supabase and
 * the chatbot function are stubbed.
 */

const SESSION = 'c3333333-3333-4333-8333-333333333333'
const QUESTION = 'Is it normal to feel tired in the afternoons?'
const REPLY = 'Tiredness is common while you recover. Rest when you need to.'

/** A conversation the patient has already started, so it can be reopened. */
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
  chat_message: [],
}

function reply(status: number, body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
}

const success = reply(200, {
  message: {
    chat_message_id: 'assistant-1',
    chat_session_id: SESSION,
    chat_message_role: 'assistant',
    chat_message_content: REPLY,
    chat_message_created_at: new Date().toISOString(),
  },
  raisedCriticalConcern: false,
  safetyLevel: 'normal',
  shouldContactProvider: false,
})

/** Every request for a reply, and every patient message saved. */
function watch(page: Page) {
  const counts = { replyRequests: 0, messagesSaved: 0 }
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.endsWith('/functions/v1/chatbot-reply')) {
      counts.replyRequests += 1
    }
    if (request.method() === 'POST' && path.endsWith('/rest/v1/chat_message')) {
      counts.messagesSaved += 1
    }
  })
  return counts
}

async function send(page: Page, text = QUESTION) {
  await page.getByLabel(/your message/i).fill(text)
  await page.getByRole('button', { name: /send message/i }).click()
}

const processing = (page: Page) => page.getByText('Guidance chat is processing…')
const tryAgain = (page: Page) => page.getByRole('button', { name: 'Try again' })

test.describe('the guidance chat when a reply does not come back', () => {
  test('stops waiting when the reply never arrives, and says it took too long', async ({
    page,
    signInAs,
  }) => {
    await page.clock.install()
    await signInAs('patient', CONVERSATION)
    // Sent, and then never answered - not even with an error.
    await page.route('**/functions/v1/chatbot-reply', () => new Promise(() => {}))
    const counts = watch(page)
    await page.goto('/patient/chat')

    await send(page)
    await expect(processing(page)).toBeVisible()

    // A long wait is said out loud, while it is still a real, pending request.
    await page.clock.fastForward(13_000)
    await expect(page.getByRole('status')).toContainText('This is taking longer than usual.')

    // Then the browser gives up, and the waiting state ends.
    await page.clock.fastForward(30_000)
    await expect(processing(page)).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('took too long to reply')
    await expect(page.getByRole('status')).toContainText('Your message has been saved.')
    await expect(tryAgain(page)).toBeVisible()
    await expect(page.getByText(QUESTION)).toBeVisible()
    await expect(page.locator('[data-surface="dark"]')).toContainText('Not available right now')

    // Send is usable again for the next message.
    await page.getByLabel(/your message/i).fill('One more question')
    await expect(page.getByRole('button', { name: /send message/i })).toBeEnabled()
    expect(counts).toEqual({ replyRequests: 1, messagesSaved: 1 })
  })

  test('says the assistant could not be reached when the connection drops', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', CONVERSATION)
    await page.route('**/functions/v1/chatbot-reply', (route) =>
      route.abort('internetdisconnected'),
    )
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t be reached')
    await expect(page.getByRole('status')).toContainText('Your message has been saved.')
    await expect(tryAgain(page)).toBeVisible()
    await expect(processing(page)).toHaveCount(0)
  })

  test('waits through a slow reply, and shows it when it comes', async ({ page, signInAs }) => {
    await page.clock.install()
    const stub = await signInAs('patient', CONVERSATION)
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      await released
      await success(route)
    })
    await page.goto('/patient/chat')

    await send(page)
    await expect(processing(page)).toBeVisible()
    await page.clock.fastForward(20_000)
    await expect(page.getByRole('status')).toContainText('This is taking longer than usual.')

    // The reply is stored as the function stores it, then the response arrives.
    stub.addRows('chat_message', [
      {
        chat_message_id: 'a3333333-3333-4333-8333-333333333333',
        chat_session_id: SESSION,
        chat_message_role: 'assistant',
        chat_message_content: REPLY,
        chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ])
    release()
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(tryAgain(page)).toHaveCount(0)
  })

  test('tells a busy assistant from one that is not set up, and offers Try again only where it can help', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', CONVERSATION)
    let answer = reply(429, { error: 'The guidance assistant is busy.', code: 'busy' })
    await page.route('**/functions/v1/chatbot-reply', (route) => answer(route))
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByRole('status')).toContainText('busy right now')
    await expect(tryAgain(page)).toBeVisible()

    answer = reply(503, {
      error: 'The guidance assistant is not configured.',
      code: 'not_configured',
    })
    await tryAgain(page).click()
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    // Trying again cannot set the assistant up.
    await expect(tryAgain(page)).toHaveCount(0)
  })

  test('tries again for the saved message without sending it twice', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    let fail = true
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      if (fail) {
        await reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' })(route)
        return
      }
      stub.addRows('chat_message', [
        {
          chat_message_id: 'a4444444-4444-4444-8444-444444444444',
          chat_session_id: SESSION,
          chat_message_role: 'assistant',
          chat_message_content: REPLY,
          chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ])
      await success(route)
    })
    const counts = watch(page)
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByRole('status')).toContainText('not available at the moment')

    fail = false
    // A quick double click is still one request.
    await tryAgain(page).dblclick()
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.getByText(QUESTION)).toHaveCount(1)
    expect(counts).toEqual({ replyRequests: 2, messagesSaved: 1 })
  })

  test('shows the reply when it turns out to have been saved after all', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    let first = true
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      if (first) {
        first = false
        await reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' })(route)
        return
      }
      await reply(400, { error: 'There is nothing to reply to', code: 'already_answered' })(route)
    })
    await page.goto('/patient/chat')

    await send(page)
    await expect(tryAgain(page)).toBeVisible()
    // Meanwhile an earlier, slow request saved its reply after all.
    stub.addRows('chat_message', [
      {
        chat_message_id: 'a5555555-5555-4555-8555-555555555555',
        chat_session_id: SESSION,
        chat_message_role: 'assistant',
        chat_message_content: REPLY,
        chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ])
    await tryAgain(page).click()

    // Not an error: the conversation simply shows the reply.
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(tryAgain(page)).toHaveCount(0)
  })

  test('drops the failure once the conversation shows a reply saved despite a lost response', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      // The reply is saved, but the response never makes it back.
      stub.addRows('chat_message', [
        {
          chat_message_id: 'a7777777-7777-4777-8777-777777777777',
          chat_session_id: SESSION,
          chat_message_role: 'assistant',
          chat_message_content: REPLY,
          chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ])
      await route.abort('connectionreset')
    })
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(tryAgain(page)).toHaveCount(0)
  })

  test('stops offering Try again after a few attempts', async ({ page, signInAs }) => {
    await signInAs('patient', CONVERSATION)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    const counts = watch(page)
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await tryAgain(page).click()
      await expect(page.getByRole('status')).toContainText('not available at the moment')
      await expect(tryAgain(page)).toBeVisible()
    }
    await tryAgain(page).click()
    await expect(page.getByRole('status')).toContainText('still isn’t replying')
    await expect(page.getByRole('status')).toContainText('your care team can still see it')
    await expect(tryAgain(page)).toHaveCount(0)
    expect(counts).toEqual({ replyRequests: 4, messagesSaved: 1 })
  })

  test('after a refresh, keeps the unanswered message and offers to get a reply', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    let fail = true
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      if (fail) {
        await reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' })(route)
        return
      }
      stub.addRows('chat_message', [
        {
          chat_message_id: 'a6666666-6666-4666-8666-666666666666',
          chat_session_id: SESSION,
          chat_message_role: 'assistant',
          chat_message_content: REPLY,
          chat_message_created_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ])
      await success(route)
    })
    const counts = watch(page)
    await page.goto('/patient/chat')
    await send(page)
    await expect(page.getByRole('status')).toContainText('not available at the moment')

    await page.reload()
    await expect(page.getByText(QUESTION)).toBeVisible()
    await expect(page.getByText('Your last message hasn’t had a reply yet.')).toBeVisible()
    // Describes the conversation as found; not announced as news.
    await expect(page.getByRole('status')).toHaveCount(0)

    fail = false
    await page.getByRole('button', { name: 'Get a reply' }).click()
    await expect(page.getByText(REPLY)).toBeVisible()
    await expect(page.getByText('Your last message hasn’t had a reply yet.')).toHaveCount(0)
    expect(counts.messagesSaved).toBe(1)
  })

  test('puts the message back when it could not be saved, and asks for no reply', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', CONVERSATION)
    await page.route(
      (url) => url.pathname.endsWith('/rest/v1/chat_message'),
      async (route) => {
        if (route.request().method() === 'POST') {
          await route.abort('internetdisconnected')
          return
        }
        await route.fallback()
      },
    )
    const counts = watch(page)
    await page.goto('/patient/chat')

    await send(page)
    await expect(page.getByRole('status')).toContainText('wasn’t sent')
    await expect(page.getByLabel(/your message/i)).toHaveValue(QUESTION)
    await expect(tryAgain(page)).toHaveCount(0)
    expect(counts.replyRequests).toBe(0)
  })

  test('from the keyboard, Try again leaves focus in the composer', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', CONVERSATION)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await send(page)
    await expect(tryAgain(page)).toBeVisible()

    await page.keyboard.press('Shift')
    await tryAgain(page).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel(/your message/i)).toBeFocused()
    // Its 44px target.
    await expect(page.getByRole('status')).toContainText('not available')
    const box = await tryAgain(page).boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })
})
