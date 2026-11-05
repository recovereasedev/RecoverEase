import { expect, IDS, STUB_TOTP_CODE, test } from './support/fixtures'

/**
 * The Super Admin's console and its authenticator step, in a real browser
 * against the production build.
 *
 * The stub plays Supabase Auth's MFA endpoints and answers
 * `super_admin_assured()` from the session it holds. What it cannot show is
 * the database refusing a session it does not accept; that is
 * tests/db/super-admin.test.ts, against the real migrations. What this
 * shows is the website asking for the code before anything of the console
 * appears - including on a deep link - and the console's own flows.
 */

const ENROL_HEADING = 'Set up your authenticator app'
const CODE_HEADING = 'Enter your authenticator code'

function consoleCalls(requests: readonly string[]): string[] {
  return requests.filter(
    (request) =>
      request.includes('rpc/super_admin_') && !request.endsWith('rpc/super_admin_assured'),
  )
}

test.describe('the authenticator step', () => {
  test('a new Super Admin sets up an authenticator app before anything of the console appears', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('super_admin')
    await page.goto('/platform')

    await expect(page.getByRole('heading', { name: ENROL_HEADING })).toBeVisible()
    // No console, and no navigation into it, before the code.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Platform overview' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Clinics' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Set up authenticator app' }).click()
    await expect(
      page.getByRole('img', { name: 'QR code for adding RecoverEase to your authenticator app' }),
    ).toBeVisible()
    await expect(page.getByText('JBSW Y3DP EHPK 3PXP')).toBeVisible()

    const code = page.getByLabel(/6-digit code/)
    await code.fill('000000')
    await page.getByRole('button', { name: 'Verify and continue' }).click()
    await expect(page.getByRole('alert')).toContainText('That code did not match')
    await expect(code).toHaveValue('')
    await expect(code).toBeFocused()

    expect(consoleCalls(stub.requests)).toEqual([])

    await code.fill(STUB_TOTP_CODE)
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Platform overview' })).toBeVisible()
    await expect(page.getByLabel('Platform totals')).toBeVisible()
    expect(stub.factorsNow().map((factor) => factor.status)).toEqual(['verified'])

    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav.getByRole('link')).toHaveText(['Overview', 'Clinics', 'Announcements', 'Audit log'])
    // The platform sends no notifications, so there is no bell.
    await expect(page.getByRole('link', { name: /Notifications/ })).toHaveCount(0)
  })

  test('every later sign-in asks for a code, and a deep link waits behind it', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true } })
    await page.goto('/platform/audit')

    await expect(page.getByRole('heading', { name: CODE_HEADING })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Platform audit log' })).toHaveCount(0)
    expect(consoleCalls(stub.requests)).toEqual([])

    const code = page.getByLabel(/6-digit code/)
    await expect(code).toBeFocused()

    // A lost authenticator has a way out, and no way round.
    await page.getByText('Lost your authenticator app?').click()
    await expect(page.getByText('There is no way to skip this step')).toBeVisible()

    await code.fill('999999')
    await code.press('Enter')
    await expect(page.getByRole('alert')).toContainText('That code did not match')
    expect(consoleCalls(stub.requests)).toEqual([])

    await code.fill(STUB_TOTP_CODE)
    await code.press('Enter')

    await expect(page).toHaveURL(/\/platform\/audit$/)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Platform audit log' }),
    ).toBeVisible()
    expect(stub.requests).toContain('POST rpc/super_admin_list_audit')
  })

  test('a session the database does not accept stays closed', async ({ page, signInAs }) => {
    const stub = await signInAs(
      'super_admin',
      {},
      { mfa: { verifiedFactor: true, aal: 'aal2' } },
    )
    stub.setRpcResult('super_admin_assured', false)
    await page.goto('/platform')

    await expect(
      page.getByRole('heading', { name: 'This session cannot open the platform console' }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Platform overview' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Clinics' })).toHaveCount(0)
    expect(consoleCalls(stub.requests)).toEqual([])
  })

  test('a clinic role is sent to its own portal, never the console', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('admin')
    await page.goto('/platform')

    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { name: CODE_HEADING })).toHaveCount(0)
    expect(stub.requests.filter((request) => request.includes('super_admin_'))).toEqual([])
  })
})

test.describe('the console', () => {
  test('opens on the overview: platform totals only, asked of one function, with the way on to the clinics', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    await page.goto('/platform')

    await expect(page.getByRole('heading', { level: 1, name: 'Platform overview' })).toBeVisible()
    const totals = page.getByLabel('Platform totals')
    await expect(totals).toContainText('Clinics')
    await expect(totals).toContainText('1 active · 0 inactive')
    await expect(totals).toContainText('Clinic Admins')
    await expect(totals).toContainText('Doctors')
    await expect(totals).toContainText('2 active')
    await expect(totals).toContainText('Patients')
    await expect(totals).toContainText('3 active')
    // No clinic on its own: the overview names none.
    await expect(page.getByText('Harbor Clinic')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'By clinic' })).toHaveCount(0)
    // The overview's only console call is the overview itself.
    expect(consoleCalls(stub.requests)).toEqual(['POST rpc/super_admin_platform_overview'])

    // Nothing wider than the screen, on a phone as on a desktop.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    await page.getByRole('link', { name: 'Manage clinics' }).click()
    await expect(page).toHaveURL(/\/platform\/clinics$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Clinics' })).toBeVisible()
  })

  test('says it could not count, rather than showing figures, when the answer is unreadable', async ({
    page,
    signInAs,
  }) => {
    const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
    stub.setRpcResult('super_admin_platform_overview', { clinics: 'many' })
    await page.goto('/platform')

    // The page's error state - its wording is the shared one, not this
    // function's - with a way to ask again, and not one figure.
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByLabel('Platform totals')).toHaveCount(0)
  })

  test('adds a Clinic Admin by email invitation, handing over no password', async ({
    page,
    signInAs,
  }) => {
    await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })

    const sent: unknown[] = []
    // After signInAs: the stub's catch-all for functions/v1 is registered
    // there, and Playwright gives precedence to the handler registered last.
    await page.route('**/functions/v1/create-account', async (route) => {
      sent.push(JSON.parse(route.request().postData() ?? '{}'))
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'u-new',
          profileId: 'admin-new',
          clinicId: IDS.clinic,
          setupEmailSent: true,
        }),
      })
    })

    await page.goto('/platform/clinics')
    await page.getByRole('button', { name: 'Add Clinic Admin to Harbor Clinic' }).click()

    const dialog = page.getByRole('dialog', { name: 'Add a Clinic Admin to Harbor Clinic' })
    await dialog.getByLabel(/First name/).fill('Ana')
    await dialog.getByLabel(/Last name/).fill('Cruz')
    await dialog.getByLabel(/Email/).fill('ana@harbor.test')
    await dialog.getByRole('button', { name: 'Add Clinic Admin' }).click()

    await expect(dialog.getByText('Clinic Admin added')).toBeVisible()
    await expect(dialog).toContainText('We have emailed ana@harbor.test a link to choose their password.')
    await expect(dialog).not.toContainText(/temporary password/i)

    expect(sent).toEqual([
      {
        kind: 'clinic_admin',
        clinicId: IDS.clinic,
        email: 'ana@harbor.test',
        firstName: 'Ana',
        lastName: 'Cruz',
      },
    ])
  })
})
