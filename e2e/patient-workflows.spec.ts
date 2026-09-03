import { expect, test } from './support/fixtures'

/**
 * The three things a patient actually does: record how the day went, mark a
 * dose, and manage an appointment.
 */

test.describe('recovery log (modules 5.9, 5.10)', () => {
  test('records today and the entry appears in the journal', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/recovery')

    await expect(
      page.getByRole('heading', { level: 1, name: /my recovery/i }),
    ).toBeVisible()

    // The radio input is visually hidden and the label is the click target,
    // which is exactly how a person uses it. `exact` matters: "Very good" also
    // contains "Good".
    await page.getByText('Good', { exact: true }).click()
    await expect(page.getByRole('radio', { name: /^Good$/ })).toBeChecked()
    await page
      .getByLabel(/how was today/i)
      .fill('Managed the stairs without stopping.')

    await page.getByRole('button', { name: /save entry/i }).click()

    await expect(page.getByRole('status')).toContainText(/saved/i)

    // Scoped to the journal list: the textarea still holds the same text, and
    // an unscoped match would pass without the entry ever being saved.
    await expect(
      page
        .locator('li')
        .filter({ hasText: 'Managed the stairs without stopping.' }),
    ).toBeVisible()
  })

  test('shows an empty journal honestly before anything is logged', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/recovery')

    // "No entries yet" must only appear once loading has finished, never as a
    // placeholder over an in-flight request.
    await expect(page.getByText(/no entries yet/i)).toBeVisible()
  })
})

test.describe('medication (modules 4.5, 4.6)', () => {
  test('marks a dose as taken and reflects it immediately', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/medications')

    await expect(
      page.getByRole('heading', { level: 1, name: /medication/i }),
    ).toBeVisible()
    await expect(page.getByText('Paracetamol').first()).toBeVisible()

    await page.getByRole('button', { name: 'Taken', exact: true }).first().click()

    // The status badge carries a word, not only a colour.
    await expect(page.getByText('Taken').first()).toBeVisible()
  })

  test('shows the prescription with its schedule', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/medications')

    await expect(page.getByText(/500mg/).first()).toBeVisible()
    await expect(page.getByText(/08:00, 20:00/)).toBeVisible()
    await expect(page.getByText('Take with food.')).toBeVisible()
  })
})

test.describe('appointments (modules 6.1, 6.5, 6.6)', () => {
  test('confirms attendance on an upcoming appointment', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')

    await expect(page.getByText('Scheduled').first()).toBeVisible()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()

    await expect(page.getByText('Confirmed').first()).toBeVisible()
  })

  test('books a follow-up through the dialog', async ({ page, signInAs }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')

    await page.getByRole('button', { name: /book a follow-up/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // No doctor picker: module 6.1 books with the patient's own clinician,
    // and a database trigger refuses anything else.
    await expect(dialog.getByLabel(/doctor/i)).toHaveCount(0)

    const when = new Date()
    when.setDate(when.getDate() + 14)
    await dialog
      .getByLabel(/date and time/i)
      .fill(when.toISOString().slice(0, 16))

    await dialog.getByRole('button', { name: /book appointment/i }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('requests a reschedule rather than editing the time directly', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')

    await page.getByRole('button', { name: /request new time/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/approve or decline/i)).toBeVisible()

    const when = new Date()
    when.setDate(when.getDate() + 21)
    await dialog
      .getByLabel(/preferred new date and time/i)
      .fill(when.toISOString().slice(0, 16))
    await dialog.getByLabel(/reason/i).fill('Work commitment that morning.')

    await dialog.getByRole('button', { name: /send request/i }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('closes the booking dialog on Escape', async ({ page, signInAs }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')

    await page.getByRole('button', { name: /book a follow-up/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Native <dialog> gives this for free; a hand-rolled modal usually does
    // not, which is why it is worth asserting.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })
})

test.describe('treatment plan (modules 3.4, 5.8)', () => {
  test('shows the plan and its goals', async ({ page, signInAs }) => {
    await signInAs('patient')
    await page.goto('/patient/treatment')

    await expect(page.getByText('Post-operative knee recovery')).toBeVisible()
    await expect(page.getByText('Walk 500 metres unaided')).toBeVisible()
    await expect(page.getByText('In progress')).toBeVisible()
  })
})

test.describe('guidance chat (module 8)', () => {
  test('says the assistant is unavailable rather than inventing a reply', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/chat')

    // Stated before the conversation, not buried under it.
    await expect(page.getByText(/does not diagnose conditions/i)).toBeVisible()

    await page
      .getByLabel(/your message/i)
      .fill('Is swelling normal after two weeks?')
    await page.getByRole('button', { name: /send message/i }).click()

    // The Edge Function is not configured in this run, which is a supported
    // production state. The patient's message is kept and the failure is
    // stated; nothing is fabricated.
    await expect(page.getByRole('status')).toContainText(/not available/i)
    await expect(
      page.getByText('Is swelling normal after two weeks?'),
    ).toBeVisible()
  })

  test('clears the unavailable state when the assistant does answer', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')

    // This overrides the default stub route, which answers 503. It returns
    // the shape `chatbot-reply` produces after it has validated a Gemini
    // response against the Zod schema — it is not a claim that Gemini itself
    // was reached. What is under test here is the UI's handling of a
    // well-formed success, which is otherwise unreachable until a key exists.
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

    await page.goto('/patient/chat')
    await page.getByLabel(/your message/i).fill('Is swelling normal?')
    await page.getByRole('button', { name: /send message/i }).click()

    await expect(page.getByText('Is swelling normal?')).toBeVisible()
    // The failure banner must not appear on a successful reply.
    await expect(page.getByRole('status')).toHaveCount(0)
  })

  test('says so when the assistant answers in a shape we refuse to trust', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')

    // 502 is what `chatbot-reply` returns when Gemini answered but the output
    // failed Zod validation. The patient must see an honest failure, never a
    // partially-parsed reply.
    await page.route('**/functions/v1/chatbot-reply', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'The guidance assistant could not produce a usable reply.',
        }),
      }),
    )

    await page.goto('/patient/chat')
    await page.getByLabel(/your message/i).fill('Should I change my dose?')
    await page.getByRole('button', { name: /send message/i }).click()

    await expect(page.getByRole('status')).toContainText(/not available/i)
    // The patient's own message survives the failure.
    await expect(page.getByText('Should I change my dose?')).toBeVisible()
  })
})
