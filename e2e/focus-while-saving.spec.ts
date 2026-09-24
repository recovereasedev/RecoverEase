import type { Locator, Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Keyboard focus through a save.
 *
 * A saving button used to be natively disabled, and the browser takes focus
 * off a disabled element: a keyboard user pressed Save and found themselves
 * back at the top of the page. `Button` now stays focusable while it works,
 * and where the control goes away once it has worked, `useFocusRecovery` or
 * the dialog itself moves focus to the next sensible place.
 */

/** Activates a control the way a keyboard user does. */
async function pressWithKeyboard(page: Page, control: Locator) {
  await page.keyboard.press('Shift')
  await control.focus()
  await page.keyboard.press('Enter')
}

test.describe('keyboard focus through a save', () => {
  test('a Save that stays on screen keeps focus while saving, and sends once', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    let writes = 0
    await page.route('**/rest/v1/patient**', async (route) => {
      if (route.request().method() === 'PATCH') {
        writes += 1
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
      await route.fallback()
    })

    await page.goto('/patient/profile')
    await page.getByLabel('Address').fill('Cebu City')
    const save = page.getByRole('button', { name: /save changes/i })
    await pressWithKeyboard(page, save)

    await expect(save).toHaveAttribute('aria-busy', 'true')
    await expect(save).toBeFocused()
    // A second press while the first is still saving sends nothing.
    await page.keyboard.press('Enter')

    await expect(
      page.getByRole('status').filter({ hasText: 'Your details have been saved.' }),
    ).toBeVisible()
    await expect(save).toBeFocused()
    expect(writes).toBe(1)
  })

  test('Confirm hands focus to the next action on the appointment', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')

    await pressWithKeyboard(page, page.getByRole('button', { name: /^confirm$/i }))

    await expect(
      page.getByRole('button', { name: 'Request new time' }).first(),
    ).toBeFocused()
  })

  test('Send notification hands focus back to the emptied message box', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    const message = page.getByLabel('Message')
    await message.fill('Please bring your medication list.')

    await pressWithKeyboard(
      page,
      page.getByRole('button', { name: /send notification/i }),
    )

    await expect(page.getByRole('status').filter({ hasText: /^Sent to/ })).toBeVisible()
    await expect(message).toBeFocused()
  })

  test('a new account’s password takes focus, not the button that replaced Register', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.route('**/functions/v1/create-account', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          temporaryPassword: 'lantern-maple-orbit-42',
          profileId: IDS.bobPat,
          userId: IDS.bobUser,
        }),
      }),
    )
    await page.goto('/doctor/patients')
    await pressWithKeyboard(page, page.getByRole('button', { name: /register a patient/i }))
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('First name').fill('Dana')
    await dialog.getByLabel('Last name').fill('Cruz')
    await dialog.getByLabel(/email address/i).fill('dana@recoverease.test')

    await pressWithKeyboard(page, dialog.getByRole('button', { name: /^register patient$/i }))

    await expect(dialog.getByText('lantern-maple-orbit-42')).toBeVisible()
    // "Set up care plan" closes the dialog, and the password is shown once.
    await expect(dialog.getByRole('button', { name: 'Copy' })).toBeFocused()
  })

  test('Mark all as read, with nothing left to press, leaves focus on the main content', async ({
    page,
    signInAs,
  }) => {
    const unread = (id: string, message: string) => ({
      notification_id: id,
      user_id: IDS.aliceUser,
      chat_session_id: null,
      notification_type: 'general',
      notification_message: message,
      notification_is_read: false,
      notification_created_at: new Date().toISOString(),
      chat_session: null,
    })
    await signInAs('patient', {
      notification: [
        unread('n1111111-1111-4111-8111-111111111111', 'Bring your medication list.'),
        unread('n2222222-2222-4222-8222-222222222222', 'Your appointment is on Thursday.'),
      ],
    })
    await page.goto('/patient/notifications')

    await pressWithKeyboard(page, page.getByRole('button', { name: /mark all as read/i }))

    await expect(page.getByRole('button', { name: /mark all as read/i })).toHaveCount(0)
    await expect(page.locator('#main-content')).toBeFocused()
  })
})
