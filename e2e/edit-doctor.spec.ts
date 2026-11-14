import { expect, IDS, test } from './support/fixtures'

/**
 * Module 11.2 "Update Doctor Account" in the browser: a Clinic Admin corrects
 * a doctor's details from Doctor accounts.
 *
 * The stub answers as the database would after its own checks, which are
 * covered against the database itself (tests/db/clinic-admin-updates-doctor.test.ts).
 * What is proven here is the screen's side: the request it sends, what the
 * list shows afterwards, and where keyboard focus goes.
 */

test.describe('editing a doctor account', () => {
  test('sends only what changed for that doctor, then shows it and returns focus', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.goto('/admin/doctors')

    const opener = page.getByRole('button', { name: 'Edit Dr Alan Cruz' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Edit doctor account' })
    await expect(dialog.getByRole('textbox', { name: /^First name/ })).toHaveValue('Alan')
    await expect(dialog.getByRole('textbox', { name: /^Licence number/ })).toHaveValue('LIC-A-001')

    await dialog.getByRole('textbox', { name: /^Last name/ }).fill('Cruz-Santos')
    await dialog.getByRole('textbox', { name: /^Contact number/ }).fill('0917 222 3333')

    const sent = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().includes('/rest/v1/doctor'),
    )
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    const request = await sent

    expect(new URL(request.url()).searchParams.get('doc_id')).toBe(`eq.${IDS.doctorA}`)
    expect(request.postDataJSON()).toEqual({
      doc_last_name: 'Cruz-Santos',
      doc_contact_no: '0917 222 3333',
    })

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'updated' })).toHaveText(
      'The details for Dr Alan Cruz-Santos were updated.',
    )
    const renamed = page.getByRole('button', { name: 'Edit Dr Alan Cruz-Santos' })
    await expect(renamed).toBeVisible()
    await expect(renamed).toBeFocused()
  })

  test('saves with Enter and closes with Escape, from the keyboard', async ({ page, signInAs }) => {
    await signInAs('admin')
    await page.goto('/admin/doctors')

    const opener = page.getByRole('button', { name: 'Edit Dr Bea Lim' })
    await opener.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Edit doctor account' })
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()

    await page.keyboard.press('Enter')
    const specialisation = dialog.getByRole('textbox', { name: /^Specialisation/ })
    await specialisation.fill('Hand therapy')
    const sent = page.waitForRequest((request) => request.method() === 'PATCH')
    await specialisation.press('Enter')
    expect((await sent).postDataJSON()).toEqual({ doc_specialization: 'Hand therapy' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('says what is missing beside the field, with focus there, and sends nothing', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    let patches = 0
    page.on('request', (request) => {
      if (request.method() === 'PATCH') patches += 1
    })
    await page.goto('/admin/doctors')
    await page.getByRole('button', { name: 'Edit Dr Alan Cruz' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit doctor account' })
    const licence = dialog.getByRole('textbox', { name: /^Licence number/ })
    await licence.fill('   ')
    await dialog.getByRole('button', { name: 'Save changes' }).click()

    await expect(dialog.getByText('Enter their licence number.')).toBeVisible()
    await expect(licence).toBeFocused()
    await expect(licence).toHaveAttribute('aria-invalid', 'true')
    expect(patches).toBe(0)
  })

  test('says a taken licence number beside its field, in plain words', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.route('**/rest/v1/doctor**', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: '23505',
          message: 'duplicate key value violates unique constraint "doctor_license_no_key"',
          details: 'Key (doc_license_no)=(LIC-B-002) already exists.',
          hint: null,
        }),
      })
    })
    await page.goto('/admin/doctors')
    await page.getByRole('button', { name: 'Edit Dr Alan Cruz' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit doctor account' })
    const licence = dialog.getByRole('textbox', { name: /^Licence number/ })
    await licence.fill('LIC-B-002')
    await dialog.getByRole('button', { name: 'Save changes' }).click()

    await expect(dialog.getByText('Another doctor already has this licence number.')).toBeVisible()
    await expect(licence).toBeFocused()
    await expect(licence).toHaveValue('LIC-B-002')
    await expect(dialog).not.toContainText('duplicate key')
  })
})
