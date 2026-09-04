import { expect, test } from './support/fixtures'

/**
 * Regressions for defects found in the production QA pass.
 *
 * Each test names the reported symptom it covers, so a failure here says
 * which real-world report has come back rather than only which assertion
 * broke.
 */

test.describe('a deployment that lands while a tab is open', () => {
  /**
   * QA items 4 and 7: "Error in Doctor - My Profile" and "Error all here",
   * both of which were `Failed to fetch dynamically imported module` on a
   * chunk whose filename had been replaced by a newer release.
   *
   * The chunk request is aborted to reproduce a file that is no longer on the
   * CDN. Before the fix this reached React Router's own developer screen and
   * showed a stack trace; it must now be a recoverable, plainly worded page.
   */
  test('a missing page chunk offers a reload instead of a stack trace', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // Every page is its own chunk; the profile page is the one QA hit.
    await page.route('**/assets/doctor-profile-page-*.js', (route) =>
      route.abort('failed'),
    )

    await page.getByRole('link', { name: /profile/i }).first().click()

    await expect(
      page.getByRole('heading', { name: /recoverease has been updated/i }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /reload the page/i }),
    ).toBeVisible()

    // The developer screen must not be what a clinician sees.
    await expect(page.getByText(/hey developer/i)).toHaveCount(0)
    await expect(
      page.getByText(/failed to fetch dynamically imported module/i),
    ).toHaveCount(0)
  })

  test('the recovery action is a real reload that restores the page', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    let block = true
    await page.route('**/assets/doctor-profile-page-*.js', (route) => {
      if (block) return route.abort('failed')
      return route.continue()
    })

    await page.getByRole('link', { name: /profile/i }).first().click()
    await expect(
      page.getByRole('heading', { name: /recoverease has been updated/i }),
    ).toBeVisible()

    // The new release is now reachable, exactly as it would be after the
    // browser fetches the current index.html.
    block = false
    await page.getByRole('button', { name: /reload the page/i }).click()

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /recoverease has been updated/i }),
    ).toHaveCount(0)
  })
})

test.describe('a doctor scheduling a follow-up', () => {
  /**
   * QA item 6: "Doctor cant schedule appointments". The API and the hook for
   * module 6.1 both existed; nothing in the clinician's interface called
   * them, so the page could only ever list appointments.
   */
  test('offers scheduling from the appointments page', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/appointments')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.getByRole('button', { name: /schedule appointment/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel(/patient/i)).toBeVisible()
    await expect(dialog.getByLabel(/date and time/i)).toBeVisible()
  })

  test('refuses a past time and a missing patient, and says which', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/appointments')
    await page.getByRole('button', { name: /schedule appointment/i }).click()

    const dialog = page.getByRole('dialog')

    // Nothing chosen at all.
    await dialog
      .getByRole('button', { name: /schedule appointment/i })
      .click()
    await expect(dialog.getByText(/choose which patient/i)).toBeVisible()

    // A patient, but a time that has already been and gone.
    await dialog.getByLabel(/patient/i).selectOption({ index: 1 })
    await dialog.getByLabel(/date and time/i).fill('2020-01-01T09:00')
    await dialog
      .getByRole('button', { name: /schedule appointment/i })
      .click()
    await expect(dialog.getByText(/time in the future/i)).toBeVisible()

    // Still open, nothing booked.
    await expect(dialog).toBeVisible()
  })

  test('sends the assignment from the patient, never a chosen doctor', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/appointments')

    const posted: Record<string, unknown>[] = []
    await page.route('**/rest/v1/appointment**', async (route) => {
      if (route.request().method() === 'POST') {
        posted.push(JSON.parse(route.request().postData() ?? '{}'))
      }
      await route.fallback()
    })

    await page.getByRole('button', { name: /schedule appointment/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/patient/i).selectOption({ index: 1 })
    await dialog.getByLabel(/date and time/i).fill('2030-06-01T09:30')
    await dialog
      .getByRole('button', { name: /schedule appointment/i })
      .click()

    await expect
      .poll(() => posted.length, { timeout: 5000 })
      .toBeGreaterThan(0)

    const body = posted[0] as Record<string, unknown>
    // A doctor id is present and is not taken from anything the form offered.
    expect(body.doc_id).toBeTruthy()
    expect(body.pat_id).toBeTruthy()
    // Stored as an instant, not the typed wall-clock string.
    expect(String(body.appointment_date)).toMatch(/Z$|[+-]\d{2}:\d{2}$/)
  })
})

test.describe('registering a patient is their first consultation', () => {
  /**
   * QA item 3: "after doc register patient - pop up na to mga treatment plan
   * and medication", because the doctor has just seen them face to face.
   *
   * Nothing clinical is created on the way through. The hand-off only takes
   * the clinician to the record, so every value is still entered
   * deliberately and leaving midway loses nothing.
   */
  test('hands the doctor the credential and a way into the care plan', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')

    await page.route('**/functions/v1/create-account', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'new-user-1',
          profileId: 'new-patient-1',
          temporaryPassword: 'ACDE-FGHJ-KMNP-QRTU',
        }),
      }),
    )

    await page.getByRole('button', { name: /register a patient/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/first name/i).fill('Dana')
    await dialog.getByLabel(/last name/i).fill('Cruz')
    await dialog.getByLabel(/email address/i).fill('dana@example.test')
    await dialog.getByRole('button', { name: /register patient/i }).click()

    // The credential is shown once, with who it belongs to.
    await expect(dialog.getByText('ACDE-FGHJ-KMNP-QRTU')).toBeVisible()
    await expect(dialog.getByText(/temporary password for dana cruz/i)).toBeVisible()
    await expect(dialog.getByText(/first consultation/i)).toBeVisible()

    await dialog.getByRole('button', { name: /set up care plan/i }).click()

    // Straight to that patient's treatment tab.
    await expect(page).toHaveURL(/\/doctor\/patients\/new-patient-1\?tab=treatment/)
  })

  test('a failed registration says why, and does not block the next attempt', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')

    let attempt = 0
    await page.route('**/functions/v1/create-account', (route) => {
      attempt += 1
      if (attempt === 1) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'An account already exists for that email address',
          }),
        })
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'new-user-2',
          profileId: 'new-patient-2',
          temporaryPassword: 'WXYZ-2346-79AC-DEFG',
        }),
      })
    })

    await page.getByRole('button', { name: /register a patient/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/first name/i).fill('Dana')
    await dialog.getByLabel(/last name/i).fill('Cruz')
    await dialog.getByLabel(/email address/i).fill('taken@example.test')
    await dialog.getByRole('button', { name: /register patient/i }).click()

    // The reason, not "we could not load this information".
    await expect(
      dialog.getByText(/an account already exists for that email address/i),
    ).toBeVisible()

    // QA item 2: the next registration must not inherit that failure.
    await dialog.getByLabel(/email address/i).fill('fresh@example.test')
    await dialog.getByRole('button', { name: /register patient/i }).click()

    await expect(dialog.getByText('WXYZ-2346-79AC-DEFG')).toBeVisible()
    await expect(
      dialog.getByText(/an account already exists/i),
    ).toHaveCount(0)
  })
})
