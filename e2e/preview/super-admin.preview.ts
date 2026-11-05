import type { Route } from '@playwright/test'

import { expect, IDS, PLATFORM_CLINICS, STUB_TOTP_CODE, test } from '../support/fixtures'
import { installPlatformPreview } from '../support/platform-preview'
import {
  PREVIEW_ORIGIN,
  PREVIEW_SUPABASE_URL,
  type PreviewState,
} from './preview-env'

/**
 * The local Super Admin preview (playwright.preview.config.ts).
 *
 * Opens the console in a browser window, signed in as the E2E stub's Super
 * Admin, with an in-memory platform behind it, and waits until you close the
 * window. Nothing here is real: the sign-in, the authenticator, the session
 * and every clinic and announcement exist only in this browser, and a
 * network guard aborts any request that is not to the local preview server
 * or the stub's unreachable `.invalid` address.
 *
 * With PREVIEW_SMOKE=1 it clicks through by itself instead, headless, as a
 * check that the preview still works.
 */

const preview = test.extend<{ previewState: PreviewState }>({
  previewState: ['enrol', { option: true }],
})

const MFA: Record<PreviewState, { verifiedFactor?: boolean; aal?: 'aal1' | 'aal2' }> = {
  enrol: {},
  verify: { verifiedFactor: true },
  console: { verifiedFactor: true, aal: 'aal2' },
}

const HELP: Record<PreviewState, string> = {
  enrol:
    'Press "Set up authenticator app". The QR code is a stand-in; enter the code below to finish.',
  verify: 'Enter the code below to open the console.',
  console: 'The console is open, as for a session already verified.',
}

preview('Super Admin console, local preview', async ({ page, signInAs, previewState }) => {
  const smoke = process.env['PREVIEW_SMOKE'] === '1'
  if (smoke) preview.setTimeout(90_000)

  const stub = await signInAs('super_admin', {}, { mfa: MFA[previewState] })
  await installPlatformPreview(page, stub, {
    actorUserId: IDS.superAdminUser,
    clinics: PLATFORM_CLINICS.map((clinic) => ({
      ...clinic,
      clinic_status: clinic.clinic_status as 'active' | 'inactive',
    })),
  })

  // Anything that is not the local preview server or the stub's .invalid
  // address is aborted. On this tab it is registered last, so it sees every
  // request before the stub does; on the browser context it covers any
  // other tab or popup opened in the preview window too.
  const stubHost = new URL(PREVIEW_SUPABASE_URL).host
  const blocked: string[] = []
  const guard = async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.origin === PREVIEW_ORIGIN || url.host === stubHost) {
      await route.fallback()
      return
    }
    blocked.push(url.origin)
    await route.abort('blockedbyclient')
  }
  await page.context().route('**/*', guard)
  await page.route('**/*', guard)

  await page.goto('/platform')

  if (!smoke) {
    console.log(
      [
        '',
        `RecoverEase Super Admin preview (${previewState}) - local only, nothing is real.`,
        `  ${HELP[previewState]}`,
        `  Authenticator code: ${STUB_TOTP_CODE}`,
        '  Clinics, Clinic Admins, the guidance assistant switch, announcements and',
        '  the audit log are kept in this browser only. A second clinic is refused,',
        '  as production refuses it until migration 34.',
        '  Close the browser window to end the preview.',
        '',
      ].join('\n'),
    )
    // Closing the whole browser rather than the tab ends it just the same.
    await page.waitForEvent('close', { timeout: 0 }).catch(() => undefined)
    return
  }

  // --- Smoke: the same steps a person would take ------------------------------
  if (previewState === 'enrol') {
    await page.getByRole('button', { name: 'Set up authenticator app' }).click()
    await page.getByLabel(/6-digit code/).fill(STUB_TOTP_CODE)
    await page.getByRole('button', { name: 'Verify and continue' }).click()
  } else if (previewState === 'verify') {
    await page.getByLabel(/6-digit code/).fill(STUB_TOTP_CODE)
    await page.getByRole('button', { name: 'Verify' }).click()
  }
  // The console opens on the overview: counts from the preview's own state.
  await expect(page.getByRole('heading', { level: 1, name: 'Platform overview' })).toBeVisible()
  await expect(page.getByText('1 Clinic Admin · 0 active doctors · 0 active patients')).toBeVisible()
  await page.getByRole('link', { name: 'Manage clinics' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Clinics' })).toBeVisible()

  // A Clinic Admin, invited with no password on screen.
  await page.getByRole('button', { name: 'Add Clinic Admin to Harbor Clinic' }).click()
  const invite = page.getByRole('dialog', { name: 'Add a Clinic Admin to Harbor Clinic' })
  await invite.getByLabel(/First name/).fill('Preview')
  await invite.getByLabel(/Last name/).fill('Admin')
  await invite.getByLabel(/Email/).fill('preview.admin@example.invalid')
  await invite.getByRole('button', { name: 'Add Clinic Admin' }).click()
  await expect(invite.getByText('Clinic Admin added')).toBeVisible()
  await invite.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText(/2 Clinic Admins/)).toBeVisible()

  // A second clinic is refused while the single-clinic gate stands.
  await page.getByRole('button', { name: 'New clinic' }).click()
  const newClinic = page.getByRole('dialog', { name: 'New clinic' })
  await newClinic.getByLabel(/Clinic name/).fill('Second Preview Clinic')
  await newClinic.getByLabel(/Time zone/).fill('Asia/Manila')
  await newClinic.getByRole('button', { name: 'Create clinic' }).click()
  await expect(newClinic.getByText(/set up for one clinic for now/)).toBeVisible()
  await newClinic.getByRole('button', { name: 'Cancel' }).click()

  // The guidance assistant, turned off for every clinic after asking first.
  await page.getByRole('button', { name: 'Turn off for every clinic' }).click()
  await page
    .getByRole('dialog', { name: 'Turn the guidance assistant off for every clinic?' })
    .getByRole('button', { name: 'Turn off for every clinic' })
    .click()
  await expect(page.getByText('Off for every clinic', { exact: true })).toBeVisible()

  // A platform announcement, published, then in the audit log.
  await page.getByRole('link', { name: 'Announcements' }).first().click()
  await page.getByRole('button', { name: 'New announcement' }).click()
  const composer = page.getByRole('dialog', { name: 'New platform announcement' })
  await composer.getByLabel(/Title/).fill('Preview maintenance')
  await composer.getByLabel(/Message/).fill('Nothing here is real.')
  await composer.getByRole('button', { name: 'Publish now' }).click()
  await expect(page.getByRole('heading', { name: 'Preview maintenance' })).toBeVisible()

  await page.getByRole('link', { name: 'Audit log' }).first().click()
  const audit = page.getByRole('table', { name: 'Platform audit entries, most recent first' })
  // The header row and one entry for each change above.
  await expect(audit.getByRole('row')).toHaveCount(4)
  await expect(audit).toContainText('Platform announcement')
  await expect(audit).toContainText('Guidance assistant switch')
  await expect(audit).toContainText('Clinic Admin account')

  // Back on the overview, the counts have followed: the new Clinic Admin and
  // the published announcement.
  await page.getByRole('link', { name: 'Overview' }).first().click()
  await expect(page.getByText('2 Clinic Admins · 0 active doctors · 0 active patients')).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Platform announcements' }).getByText('1', { exact: true }),
  ).toBeVisible()

  // Everything went to the local server or the stub, and nowhere else.
  expect(blocked).toEqual([])
  expect(stub.requests.some((request) => request.includes('rpc/super_admin_list_clinics'))).toBe(true)

  // And the guard really stops anything else - even a Supabase-shaped
  // address the stub's own routes would otherwise answer.
  const outcome = await page.evaluate(() =>
    fetch('https://abcdefghijklmnopqrst.supabase.co/auth/v1/health').then(
      () => 'reached',
      () => 'blocked',
    ),
  )
  expect(outcome).toBe('blocked')
  expect(blocked).toEqual(['https://abcdefghijklmnopqrst.supabase.co'])

  // ...in another tab of the preview window as well.
  const otherTab = await page.context().newPage()
  const reached = await otherTab.goto('https://example.com/').then(
    () => true,
    () => false,
  )
  expect(reached).toBe(false)
  expect(blocked).toEqual(['https://abcdefghijklmnopqrst.supabase.co', 'https://example.com'])
  await otherTab.close()
})
