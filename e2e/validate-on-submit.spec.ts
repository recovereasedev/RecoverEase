import type { Locator, Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Forms that check themselves when they are submitted (M7).
 *
 * Their submit buttons used to stay disabled until the form was complete: a
 * greyed button a keyboard cannot reach and that never says what it is
 * waiting for. They are now always pressable. Pressed too early, each says
 * what is missing beside the field, takes focus to the first such field, and
 * sends nothing. Chat Send and a setting's Save, which have nothing to do
 * rather than something missing, are not among them.
 */

/** Activates a control the way a keyboard user does. */
async function pressWithKeyboard(page: Page, control: Locator) {
  await page.keyboard.press('Shift')
  await control.focus()
  await expect(control).toBeFocused()
  await page.keyboard.press('Enter')
}

/** Every request that could change data, to show that none was sent. */
function watchForWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const isData = url.includes('/rest/v1/') || url.includes('/functions/v1/')
    const isRead = request.method() === 'GET' || request.method() === 'HEAD'
    if (isData && !isRead) writes.push(`${request.method()} ${url}`)
  })
  return writes
}

test.describe('forms that check themselves when submitted', () => {
  test('Book appointment says a time is needed', async ({ page, signInAs }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: /book a follow-up/i }).first().click()
    const dialog = page.getByRole('dialog')
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, dialog.getByRole('button', { name: /^book appointment$/i }))

    await expect(dialog.getByText('Choose a date and time.')).toBeVisible()
    await expect(dialog.getByLabel(/date and time/i)).toBeFocused()
    expect(writes).toEqual([])
  })

  test('Send request says a new time is needed', async ({ page, signInAs }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: /request new time/i }).first().click()
    const dialog = page.getByRole('dialog')
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, dialog.getByRole('button', { name: /^send request$/i }))

    await expect(dialog.getByText('Choose a date and time.')).toBeVisible()
    await expect(dialog.getByLabel(/preferred new date and time/i)).toBeFocused()
    expect(writes).toEqual([])
  })

  for (const button of ['Save as draft', 'Publish now']) {
    test(`${button} says a title and message are needed`, async ({ page, signInAs }) => {
      await signInAs('admin')
      await page.goto('/admin/announcements')
      await page.getByRole('button', { name: /new announcement/i }).first().click()
      const dialog = page.getByRole('dialog')
      const writes = watchForWrites(page)

      await pressWithKeyboard(page, dialog.getByRole('button', { name: button, exact: true }))

      await expect(dialog.getByText('Give the announcement a title.')).toBeVisible()
      await expect(dialog.getByText('Write the message.')).toBeVisible()
      await expect(dialog.getByLabel('Title')).toBeFocused()
      expect(writes).toEqual([])
    })
  }

  test('Register patient says which details are missing', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')
    await page.getByRole('button', { name: /register a patient/i }).click()
    const dialog = page.getByRole('dialog')
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, dialog.getByRole('button', { name: /^register patient$/i }))

    await expect(dialog.getByText('Enter their first name.')).toBeVisible()
    await expect(dialog.getByText('Enter their last name.')).toBeVisible()
    await expect(dialog.getByText('Enter the email address they will sign in with.')).toBeVisible()
    await expect(dialog.getByLabel('First name')).toBeFocused()
    expect(writes).toEqual([])
  })

  test('Register doctor goes to the first detail still missing', async ({ page, signInAs }) => {
    await signInAs('admin')
    await page.goto('/admin/doctors')
    await page.getByRole('button', { name: /register a doctor/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('First name').fill('Bea')
    await dialog.getByLabel('Last name').fill('Santos')
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, dialog.getByRole('button', { name: /^register doctor$/i }))

    await expect(dialog.getByText('Enter the email address they will sign in with.')).toBeVisible()
    await expect(dialog.getByText('Enter their licence number.')).toBeVisible()
    await expect(dialog.getByText('Enter their first name.')).toHaveCount(0)
    await expect(dialog.getByLabel(/email address/i)).toBeFocused()
    expect(writes).toEqual([])
  })

  test('Send notification says a message is needed', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, page.getByRole('button', { name: /send notification/i }))

    await expect(page.getByText('Write the message.')).toBeVisible()
    await expect(page.getByLabel('Message')).toBeFocused()
    expect(writes).toEqual([])
  })

  test('Save note says a note is needed', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=notes`)
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, page.getByRole('button', { name: /save note/i }))

    await expect(page.getByText('Write the note.')).toBeVisible()
    await expect(page.getByLabel('Note', { exact: true })).toBeFocused()
    expect(writes).toEqual([])
  })

  test('Generate report says a patient is needed', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto('/doctor/reports')
    const writes = watchForWrites(page)

    await pressWithKeyboard(page, page.getByRole('button', { name: /generate report/i }))

    await expect(page.getByText('Choose which patient this report is for.')).toBeVisible()
    await expect(page.getByRole('combobox', { name: /patient/i })).toBeFocused()
    expect(writes).toEqual([])
  })
})
