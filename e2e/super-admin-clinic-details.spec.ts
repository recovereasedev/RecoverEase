import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'
import { installPlatformPreview } from './support/platform-preview'
import type { SupabaseStub } from './support/supabase-stub'

/**
 * Phase 2 of the Super Admin console: the clinic list's search and status
 * filter, a clinic's details page, its Clinic Admins, and renaming a clinic
 * (its time zone is shown read-only) - in a real browser, against the production build and the
 * in-memory platform (e2e/support/platform-preview.ts).
 *
 * The stand-in answers as the database does; it does not decide who may
 * call what. That, and every validation the page repeats, is
 * tests/db/super-admin-clinic-details.test.ts against the real migrations.
 */

const HARBOR = IDS.clinic
const ALDER = '00000000-0000-4000-8000-00000000a1de'

type SignInAsSuperAdmin = (
  role: 'super_admin',
  overrides: Record<string, never>,
  options: { mfa: { verifiedFactor: true; aal: 'aal2' } },
) => Promise<SupabaseStub>

async function openConsole(page: Page, signInAs: SignInAsSuperAdmin) {
  const stub = await signInAs('super_admin', {}, { mfa: { verifiedFactor: true, aal: 'aal2' } })
  await installPlatformPreview(page, stub, {
    actorUserId: IDS.superAdminUser,
    singleClinicGate: false,
    clinics: [
      {
        clinic_id: HARBOR,
        clinic_name: 'Harbor Clinic',
        clinic_status: 'active',
        clinic_timezone: 'Asia/Manila',
        clinic_created_at: '2026-01-01T00:00:00Z',
        clinic_updated_at: '2026-01-02T00:00:00Z',
        clinic_admin_count: 1,
      },
      {
        clinic_id: ALDER,
        clinic_name: 'Alder Wellness',
        clinic_status: 'inactive',
        clinic_timezone: 'Asia/Singapore',
        clinic_created_at: '2026-02-01T00:00:00Z',
        clinic_updated_at: '2026-02-01T00:00:00Z',
        clinic_admin_count: 1,
      },
    ],
    clinicAdmins: {
      [HARBOR]: [
        {
          admin_first_name: 'Ada',
          admin_last_name: 'Reyes',
          admin_created_at: '2026-01-01T00:00:00Z',
          has_signed_in: true,
          last_signed_in_at: '2026-03-01T01:00:00Z',
        },
      ],
      [ALDER]: [
        {
          admin_first_name: 'Zoe',
          admin_last_name: 'Abad',
          admin_created_at: '2026-02-01T00:00:00Z',
          has_signed_in: false,
          last_signed_in_at: null,
        },
      ],
    },
  })
  return stub
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('the clinic list', () => {
  test('searches by name and filters by status, with a way back from no match', async ({ page, signInAs }) => {
    await openConsole(page, signInAs)
    await page.goto('/platform/clinics')

    const list = page.getByRole('list').filter({ has: page.getByRole('heading', { level: 2 }) })
    await expect(list.getByRole('heading', { level: 2 })).toHaveText(['Alder Wellness', 'Harbor Clinic'])
    await expect(page.getByText('Asia/Manila · 1 Clinic Admin')).toBeVisible()

    await page.getByLabel('Search clinics').fill('  harbor ')
    await expect(list.getByRole('heading', { level: 2 })).toHaveText(['Harbor Clinic'])

    await page.getByLabel('Search clinics').fill('')
    await page.getByLabel('Status').selectOption('inactive')
    await expect(list.getByRole('heading', { level: 2 })).toHaveText(['Alder Wellness'])
    await expect(page.getByRole('button', { name: 'Reactivate Alder Wellness' })).toBeVisible()

    await page.getByLabel('Search clinics').fill('harbor')
    await expect(page.getByText('No matching clinics')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(list.getByRole('heading', { level: 2 })).toHaveText(['Alder Wellness', 'Harbor Clinic'])
    await expect(page.getByLabel('Status')).toHaveValue('all')

    // Creating, deactivating and adding a Clinic Admin are still there.
    await expect(page.getByRole('button', { name: 'New clinic' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Deactivate Harbor Clinic' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Clinic Admin to Harbor Clinic' })).toBeVisible()
  })
})

test.describe('a clinic’s details', () => {
  test('opens from the list and shows the clinic and only its own Clinic Admins', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    await page.goto('/platform/clinics')
    await page.getByRole('link', { name: 'View details of Harbor Clinic' }).click()

    await expect(page).toHaveURL(new RegExp(`/platform/clinics/${HARBOR}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor Clinic' })).toBeVisible()
    const info = page.getByRole('definition')
    await expect(info).toContainText(['Harbor Clinic', 'Active', 'Asia/Manila'])

    const admins = page.getByRole('list', { name: 'Clinic Admins of Harbor Clinic' })
    await expect(admins.getByRole('listitem')).toHaveCount(1)
    await expect(admins).toContainText('Ada Reyes')
    await expect(admins).toContainText('Has signed in')
    await expect(page.getByText('Zoe Abad')).toHaveCount(0)
    await expect(page.getByText(/does not confirm that account setup is complete/)).toBeVisible()

    // Asked of the database for this clinic, by its id.
    expect(stub.requests).toContain('POST rpc/super_admin_list_clinic_admins')

    await page.getByRole('link', { name: 'Clinics' }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Clinics' })).toBeVisible()
  })

  test('says a clinic that does not exist could not be found', async ({ page, signInAs }) => {
    await openConsole(page, signInAs)
    await page.goto('/platform/clinics/00000000-0000-4000-8000-0000000000c1')
    await expect(page.getByRole('heading', { level: 1, name: 'Clinic not found' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to clinics' })).toBeVisible()
  })

  test('says a clinic without a Clinic Admin has none yet', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    stub.setRpcHandler('super_admin_list_clinic_admins', () => ({ result: [] }))
    await page.goto(`/platform/clinics/${HARBOR}`)
    await expect(page.getByText('No Clinic Admin yet')).toBeVisible()
  })

  test('offers to try again when the Clinic Admins could not be loaded', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    stub.setRpcHandler('super_admin_list_clinic_admins', () => ({
      status: 500,
      error: { code: 'XX000', message: 'boom' },
    }))
    await page.goto(`/platform/clinics/${HARBOR}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor Clinic' })).toBeVisible()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})

test.describe('editing a clinic', () => {
  test('renames it, and the new name is what the database has after a reload', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    await page.goto(`/platform/clinics/${HARBOR}`)
    await page.getByRole('button', { name: 'Edit clinic' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit clinic' })
    await expect(dialog.getByLabel(/Clinic name/)).toHaveValue('Harbor Clinic')
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

    // Checked before anything is sent.
    await dialog.getByLabel(/Clinic name/).fill('   ')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByText("Enter the clinic's name.")).toBeVisible()
    await dialog.getByLabel(/Clinic name/).fill('x'.repeat(121))
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByText('A clinic name can be at most 120 characters.')).toBeVisible()
    expect(stub.requests).not.toContain('POST rpc/super_admin_rename_clinic')

    // Refused by the database: the message it wrote is shown.
    await dialog.getByLabel(/Clinic name/).fill('alder wellness')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByText('A clinic with that name already exists')).toBeVisible()

    await dialog.getByLabel(/Clinic name/).fill('  Harbor Recovery Centre  ')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'The clinic’s details were saved.' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor Recovery Centre' })).toBeVisible()
    // The refused name and the saved one: two renames, and the zone is as
    // it was.
    const sent = stub.requests.filter((r) => r === 'POST rpc/super_admin_rename_clinic')
    expect(sent).toHaveLength(2)
    await expect(page.getByRole('definition').filter({ hasText: /^Asia\/Manila$/ })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor Recovery Centre' })).toBeVisible()
    await page.goto('/platform/clinics')
    await expect(page.getByRole('heading', { level: 2, name: 'Harbor Recovery Centre' })).toBeVisible()
  })

  test('shows the time zone read-only, with no control that could change it', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    const bodies: unknown[] = []
    page.on('request', (request) => {
      if (request.url().includes('/rpc/super_admin_rename_clinic')) bodies.push(request.postDataJSON())
    })
    await page.goto(`/platform/clinics/${HARBOR}`)
    await expect(page.getByRole('definition').filter({ hasText: /^Asia\/Manila$/ })).toBeVisible()
    await page.getByRole('button', { name: 'Edit clinic' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit clinic' })
    await expect(dialog).toContainText('Asia/Manila')
    await expect(dialog).toContainText('Read-only here')
    // The name is the only thing that can be typed into.
    await expect(dialog.getByLabel(/Time zone/)).toHaveCount(0)
    await expect(dialog.getByRole('textbox')).toHaveCount(1)
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.locator('datalist')).toHaveCount(0)

    await dialog.getByLabel(/Clinic name/).fill('Harbor Renamed')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor Renamed' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: "Change the clinic's time zone?" })).toHaveCount(0)
    expect(bodies).toEqual([{ target_clinic_id: HARBOR, new_clinic_name: 'Harbor Renamed' }])
    expect(stub.requests).not.toContain('POST rpc/super_admin_update_clinic')
    await expect(page.getByRole('definition').filter({ hasText: /^Asia\/Manila$/ })).toBeVisible()
  })

  test('says so, and sends nothing, when nothing changed', async ({ page, signInAs }) => {
    const stub = await openConsole(page, signInAs)
    await page.goto(`/platform/clinics/${HARBOR}`)
    await page.getByRole('button', { name: 'Edit clinic' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit clinic' })
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByText('Nothing has changed, so there is nothing to save.')).toBeVisible()
    expect(stub.requests).not.toContain('POST rpc/super_admin_rename_clinic')
  })
})

test.describe('who reaches it', () => {
  for (const role of ['admin', 'doctor', 'patient'] as const) {
    test(`a ${role} is sent away from a clinic’s details, asking nothing of the platform`, async ({
      page,
      signInAs,
    }) => {
      const stub = await signInAs(role)
      await page.goto(`/platform/clinics/${HARBOR}`)
      await expect(page).not.toHaveURL(/\/platform/)
      await expect(page.getByRole('heading', { name: 'Harbor Clinic' })).toHaveCount(0)
      expect(stub.requests.filter((request) => request.includes('super_admin_'))).toEqual([])
    })
  }
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('the list, the details and the edit form fit the screen', async ({ page, signInAs }) => {
    await openConsole(page, signInAs)
    await page.goto('/platform/clinics')
    await expect(page.getByLabel('Search clinics')).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

    await page.goto(`/platform/clinics/${HARBOR}`)
    await expect(page.getByRole('list', { name: 'Clinic Admins of Harbor Clinic' })).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

    await page.getByRole('button', { name: 'Edit clinic' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit clinic' })
    await expect(dialog.getByLabel(/Clinic name/)).toBeVisible()
    await expect(dialog).toContainText('Read-only here')
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
})
