import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * A doctor's announcements (migration 36): for their own patients.
 *
 * A doctor reads RecoverEase's and their Clinic Admin's, each marked with
 * where it is from and with nothing to press, and writes their own for their
 * patients, which they then manage. Their Clinic Admin sees who wrote a
 * doctor's announcement; their patient sees it is from their doctor.
 *
 * The stub does not enforce RLS - it serves whatever rows a test gives it -
 * so who reads a doctor's announcement is shown in
 * tests/db/doctor-announcements.test.ts, against the real policies.
 */

const PLATFORM_NOTICE = {
  announcement_id: 'ann-platform',
  admin_id: null,
  doc_id: null,
  super_admin_id: IDS.superAdmin,
  clinic_id: null,
  announcement_title: 'Planned maintenance',
  announcement_content: 'RecoverEase will be briefly unavailable on Sunday night.',
  announcement_published_at: '2026-02-03T00:00:00Z',
  announcement_created_at: '2026-02-03T00:00:00Z',
  doctor: null,
}

const CLINIC_NOTICE = {
  announcement_id: 'ann-1',
  admin_id: IDS.admin,
  doc_id: null,
  super_admin_id: null,
  clinic_id: IDS.clinic,
  announcement_title: 'Clinic hours',
  announcement_content: 'Open 8am to 5pm on weekdays.',
  announcement_published_at: '2026-02-01T00:00:00Z',
  announcement_created_at: '2026-02-01T00:00:00Z',
  doctor: null,
}

/** Doctor A's, for their patients, as each reader's query returns it. */
const DOCTOR_NOTICE = {
  announcement_id: 'ann-doctor',
  admin_id: null,
  doc_id: IDS.doctorA,
  super_admin_id: null,
  clinic_id: IDS.clinic,
  announcement_title: 'Wound care clinic',
  announcement_content: 'Walk-in wound checks on Thursdays.',
  announcement_published_at: '2026-02-02T00:00:00Z',
  announcement_created_at: '2026-02-02T00:00:00Z',
  doctor: { doc_first_name: 'Alan', doc_last_name: 'Cruz' },
}

const notice = (page: Page, title: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name: title }) })

test('a doctor reads RecoverEase’s and their Clinic Admin’s announcements, and posts one for their patients', async ({
  page,
  signInAs,
}) => {
  const stub = await signInAs('doctor', { announcement: [PLATFORM_NOTICE, CLINIC_NOTICE] })
  const posted: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/rest/v1/announcement')) {
      posted.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>)
    }
  })

  await page.goto('/doctor')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Announcements' }).click()
  await expect(page).toHaveURL(/\/doctor\/announcements$/)
  await expect(
    page.getByText("Your notices for your patients, with your Clinic Admin's and RecoverEase's. You can change the ones you wrote."),
  ).toBeVisible()

  const platform = notice(page, 'Planned maintenance')
  await expect(platform.getByText('From RecoverEase')).toBeVisible()
  await expect(platform.getByRole('button')).toHaveCount(0)
  const clinic = notice(page, 'Clinic hours')
  await expect(clinic.getByText('From your clinic')).toBeVisible()
  await expect(clinic.getByText('Only your Clinic Admin can change or remove this notice.')).toBeVisible()
  await expect(clinic.getByRole('button')).toHaveCount(0)

  await page.getByRole('button', { name: 'New announcement' }).first().click()
  const composer = page.getByRole('dialog')
  await expect(composer.getByText(/It reaches your patients only\./)).toBeVisible()
  await composer.getByLabel(/Title/).fill('Flu shots')
  await composer.getByLabel(/Message/).fill('Available from Monday at the front desk.')
  await composer.getByRole('button', { name: 'Publish now' }).click()

  const mine = notice(page, 'Flu shots')
  await expect(mine.getByText('For your patients')).toBeVisible()
  await expect(mine.getByText('Published', { exact: true })).toBeVisible()
  await expect(mine.getByRole('button', { name: 'Unpublish' })).toBeVisible()
  await expect(mine.getByRole('button', { name: /^Delete/ })).toBeVisible()

  // Written as this doctor, with no clinic, audience or other author sent:
  // the database takes the clinic from the doctor and decides who reads it.
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ doc_id: IDS.doctorA, announcement_title: 'Flu shots' })
  for (const column of ['admin_id', 'super_admin_id', 'clinic_id']) expect(posted[0]).not.toHaveProperty(column)

  // Nothing was sent to change anyone else's.
  expect(stub.requests.filter((request) => /^(PATCH|DELETE) /.test(request))).toEqual([])
})

test('a Clinic Admin sees which doctor wrote an announcement, and that it is for that doctor’s patients', async ({
  page,
  signInAs,
}) => {
  await signInAs('admin', { announcement: [CLINIC_NOTICE, DOCTOR_NOTICE] })
  await page.goto('/admin/announcements')

  const doctors = notice(page, 'Wound care clinic')
  await expect(doctors.getByText('By Dr Alan Cruz, for their patients')).toBeVisible()
  await expect(doctors.getByRole('button', { name: 'Unpublish' })).toBeVisible()
  await expect(notice(page, 'Clinic hours').getByText(/for their patients/)).toHaveCount(0)
})

test('a patient sees their doctor’s announcement as from their doctor', async ({ page, signInAs }) => {
  await signInAs('patient', { announcement: [PLATFORM_NOTICE, CLINIC_NOTICE, DOCTOR_NOTICE] })
  await page.goto('/patient/announcements')

  await expect(page.getByText('Notices from your clinic, your doctor and RecoverEase.')).toBeVisible()
  await expect(notice(page, 'Wound care clinic').getByText('From your doctor')).toBeVisible()
  await expect(notice(page, 'Wound care clinic').getByText(/Cruz/)).toHaveCount(0)
  await expect(notice(page, 'Clinic hours').getByText('From your clinic')).toBeVisible()
  await expect(notice(page, 'Planned maintenance').getByText('From RecoverEase')).toBeVisible()
})
