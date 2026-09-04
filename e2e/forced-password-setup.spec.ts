import type { Page } from '@playwright/test'

import { expect, IDS, test, type SupabaseStub } from './support/fixtures'

/**
 * The forced first-login password change for accounts created with a
 * temporary credential.
 *
 * The requirement lives in Supabase Auth's `app_metadata`, which only the
 * service-role key can write, so these tests drive it through the session the
 * stub serves rather than through anything the page can set.
 */

/**
 * Makes `complete-password-setup` succeed, and clears the flag afterwards.
 *
 * Must be called *after* `signInAs`: the stub registers a catch-all for
 * `**\/functions/v1/**` while installing, and Playwright gives precedence to
 * the handler registered last.
 */
async function acceptPasswordChange(
  page: Page,
  stub: SupabaseStub,
  account: { userId: string; email: string },
): Promise<() => number> {
  let calls = 0

  await page.route('**/functions/v1/complete-password-setup', async (route) => {
    calls += 1

    // Auth now holds a cleared requirement, so the next token minted for this
    // account carries it. The app only sees that if it actually refreshes.
    stub.setSession({ ...account, mustChangePassword: false })

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  return () => calls
}

const DOCTOR_ACCOUNT = {
  userId: IDS.doctorAUser,
  email: 'doctor.a@recoverease.test',
}

const GATE_HEADING = /choose your password/i

test.describe('an account still holding its temporary password', () => {
  test('is stopped at the password screen instead of the dashboard', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', undefined, { mustChangePassword: true })
    await page.goto('/doctor')

    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
    // None of the application is rendered behind it.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  })

  test('cannot be bypassed by a deep link, a refresh, or the back button', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', undefined, { mustChangePassword: true })

    // A deep link straight past the dashboard.
    await page.goto('/doctor/patients')
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    // A reload on that deep link.
    await page.reload()
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    // Another protected route, then back.
    await page.goto('/doctor/appointments')
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
  })

  test('applies to patients as well as doctors', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', undefined, { mustChangePassword: true })
    await page.goto('/patient')

    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
    // The privacy notice must not be answered by someone holding a credential
    // that has not yet been proved to be in the right hands.
    await expect(page.getByText(/before you continue/i)).toHaveCount(0)
  })

  test('does not become a way into another role', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', undefined, { mustChangePassword: true })

    await page.goto('/admin')
    await expect(page).toHaveURL(/\/doctor$/)
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    await page.goto('/patient/medications')
    await expect(page).toHaveURL(/\/doctor$/)
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
  })
})

test.describe('completing the password change', () => {
  test('validates before it will submit anything', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('doctor', undefined, {
      mustChangePassword: true,
    })
    const callCount = await acceptPasswordChange(page, stub, DOCTOR_ACCOUNT)
    await page.goto('/doctor')
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    // Too short.
    await page.getByLabel(/^new password/i).fill('short')
    await page.getByLabel(/confirm new password/i).fill('short')
    await page.getByRole('button', { name: /save and continue/i }).click()
    await expect(page.getByText(/at least 12 characters/i).first()).toBeVisible()

    // Long enough, but the two do not match.
    await page.getByLabel(/^new password/i).fill('a-long-enough-passphrase')
    await page.getByLabel(/confirm new password/i).fill('a-different-passphrase')
    await page.getByRole('button', { name: /save and continue/i }).click()
    await expect(page.getByText(/do not match/i)).toBeVisible()

    // Nothing was sent for either attempt.
    expect(callCount()).toBe(0)
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
  })

  test('lets the account into the application and does not ask again', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('doctor', undefined, {
      mustChangePassword: true,
    })
    const callCount = await acceptPasswordChange(page, stub, DOCTOR_ACCOUNT)
    await page.goto('/doctor')
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    await page.getByLabel(/^new password/i).fill('a-long-enough-passphrase')
    await page.getByLabel(/confirm new password/i).fill('a-long-enough-passphrase')
    await page.getByRole('button', { name: /save and continue/i }).click()

    // The doctor's own dashboard, not the gate.
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toHaveCount(0)
    expect(callCount()).toBe(1)

    // A reload does not put the requirement back. The seeded session has to
    // be re-stated first: `signInAs` installs it with `addInitScript`, which
    // runs again on every navigation and would otherwise restore the
    // pre-change state that Auth no longer holds.
    await stub.signInAs(page, { ...DOCTOR_ACCOUNT, mustChangePassword: false })
    await page.reload()
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toHaveCount(0)
  })

  test('surfaces a server refusal without letting the account through', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', undefined, { mustChangePassword: true })

    await page.route('**/functions/v1/complete-password-setup', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'This account has already completed its password setup',
        }),
      }),
    )

    await page.goto('/doctor')
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()

    await page.getByLabel(/^new password/i).fill('a-long-enough-passphrase')
    await page.getByLabel(/confirm new password/i).fill('a-long-enough-passphrase')
    await page.getByRole('button', { name: /save and continue/i }).click()

    await expect(page.getByRole('alert').first()).toContainText(
      /already completed its password setup/i,
    )
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toBeVisible()
  })

  test('an account that has already completed setup is never asked', async ({
    page,
    signInAs,
  }) => {
    // Same role, same fixtures, only the flag differs — so a test that passed
    // above cannot be passing because the gate is simply always on.
    await signInAs('doctor')
    await page.goto('/doctor')

    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: GATE_HEADING })).toHaveCount(0)
  })
})
