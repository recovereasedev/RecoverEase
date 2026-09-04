import { expect, IDS, test } from './support/fixtures'

test.describe('doctor workspace', () => {
  test('lists the caseload and opens a patient record', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')

    await expect(page.getByRole('link', { name: 'Alice Santos' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Bob Reyes' })).toBeVisible()

    // Carol belongs to another clinician. She is absent because the policy
    // would leave her absent — the stub answers per-principal, as the
    // database would after filtering.
    await expect(page.getByText('Carol')).toHaveCount(0)

    await page.getByRole('link', { name: 'Alice Santos' }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Alice Santos' }),
    ).toBeVisible()
  })

  test('filters the caseload by name', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')

    await page.getByLabel(/search patients by name/i).fill('bob')

    await expect(page.getByRole('link', { name: 'Bob Reyes' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Alice Santos' })).toHaveCount(0)
  })

  test('moves between tabs on a patient record with the keyboard', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}`)

    const overview = page.getByRole('tab', { name: 'Overview' })
    await expect(overview).toHaveAttribute('aria-selected', 'true')

    await overview.focus()
    await page.keyboard.press('ArrowRight')

    await expect(page.getByRole('tab', { name: 'Recovery' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(
      page.getByText('Walked to the end of the road.'),
    ).toBeVisible()
  })

  test('writes a clinical note', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}`)

    await page.getByRole('tab', { name: 'Notes' }).click()

    // Notes are clinician-only in both directions, and the UI says so.
    await expect(
      page.getByText(/patients cannot read them/i),
    ).toBeVisible()

    await page
      .getByLabel('Note', { exact: true })
      .fill('Wound healing well. Continue physiotherapy twice weekly.')
    await page.getByRole('button', { name: /save note/i }).click()

    await expect(
      page.getByText('Wound healing well. Continue physiotherapy twice weekly.'),
    ).toBeVisible()
  })

  test('offers registration, since patients cannot register themselves', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor')
    await page.goto('/doctor/patients')

    await page.getByRole('button', { name: /register a patient/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // No password input: the clinician never types or chooses a credential.
    // The temporary one is generated server-side and shown once after the
    // account exists, and the holder must replace it at first sign-in.
    await expect(dialog.getByLabel(/password/i)).toHaveCount(0)
    await expect(
      dialog.getByText(/temporary password to hand over/i),
    ).toBeVisible()
  })
})

test.describe('administrator boundaries', () => {
  test('has no patient section in navigation', async ({ page, signInAs }) => {
    await signInAs('admin')
    await page.goto('/admin')

    const navigation = page.getByRole('navigation', { name: 'Main' })
    await expect(navigation.getByRole('link', { name: /doctor accounts/i })).toBeVisible()
    await expect(navigation.getByRole('link', { name: /audit log/i })).toBeVisible()

    // The module list gives admin no patient-management module. Nav is not a
    // security boundary, but it should not advertise a door that does not
    // exist.
    await expect(navigation.getByRole('link', { name: /^patients$/i })).toHaveCount(0)
  })

  test('sees counts on the dashboard, not patient rows', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', {
      // The aggregate RPC is a POST to /rest/v1/rpc/..., which the stub
      // serves from this table.
      'rpc/admin_dashboard_stats': [
        {
          patients: { total: 4, active: 3 },
          doctors: { total: 2, active: 2 },
          accounts: { patient: 4, doctor: 2, admin: 1 },
          appointments: { upcoming: 5 },
          generated_at: new Date().toISOString(),
        },
      ],
    })

    await page.goto('/admin')

    await expect(
      page.getByRole('heading', { level: 1, name: /system overview/i }),
    ).toBeVisible()

    // No patient name appears anywhere on the administrator's dashboard.
    await expect(page.getByText('Alice')).toHaveCount(0)
    await expect(page.getByText('Santos')).toHaveCount(0)
  })

  test('reads the audit log without seeing patient values in it', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.goto('/admin/audit')

    await expect(
      page.getByRole('heading', { level: 1, name: /audit log/i }),
    ).toBeVisible()

    // The page states the rule, and the row demonstrates it: which column
    // changed, never what it changed to.
    await expect(
      page.getByText(/show which fields changed, never their contents/i),
    ).toBeVisible()
    await expect(page.getByText('pat contact no')).toBeVisible()
    await expect(page.getByText('0917')).toHaveCount(0)
  })

  test('manages doctor accounts and can deactivate one', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.goto('/admin/doctors')

    // getByRole('paragraph'): the name also appears inside each button as
    // screen-reader-only text, which is deliberate — it disambiguates
    // "Deactivate" when several are on the page.
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'Dr Alan Cruz' }),
    ).toBeVisible()
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'Dr Bea Lim' }),
    ).toBeVisible()

    await page
      .getByRole('button', { name: /deactivate.*alan cruz/i })
      .click()

    await expect(page.getByText('Deactivated').first()).toBeVisible()

    // The consequence is stated, because it is not obvious that this is a
    // data-access change rather than a login change.
    await expect(
      page.getByText(/withdraws their access to all\s+patient records/i),
    ).toBeVisible()
  })

  test('cannot reach a patient screen by typing the URL', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.goto('/patient/medications')

    await expect(page).toHaveURL(/\/admin$/)
  })
})
