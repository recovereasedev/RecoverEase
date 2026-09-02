import { datasetFor, expect, IDS, SupabaseStub, test } from './support/fixtures'

/**
 * Authentication and role routing.
 *
 * These run in a real browser against the production build, so they cover the
 * lazy route chunks, the guards and the session wiring — the parts a jsdom
 * test cannot reach.
 */

test.describe('public pages', () => {
  test('the landing page states there is no public sign-up', async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByRole('heading', { level: 1, name: /Recovery, followed properly/i }),
    ).toBeVisible()

    // The single most consequential fact about this system, and the reason
    // there is no sign-up route to link to.
    await expect(page.getByText(/no public sign-up/i).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /sign up/i })).toHaveCount(0)
  })

  test('an unknown path shows the not-found page', async ({ page }) => {
    await page.goto('/no-such-page')

    await expect(
      page.getByRole('heading', { name: /page not found/i }),
    ).toBeVisible()
  })
})

test.describe('sign in', () => {
  test('rejects empty input with errors beside each field', async ({ page }) => {
    const stub = new SupabaseStub(datasetFor('patient'))
    await stub.install(page)

    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page.getByText('Enter your email address')).toBeVisible()
    await expect(page.getByText('Enter your password')).toBeVisible()

    // Errors must be wired to their field, not floating in a summary.
    await expect(page.getByLabel('Email address')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })

  test('does not reveal whether an account exists', async ({ page }) => {
    const stub = new SupabaseStub(datasetFor('patient'))
    await stub.install(page)

    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill('nobody@example.test')
    await page.getByLabel('Password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    const message = page.getByRole('alert')
    await expect(message).toBeVisible()

    // A message that distinguishes "no such account" from "wrong password"
    // lets an attacker enumerate who is registered.
    await expect(message).toContainText(/do not match an account/i)
    await expect(message).not.toContainText(/not found/i)
    await expect(message).not.toContainText(/no account/i)
  })

  test('signs a patient in and lands them on their own dashboard', async ({
    page,
  }) => {
    const stub = new SupabaseStub(datasetFor('patient'))
    await stub.install(page)

    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill('alice@recoverease.test')
    await page.getByLabel('Password').fill('correct-horse-battery')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page).toHaveURL(/\/patient$/)
    await expect(
      page.getByRole('heading', { level: 1, name: /Alice/ }),
    ).toBeVisible()
  })

  test('lets the password be revealed', async ({ page }) => {
    const stub = new SupabaseStub(datasetFor('patient'))
    await stub.install(page)

    await page.goto('/sign-in')
    const password = page.getByLabel('Password')
    await expect(password).toHaveAttribute('type', 'password')

    await page.getByRole('button', { name: /show password/i }).click()
    await expect(password).toHaveAttribute('type', 'text')
  })
})

test.describe('route guards', () => {
  for (const path of [
    '/patient',
    '/patient/medications',
    '/doctor/patients',
    '/admin/audit',
  ]) {
    test(`sends a signed-out visitor from ${path} to sign in`, async ({
      page,
    }) => {
      const stub = new SupabaseStub(datasetFor('patient'))
      await stub.install(page)

      await page.goto(path)

      await expect(page).toHaveURL(/\/sign-in$/)
      await expect(
        page.getByRole('heading', { name: /sign in to recoverease/i }),
      ).toBeVisible()
    })
  }

  test('sends a patient who reaches an admin route back to their own area', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/admin/audit')

    // A navigation mistake, not a security event — and the database would
    // refuse the rows regardless.
    await expect(page).toHaveURL(/\/patient$/)
    await expect(page.getByText(/audit log/i)).toHaveCount(0)
  })

  test('sends a doctor who reaches a patient route back to their own area', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/patient/medications')

    await expect(page).toHaveURL(/\/doctor$/)
  })

  test('sends a signed-in user away from the landing page', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/')

    await expect(page).toHaveURL(/\/doctor$/)
  })
})

test.describe('session lifecycle', () => {
  test('survives a reload without bouncing to sign in', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/treatment')
    await expect(
      page.getByRole('heading', { level: 1, name: /treatment plan/i }),
    ).toBeVisible()

    await page.reload()

    // The guard must wait while the session resolves. Redirecting on
    // `loading` would log the user out on every hard refresh.
    await expect(page).toHaveURL(/\/patient\/treatment$/)
    await expect(
      page.getByRole('heading', { level: 1, name: /treatment plan/i }),
    ).toBeVisible()
  })

  test('signing out locks the app again', async ({ page }) => {
    // Signed in through the form rather than a seeded session. The seeding
    // helper installs an init script that runs on every navigation, which
    // would silently restore the session the moment this test navigated
    // again — and the test would then be asserting nothing.
    const stub = new SupabaseStub(datasetFor('patient'))
    await stub.install(page)

    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill('alice@recoverease.test')
    await page.getByLabel('Password').fill('correct-horse-battery')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/patient$/)

    // Two sign-out controls exist — the sidebar and the mobile header — and
    // only one is visible at a given width. `.first()` is the sidebar, which
    // is the one shown at desktop size.
    await page.getByRole('button', { name: 'Sign out' }).first().click()

    // The guard fires the moment the session clears, so the user lands on
    // sign-in rather than the marketing page — they were on a protected
    // route, and it is immediately protected again.
    await expect(page).toHaveURL(/\/sign-in$/)

    // And it stays closed, rather than merely having been navigated away from.
    await page.goto('/patient')
    await expect(page).toHaveURL(/\/sign-in$/)
  })
})

test.describe('data privacy consent (module 1.5)', () => {
  test('blocks a patient who has not consented, including on a deep link', async ({
    page,
  }) => {
    const data = datasetFor('patient')
    data['patient'] = [
      { ...data['patient']![0]!, pat_consent_at: null },
    ]

    const stub = new SupabaseStub(data)
    await stub.install(page)
    await stub.signInAs(page, {
      userId: IDS.aliceUser,
      email: 'alice@recoverease.test',
    })

    // Straight to a clinical screen, not the dashboard. The gate wraps every
    // patient route, so a deep link cannot step over it.
    await page.goto('/patient/medications')

    await expect(
      page.getByRole('heading', { name: /before you continue/i }),
    ).toBeVisible()
    await expect(page.getByText(/Due today/i)).toHaveCount(0)

    // There is no "decline and continue": consent is given, or the account
    // is not used.
    await expect(
      page.getByRole('button', { name: /i understand and agree/i }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /not now, sign me out/i }),
    ).toBeVisible()
  })

  test('lets the patient through once consent is recorded', async ({ page }) => {
    const data = datasetFor('patient')
    data['patient'] = [{ ...data['patient']![0]!, pat_consent_at: null }]

    const stub = new SupabaseStub(data)
    await stub.install(page)
    await stub.signInAs(page, {
      userId: IDS.aliceUser,
      email: 'alice@recoverease.test',
    })

    await page.goto('/patient')
    await page.getByRole('button', { name: /i understand and agree/i }).click()

    await expect(
      page.getByRole('heading', { level: 1, name: /Alice/ }),
    ).toBeVisible()
  })
})
