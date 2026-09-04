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
