import AxeBuilder from '@axe-core/playwright'

import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * The 2nd-half plan, section 8: contrast checked on the rendered screens, in
 * both themes, for every role - not on paper from the tokens alone.
 *
 * Each screen is loaded with the browser-only stub's data, in Light and then
 * in Dark, and axe-core's `color-contrast` rule measures every piece of text
 * against what is actually behind it (WCAG 2.2 AA: 4.5:1, or 3:1 for large
 * text). A failure names the element and the two colours. What axe cannot
 * judge - text over an image or a gradient - it reports as incomplete, which
 * this does not count as a pass or a failure; the brand panels with text are
 * checked by their tokens instead (index.css).
 */

const SCREENS = {
  public: ['/', '/sign-in', '/forgot-password'],
  patient: [
    '/patient',
    '/patient/medications',
    '/patient/treatment',
    '/patient/recovery',
    '/patient/appointments',
    '/patient/chat',
    '/patient/notifications',
    '/patient/announcements',
    '/patient/profile',
  ],
  doctor: [
    '/doctor',
    '/doctor/patients',
    `/doctor/patients/${IDS.alicePat}`,
    `/doctor/patients/${IDS.alicePat}?tab=medication`,
    '/doctor/appointments',
    '/doctor/reports',
    '/doctor/notifications',
    '/doctor/announcements',
    '/doctor/profile',
  ],
  admin: [
    '/admin',
    '/admin/doctors',
    '/admin/reports',
    '/admin/settings',
    '/admin/audit',
    '/admin/announcements',
    '/admin/profile',
  ],
  super_admin: ['/platform', '/platform/announcements', '/platform/audit'],
} as const

async function contrastFailures(page: Page): Promise<string[]> {
  // @axe-core/playwright types its Page against an older Playwright than this
  // project's; the object is the same at runtime.
  const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page']
  const results = await new AxeBuilder({ page: axePage }).withRules(['color-contrast']).analyze()
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => {
      const data = node.any[0]?.data as
        | { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string }
        | undefined
      return `${node.target.join(' ')} - ${data?.fgColor} on ${data?.bgColor} = ${data?.contrastRatio} (needs ${data?.expectedContrastRatio}) "${node.html.slice(0, 90)}"`
    }),
  )
}

/** Waits for a screen to finish loading what it shows. */
async function settled(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`contrast in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.addInitScript((value) => {
        try {
          window.localStorage.setItem('recoverease.theme', value)
        } catch {
          // about:blank has no storage; the real page does.
        }
      }, theme)
    })

    for (const path of SCREENS.public) {
      test(`public ${path}`, async ({ page }) => {
        await page.goto(path)
        await settled(page)
        expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme)
        expect(await contrastFailures(page)).toEqual([])
      })
    }

    for (const role of ['patient', 'doctor', 'admin', 'super_admin'] as const) {
      for (const path of SCREENS[role]) {
        test(`${role} ${path}`, async ({ page, signInAs }) => {
          const stub = await signInAs(
            role,
            {},
            role === 'super_admin' ? { mfa: { verifiedFactor: true, aal: 'aal2' } } : {},
          )
          if (role === 'super_admin') {
            stub.setRpcResult('super_admin_get_guidance_assistant', [{ enabled: true, updated_at: null }])
          }
          await page.goto(path)
          await settled(page)
          expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme)
          expect(await contrastFailures(page)).toEqual([])
        })
      }
    }
  })
}
