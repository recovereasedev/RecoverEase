import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * A platform announcement - RecoverEase's, written by a Super Admin - in the
 * clinic's own announcement screens.
 *
 * A Clinic Admin reads it but has nothing to press on it: the database
 * refuses them, and refuses by changing no row rather than by raising, so a
 * button there would only seem to work. Their own announcements keep every
 * control, and a change that touched no row is reported, not passed off as
 * done. Patients and doctors see which notices come from RecoverEase.
 */

const CLINIC_NOTICE = {
  announcement_id: 'ann-1',
  admin_id: IDS.admin,
  super_admin_id: null,
  clinic_id: IDS.clinic,
  announcement_title: 'Clinic hours',
  announcement_content: 'Open 8am to 5pm on weekdays.',
  announcement_published_at: '2026-02-01T00:00:00Z',
  announcement_created_at: '2026-02-01T00:00:00Z',
}

const PLATFORM_NOTICE = {
  announcement_id: 'ann-platform',
  admin_id: null,
  super_admin_id: IDS.superAdmin,
  clinic_id: null,
  announcement_title: 'Planned maintenance',
  announcement_content: 'RecoverEase will be briefly unavailable on Sunday night.',
  announcement_published_at: '2026-02-02T00:00:00Z',
  announcement_created_at: '2026-02-02T00:00:00Z',
}

const notice = (page: Page, title: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name: title }) })

test('a Clinic Admin reads RecoverEase’s announcement, with nothing to press on it', async ({
  page,
  signInAs,
}) => {
  const stub = await signInAs('admin', { announcement: [PLATFORM_NOTICE, CLINIC_NOTICE] })
  await page.goto('/admin/announcements')

  const platform = notice(page, 'Planned maintenance')
  await expect(platform.getByText('From RecoverEase')).toBeVisible()
  await expect(platform.getByText('Only RecoverEase can change or remove this notice.')).toBeVisible()
  await expect(platform.getByRole('button')).toHaveCount(0)

  const own = notice(page, 'Clinic hours')
  await expect(own.getByRole('button', { name: 'Unpublish' })).toBeVisible()
  await expect(own.getByRole('button', { name: /^Delete/ })).toBeVisible()
  await expect(own.getByText('From RecoverEase')).toHaveCount(0)

  expect(stub.requests.filter((request) => /^(PATCH|DELETE) /.test(request))).toEqual([])
})

test('a Clinic Admin is told when unpublishing changed nothing', async ({ page, signInAs }) => {
  await signInAs('admin', { announcement: [CLINIC_NOTICE] })
  // The database's answer to a refused update: no row, and no error.
  await page.route('**/rest/v1/announcement**', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    await route.fallback()
  })
  await page.goto('/admin/announcements')

  const own = notice(page, 'Clinic hours')
  await own.getByRole('button', { name: 'Unpublish' }).click()

  await expect(own.getByText('The announcement was not unpublished')).toBeVisible()
  await expect(own.getByText(/This announcement was not changed\./)).toBeVisible()
  await expect(own.getByText('Published', { exact: true })).toBeVisible()
})

test('a Clinic Admin still deletes their own announcement, and RecoverEase’s stays', async ({
  page,
  signInAs,
}) => {
  await signInAs('admin', { announcement: [PLATFORM_NOTICE, CLINIC_NOTICE] })
  await page.goto('/admin/announcements')

  await notice(page, 'Clinic hours').getByRole('button', { name: /^Delete/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click()

  await expect(page.getByRole('heading', { name: 'Clinic hours' })).toHaveCount(0)
  await expect(notice(page, 'Planned maintenance').getByText('From RecoverEase')).toBeVisible()
})

test('a patient sees which notices come from RecoverEase and which from their clinic', async ({
  page,
  signInAs,
}) => {
  await signInAs('patient', { announcement: [PLATFORM_NOTICE, CLINIC_NOTICE] })
  await page.goto('/patient/announcements')

  await expect(page.getByText('Notices from your clinic and from RecoverEase.')).toBeVisible()
  await expect(notice(page, 'Planned maintenance').getByText('From RecoverEase')).toBeVisible()
  await expect(notice(page, 'Clinic hours').getByText('From your clinic')).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: /publish|delete/i })).toHaveCount(0)
})
