import type { Page, Route } from '@playwright/test'

import { expect, IDS, type SupabaseStub, test } from './support/fixtures'

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

/**
 * The patient's side of the network for saving and reading chat messages,
 * so a test can say what happens to each save: it reaches the database but
 * its answer is lost, it is lost before it gets there, or the server refuses
 * it - and whether reads get through.
 */
async function messageNetwork(page: Page, stub: SupabaseStub) {
  type Fate = 'save-and-lose-answer' | 'lose-before-saving' | 'refuse'
  const net = {
    /** What happens to the next saves, in order; then saves go through. */
    nextSaves: [] as Fate[],
    /** While true, every read of chat_message fails, as if offline. */
    readsFail: false,
    /**
     * While true, reloading the conversation fails, but looking one message
     * up by id does not - to hold the page's background reload back.
     */
    conversationReadsFail: false,
    /** The id each save was sent under, in order. */
    savedIds: [] as string[],
    /** The text each save was sent with, in order. */
    savedTexts: [] as string[],
  }
  await page.route(
    (url) => url.pathname.endsWith('/rest/v1/chat_message'),
    async (route) => {
      const request = route.request()
      if (request.method() === 'POST') {
        const row = JSON.parse(request.postData() ?? '{}')
        net.savedIds.push(row.chat_message_id)
        net.savedTexts.push(row.chat_message_content)
        const fate = net.nextSaves.shift()
        if (fate === 'save-and-lose-answer') {
          stub.addRows('chat_message', [
            { ...row, chat_message_created_at: new Date().toISOString() },
          ])
          await route.abort('timedout')
          return
        }
        if (fate === 'lose-before-saving') {
          await route.abort('timedout')
          return
        }
        if (fate === 'refuse') {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              code: '42501',
              message: 'new row violates row-level security policy',
            }),
          })
          return
        }
      }
      const lookup = new URL(request.url()).searchParams.has('chat_message_id')
      if (
        request.method() === 'GET' &&
        (net.readsFail || (net.conversationReadsFail && !lookup))
      ) {
        await route.abort('internetdisconnected')
        return
      }
      await route.fallback()
    },
  )
  return net
}

/** Messages with this text, as the database holds them. */
function saved(stub: SupabaseStub, text: string) {
  return stub.rowsIn('chat_message').filter((row) => row.chat_message_content === text)
}

/** The conversation has loaded - before a test takes the connection down. */
async function conversationLoaded(page: Page) {
  await expect(page.getByText('No messages in this conversation yet.')).toBeVisible()
}

/** Waits past the client's own retries of a failed read (1 s, 2 s, 4 s). */
const AFTER_RETRIES = { timeout: 15_000 }

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
    // Reads of the conversation that finish after the failure has been sent.
    let readsAfterFailure = 0
    let failed = false
    page.on('requestfinished', (request) => {
      if (failed && request.method() === 'GET' && request.url().includes('/rest/v1/chat_message')) {
        readsAfterFailure += 1
      }
    })
    await page.route('**/functions/v1/chatbot-reply', async (route) => {
      if (first) {
        first = false
        failed = true
        await reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' })(route)
        return
      }
      await reply(400, { error: 'There is nothing to reply to', code: 'already_answered' })(route)
    })
    await page.goto('/patient/chat')

    await send(page)
    await expect(tryAgain(page)).toBeVisible()
    // Let the page's own refresh after the failure finish first - it reads
    // the switch, then the conversation: if it read the reply below, it
    // would show it and rightly drop Try again. (`networkidle` does not wait
    // for it: that state was reached when the page first loaded.)
    await expect.poll(() => readsAfterFailure).toBeGreaterThan(0)
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

  test('puts the message back when its save cannot be confirmed, and asks for no reply', async ({
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
    // The save never answered, so nobody knows whether it landed: the page
    // does not claim it failed.
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', { timeout: 15_000 })
    await expect(page.getByLabel(/your message/i)).toHaveValue(QUESTION)
    await expect(tryAgain(page)).toHaveCount(0)
    expect(counts.replyRequests).toBe(0)
  })

  test('a message saved whose confirmation was lost is not sent twice', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    let commitButLoseAnswer = true
    await page.route(
      (url) => url.pathname.endsWith('/rest/v1/chat_message'),
      async (route) => {
        if (route.request().method() === 'POST' && commitButLoseAnswer) {
          commitButLoseAnswer = false
          // The database saves the message; its answer never reaches the browser.
          const row = JSON.parse(route.request().postData() ?? '{}')
          stub.addRows('chat_message', [
            { ...row, chat_message_created_at: new Date().toISOString() },
          ])
          await route.abort('timedout')
          return
        }
        await route.fallback()
      },
    )
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    const counts = watch(page)
    await page.goto('/patient/chat')

    await send(page)
    // The browser looked, found the message saved, and carried on.
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    await expect(page.getByText('wasn’t sent')).toHaveCount(0)
    await expect(page.getByLabel(/your message/i)).toHaveValue('')
    await expect(page.getByText(QUESTION)).toHaveCount(1)
    expect(stub.rowsIn('chat_message').filter((row) => row.chat_message_content === QUESTION)).toHaveLength(1)
    expect(counts.replyRequests).toBe(1)
  })

  test('sending again after an unconfirmed save does not save the message twice', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    const counts = watch(page)
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    // Saved, but the answer is lost - and the connection is down, so the
    // browser cannot check.
    net.nextSaves.push('save-and-lose-answer')
    net.readsFail = true
    await send(page)
    // Never "wasn't sent": it may have been.
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)
    await expect(page.getByText('wasn’t sent')).toHaveCount(0)
    await expect(page.getByLabel(/your message/i)).toHaveValue(QUESTION)

    // Sending it again reuses the message's id. The database refuses a
    // second copy, and the browser uses the one that was saved. (The
    // conversation's own reload is held back until then: if it got through
    // first it would show the message as sent, which is also right, but is
    // not what this test is about.)
    net.conversationReadsFail = true
    net.readsFail = false
    await page.getByRole('button', { name: /send message/i }).click()
    net.conversationReadsFail = false
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    expect(net.savedIds).toHaveLength(2)
    expect(net.savedIds[0]).toBe(net.savedIds[1])
    expect(saved(stub, QUESTION)).toHaveLength(1)
    await expect(page.getByText(QUESTION)).toHaveCount(1)
    expect(counts.replyRequests).toBe(1)
  })

  test('an edit after an unconfirmed save that did save keeps the original, and says so', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    const counts = watch(page)
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('save-and-lose-answer')
    net.readsFail = true
    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)

    // The patient changes their mind about the wording and sends again.
    net.readsFail = false
    const EDITED = 'Is it normal to feel tired in the afternoons and evenings?'
    await page.getByLabel(/your message/i).fill(EDITED)
    await page.getByRole('button', { name: /send message/i }).click()

    // Same submission, same id: the first version was saved, so the edit is
    // neither saved beside it nor written over it.
    await expect(page.getByRole('status')).toContainText('sent before you changed it')
    expect(net.savedIds).toHaveLength(2)
    expect(net.savedIds[0]).toBe(net.savedIds[1])
    expect(saved(stub, QUESTION)).toHaveLength(1)
    expect(saved(stub, EDITED)).toHaveLength(0)
    // The edit is not lost - it is still in the message box.
    await expect(page.getByLabel(/your message/i)).toHaveValue(EDITED)
    // Nothing was asked of the assistant behind the patient's back...
    expect(counts.replyRequests).toBe(0)
    // ...until they ask.
    await page.getByRole('button', { name: 'Get a reply' }).click()
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    expect(counts.replyRequests).toBe(1)
  })

  test('an edit after an unconfirmed save that never arrived saves the edit, once, under the same id', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('lose-before-saving')
    net.readsFail = true
    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)

    net.readsFail = false
    const EDITED = 'Is it normal to feel tired in the evenings?'
    await page.getByLabel(/your message/i).fill(EDITED)
    await page.getByRole('button', { name: /send message/i }).click()

    await expect(page.getByRole('status')).toContainText('not available at the moment')
    expect(net.savedIds[0]).toBe(net.savedIds[1])
    expect(saved(stub, QUESTION)).toHaveLength(0)
    expect(saved(stub, EDITED)).toHaveLength(1)
    expect(saved(stub, EDITED)[0]!.chat_message_id).toBe(net.savedIds[0])
  })

  test('a save the server refused says it was not sent; it is not left unconfirmed', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    const lookups: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).searchParams.has('chat_message_id')
      ) {
        lookups.push(request.url())
      }
    })
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('refuse')
    await send(page)
    await expect(page.getByRole('status')).toContainText('wasn’t sent')
    await expect(page.getByText('couldn’t confirm')).toHaveCount(0)
    await expect(page.getByLabel(/your message/i)).toHaveValue(QUESTION)
    // A refusal is an answer: there is nothing to look up.
    expect(lookups).toHaveLength(0)
    expect(saved(stub, QUESTION)).toHaveLength(0)
  })

  test('a save confirmed later by the conversation itself is reported as sent', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    const lookups: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).searchParams.has('chat_message_id')
      ) {
        lookups.push(request.url())
      }
    })
    // Only the look-up by id fails; the conversation itself still loads.
    await page.route(
      (url) =>
        url.pathname.endsWith('/rest/v1/chat_message') && url.searchParams.has('chat_message_id'),
      (route) => route.abort('internetdisconnected'),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('save-and-lose-answer')
    await send(page)

    // The reloaded conversation shows the message, so the page says so -
    // and does not leave it in the box to be sent twice.
    await expect(page.getByRole('status')).toContainText('Your message was sent.', AFTER_RETRIES)
    await expect(page.getByLabel(/your message/i)).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Get a reply' })).toBeVisible()
    expect(lookups.length).toBeGreaterThan(0)
    expect(saved(stub, QUESTION)).toHaveLength(1)
  })

  test('after a refresh, an unconfirmed send keeps its id', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    // The save is still on its way when the page is refreshed.
    net.nextSaves.push('lose-before-saving')
    net.readsFail = true
    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)
    const firstId = net.savedIds[0]!

    net.readsFail = false
    await page.reload()
    // The conversation loads without it...
    await conversationLoaded(page)
    // ...and only now does it reach the database, so the patient cannot see it.
    stub.addRows('chat_message', [
      {
        chat_message_id: firstId,
        chat_session_id: SESSION,
        chat_message_role: 'patient',
        chat_message_content: QUESTION,
        chat_message_created_at: new Date().toISOString(),
      },
    ])

    // The patient, not seeing it, writes their question again.
    const AGAIN = 'Is feeling tired in the afternoon normal?'
    await send(page, AGAIN)
    await expect(page.getByRole('status')).toContainText('sent before you changed it')
    expect(net.savedIds.at(-1)).toBe(firstId)
    expect(saved(stub, QUESTION)).toHaveLength(1)
    expect(saved(stub, AGAIN)).toHaveLength(0)
    await expect(page.getByLabel(/your message/i)).toHaveValue(AGAIN)
  })

  test('after a refused save, sending again is a fresh attempt', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('refuse')
    await send(page)
    await expect(page.getByRole('status')).toContainText('wasn’t sent')
    await page.getByRole('button', { name: /send message/i }).click()
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    // The refused id was never used; it is not carried into the next try.
    expect(net.savedIds).toHaveLength(2)
    expect(net.savedIds[1]).not.toBe(net.savedIds[0])
    expect(saved(stub, QUESTION)).toHaveLength(1)
  })

  test('once its earlier version is found, an unrelated new message is sent normally', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('save-and-lose-answer')
    net.readsFail = true
    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)

    // The patient starts editing; the connection comes back and the reloaded
    // conversation shows the original was sent.
    await page.getByLabel(/your message/i).fill('Is it normal to feel tired in the evening?')
    net.readsFail = false
    await expect(page.getByRole('status')).toContainText('sent before you changed it', AFTER_RETRIES)

    // They write something else entirely: a new message, saved as such.
    const NEW_QUESTION = 'When can I start walking further?'
    await page.getByLabel(/your message/i).fill(NEW_QUESTION)
    await page.getByRole('button', { name: /send message/i }).click()
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    expect(saved(stub, NEW_QUESTION)).toHaveLength(1)
    expect(saved(stub, NEW_QUESTION)[0]!.chat_message_id).not.toBe(net.savedIds[0])
    expect(saved(stub, QUESTION)).toHaveLength(1)
  })

  test('a new conversation remembered from before a refresh does not take over the next one', async ({
    page,
    signInAs,
  }) => {
    // No conversations yet.
    const stub = await signInAs('patient')
    let startedButAnswerLost = false
    await page.route(
      (url) => url.pathname.endsWith('/rest/v1/chat_session'),
      async (route) => {
        if (route.request().method() === 'POST' && !startedButAnswerLost) {
          startedButAnswerLost = true
          const row = JSON.parse(route.request().postData() ?? '{}')
          stub.addRows('chat_session', [
            {
              chat_session_external_ref: null,
              chat_session_started_at: '2026-03-01T02:00:00Z',
              chat_session_ended_at: null,
              chat_session_has_critical_flag: false,
              chat_session_summary: null,
              ...row,
            },
          ])
          await route.abort('timedout')
          return
        }
        await route.fallback()
      },
    )
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await send(page)
    await expect(page.getByRole('status').filter({ hasText: 'wasn’t sent' })).toBeVisible()
    const firstSession = stub.rowsIn('chat_session')[0]!.chat_session_id

    await page.reload()
    // Later, the patient starts a new conversation and asks something else.
    await page.getByRole('button', { name: /^start new$/i }).click()
    const LATER = 'Should I keep my wound dry?'
    await send(page, LATER)
    await expect(page.getByRole('status')).toContainText('not available at the moment')

    const [message] = saved(stub, LATER)
    expect(message).toBeDefined()
    // In a conversation of its own, not the one remembered from before.
    expect(message!.chat_session_id).not.toBe(firstSession)
    expect(stub.rowsIn('chat_session')).toHaveLength(2)
  })

  test('pressing Enter repeatedly while re-sending sends it once', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', CONVERSATION)
    const net = await messageNetwork(page, stub)
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')
    await conversationLoaded(page)

    net.nextSaves.push('lose-before-saving')
    net.readsFail = true
    await send(page)
    await expect(page.getByRole('status')).toContainText('couldn’t confirm', AFTER_RETRIES)

    net.readsFail = false
    const composer = page.getByLabel(/your message/i)
    await composer.press('Enter')
    await composer.press('Enter')
    await composer.press('Enter')
    await expect(page.getByRole('status')).toContainText('not available at the moment')
    expect(net.savedIds).toHaveLength(2)
    expect(saved(stub, QUESTION)).toHaveLength(1)
  })

  test('a new conversation whose start was not confirmed is not started twice', async ({
    page,
    signInAs,
  }) => {
    // No conversations yet: the first message starts one.
    const stub = await signInAs('patient')
    const before = stub.rowsIn('chat_session').length
    let commitButLoseAnswer = true
    await page.route(
      (url) => url.pathname.endsWith('/rest/v1/chat_session'),
      async (route) => {
        if (route.request().method() === 'POST' && commitButLoseAnswer) {
          commitButLoseAnswer = false
          const row = JSON.parse(route.request().postData() ?? '{}')
          stub.addRows('chat_session', [
            {
              chat_session_external_ref: null,
              chat_session_started_at: new Date().toISOString(),
              chat_session_ended_at: null,
              chat_session_has_critical_flag: false,
              chat_session_summary: null,
              ...row,
            },
          ])
          await route.abort('timedout')
          return
        }
        await route.fallback()
      },
    )
    await page.route(
      '**/functions/v1/chatbot-reply',
      reply(503, { error: 'The guidance assistant is unavailable.', code: 'unavailable' }),
    )
    await page.goto('/patient/chat')

    await send(page)
    // The conversation was created after all, so the page opens it (its
    // messages load beside the notice) - and the notice comes with it.
    await expect(
      page.getByRole('status').filter({ hasText: 'wasn’t sent' }),
    ).toBeVisible()
    await expect(page.getByLabel(/your message/i)).toHaveValue(QUESTION)
    await page.getByRole('button', { name: /send message/i }).click()
    await expect(page.getByRole('status')).toContainText('not available at the moment')

    expect(stub.rowsIn('chat_session').length).toBe(before + 1)
    expect(stub.rowsIn('chat_message').filter((row) => row.chat_message_content === QUESTION)).toHaveLength(1)
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
