import { expect, IDS, test } from './support/fixtures'

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

test.describe('a save that fails says why it failed', () => {
  /**
   * `ErrorState` describes a query that would not load. Pointed at a
   * mutation it claimed "we could not load this information. Trying again
   * usually helps" — wrong about what happened, wrong that retrying helps,
   * and it dropped the server's explanation entirely, because the technical
   * detail it keeps is rendered only in development.
   */
  test('shows the server reason, not "could not load this information"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/profile')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.route('**/rest/v1/doctor**', async (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'That licence number is already registered to another clinician',
          }),
        })
      }
      return route.fallback()
    })

    await page.getByLabel(/contact number/i).fill('09170000000')
    await page.getByRole('button', { name: /save/i }).first().click()

    await expect(
      page.getByText(/licence number is already registered/i),
    ).toBeVisible()
    await expect(
      page.getByText(/could not load this information/i),
    ).toHaveCount(0)
  })

  test('keeps the written copy for a permission failure', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/profile')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.route('**/rest/v1/doctor**', async (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'new row violates row-level security policy for table "doctor"',
          }),
        })
      }
      return route.fallback()
    })

    await page.getByLabel(/contact number/i).fill('09170000001')
    await page.getByRole('button', { name: /save/i }).first().click()

    // Translated, not the raw policy text.
    await expect(page.getByText(/do not have access to this/i)).toBeVisible()
    await expect(page.getByText(/row-level security policy/i)).toHaveCount(0)
  })
})

test.describe('a failed list does not pretend to be an empty one', () => {
  /**
   * "No upcoming appointments" and "the request failed" mean opposite things
   * to a clinician: one is information about the patient, the other is
   * information about the network. Rendering the first when the second
   * happened is a lie the reader acts on.
   */
  test('a failing appointments query shows an error, not "none"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')

    await page.route('**/rest/v1/appointment**', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'upstream unavailable' }),
          })
        : route.fallback(),
    )

    await page.goto('/doctor/appointments')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await expect(page.getByText(/no upcoming appointments/i)).toHaveCount(0)
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expect(
      page.getByRole('button', { name: /try again/i }).first(),
    ).toBeVisible()
  })

  test('a failing recovery query shows an error, not "no entries yet"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')

    await page.route('**/rest/v1/recovery_log**', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'upstream unavailable' }),
          })
        : route.fallback(),
    )

    await page.goto('/patient/recovery')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await expect(page.getByText(/no entries yet/i)).toHaveCount(0)
    await expect(page.getByRole('alert').first()).toBeVisible()
  })
})

test.describe('account credentials are described truthfully', () => {
  /**
   * Found in live production. The dialog header correctly said a temporary
   * password is handed over, while the email field still promised an
   * invitation that `create-account` stopped sending. The creator was told to
   * wait for a message that never arrives — the same confusion behind the
   * original "wala sa sako gmail" report.
   */
  test('the doctor dialog does not promise an invitation email', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', {
      'rpc/admin_dashboard_stats': [
        {
          patients: { total: 0, active: 0 },
          doctors: { total: 0, active: 0 },
          accounts: {},
          appointments: { upcoming: 0 },
          generated_at: new Date().toISOString(),
        },
      ],
    })
    await page.goto('/admin/doctors')
    await page.getByRole('button', { name: /register a doctor/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/the invitation is sent here/i)).toHaveCount(0)
    await expect(dialog.getByText(/becomes their sign-in address/i)).toBeVisible()
    await expect(dialog.getByText(/no email is sent/i)).toBeVisible()
  })

  test('the patient dialog does not promise an invitation email', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')
    await page.getByRole('button', { name: /register a patient/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/the invitation is sent here/i)).toHaveCount(0)
    await expect(dialog.getByText(/becomes their sign-in address/i)).toBeVisible()
  })
})

test.describe('a lost temporary credential can be reissued', () => {
  /**
   * The creation panel told the creator an administrator could reset the
   * account. No such control existed, and with outbound email unconfigured a
   * lost credential left the account permanently unreachable.
   */
  test('an administrator can reset a doctor and is warned first', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', {
      'rpc/admin_dashboard_stats': [
        {
          patients: { total: 0, active: 0 },
          doctors: { total: 1, active: 1 },
          accounts: {},
          appointments: { upcoming: 0 },
          generated_at: new Date().toISOString(),
        },
      ],
    })

    let sent: Record<string, unknown> | null = null
    await page.goto('/admin/doctors')
    await page.route('**/functions/v1/reset-account-password', async (route) => {
      sent = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ temporaryPassword: 'ACDE-FGHJ-KMNP-QRTU' }),
      })
    })

    await page.getByRole('button', { name: /reset password/i }).first().click()

    const dialog = page.getByRole('dialog')
    // The consequence is stated before the action, not discovered after it.
    await expect(
      dialog.getByText(/current password stops working/i),
    ).toBeVisible()
    await expect(dialog.getByText('ACDE-FGHJ-KMNP-QRTU')).toHaveCount(0)

    await dialog.getByRole('button', { name: /^reset password$/i }).click()

    await expect(dialog.getByText('ACDE-FGHJ-KMNP-QRTU')).toBeVisible()
    await expect(dialog.getByText(/new password issued/i).first()).toBeVisible()
    const captured: Record<string, unknown> = sent ?? {}
    expect(captured).toMatchObject({ kind: 'doctor' })
    expect(captured.doctorId).toBeTruthy()
  })

  test('a server refusal is shown and no credential is invented', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', {
      'rpc/admin_dashboard_stats': [
        {
          patients: { total: 0, active: 0 },
          doctors: { total: 1, active: 1 },
          accounts: {},
          appointments: { upcoming: 0 },
          generated_at: new Date().toISOString(),
        },
      ],
    })
    await page.goto('/admin/doctors')
    await page.route('**/functions/v1/reset-account-password', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Only an administrator can reset a doctor account',
        }),
      }),
    )

    await page.getByRole('button', { name: /reset password/i }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^reset password$/i }).click()

    await expect(
      dialog.getByText(/only an administrator can reset/i),
    ).toBeVisible()
    // No credential panel on failure.
    await expect(dialog.getByText(/new password issued/i)).toHaveCount(0)
  })

  test('a doctor can reissue their own patient’s credential', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')

    let sent: Record<string, unknown> | null = null
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.route('**/functions/v1/reset-account-password', async (route) => {
      sent = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ temporaryPassword: 'WXYZ-2346-79AC-DEFG' }),
      })
    })

    await page.getByRole('button', { name: /reset password/i }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^reset password$/i }).click()

    await expect(dialog.getByText('WXYZ-2346-79AC-DEFG')).toBeVisible()
    // The patient is named by profile id, never by a raw auth user id.
    const capturedPatient: Record<string, unknown> = sent ?? {}
    expect(capturedPatient).toMatchObject({
      kind: 'patient',
      patientId: IDS.alicePat,
    })
  })

  test('the reset control is absent for a patient', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/profile')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await expect(
      page.getByRole('button', { name: /reset password/i }),
    ).toHaveCount(0)
  })
})

test.describe('one action creates one appointment', () => {
  /**
   * Found in live production: two submissions dispatched in the same task
   * both reached `mutate()` and the database ended up with two identical
   * appointments — same patient, same doctor, same instant, both scheduled.
   *
   * `isLoading={create.isPending}` cannot prevent this on its own. React
   * commits the disabled state on a later render, so anything that submits
   * twice before that render passes straight through, and React Query does
   * not deduplicate concurrent `mutate()` calls.
   */
  async function openScheduleDialog(page: import('@playwright/test').Page) {
    await page.goto('/doctor/appointments')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.getByRole('button', { name: /schedule appointment/i }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
  }

  test('two submissions in one task create exactly one appointment', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')

    const posted: string[] = []
    await page.route('**/rest/v1/appointment**', async (route) => {
      if (route.request().method() === 'POST') {
        posted.push(route.request().postData() ?? '')
      }
      await route.fallback()
    })

    await openScheduleDialog(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/patient/i).selectOption({ index: 1 })
    await dialog.getByLabel(/date and time/i).fill('2030-06-01T09:30')

    // Both clicks dispatched before React can commit a disabled state.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) =>
        /^schedule appointment$/i.test((b.textContent || '').trim()),
      )
      const submit = buttons[buttons.length - 1] as HTMLButtonElement
      submit.click()
      submit.click()
    })

    await expect.poll(() => posted.length, { timeout: 5000 }).toBeGreaterThan(0)
    await page.waitForTimeout(1500)

    expect(posted).toHaveLength(1)
  })

  test('a failed submission can still be retried', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')

    let attempt = 0
    await page.route('**/rest/v1/appointment**', async (route) => {
      if (route.request().method() === 'POST') {
        attempt += 1
        if (attempt === 1) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'upstream unavailable' }),
          })
        }
      }
      return route.fallback()
    })

    await openScheduleDialog(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/patient/i).selectOption({ index: 1 })
    await dialog.getByLabel(/date and time/i).fill('2030-06-02T09:30')
    await dialog.getByRole('button', { name: /^schedule appointment$/i }).click()

    // The failure is reported and the guard released, not stuck.
    await expect(dialog.getByText(/was not scheduled/i)).toBeVisible()
    await dialog.getByRole('button', { name: /^schedule appointment$/i }).click()

    await expect.poll(() => attempt, { timeout: 5000 }).toBe(2)
  })
})
