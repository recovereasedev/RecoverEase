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

  test('starts a consultation from the patient header', async ({
    page,
    signInAs,
  }) => {
    // QA 09/06/2026 #2. The consultation workflow already existed but was
    // only reachable straight after registering a new patient. This is the
    // same destination, offered from the screen the clinician is on when the
    // patient is actually in front of them — it opens no second workflow.
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}`)

    await expect(
      page.getByRole('tab', { name: 'Overview' }),
    ).toHaveAttribute('aria-selected', 'true')

    await page.getByRole('button', { name: /start consultation/i }).click()

    // The existing treatment workflow, not a new one.
    await expect(page.getByRole('tab', { name: 'Treatment' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // Kept in the URL, so a reload or a shared link lands in the same place.
    await expect(page).toHaveURL(/\?tab=treatment$/)

    // And medication is the next step of that same flow, already present.
    await expect(page.getByRole('tab', { name: 'Medication' })).toBeVisible()
  })

  test('a consultation deep link still opens on the treatment tab', async ({
    page,
    signInAs,
  }) => {
    // The destination registration hands off to. The header button and the
    // registration button must agree on it.
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)

    await expect(page.getByRole('tab', { name: 'Treatment' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('records a whole consultation: plan, goal, then medication', async ({
    page,
    signInAs,
  }) => {
    // F-01. Every hook behind this existed and was tested; nothing called
    // them, so a clinician could read a treatment plan they had no way to
    // write. Bob has no plan, which is where the road used to end.
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.bobPat}`)

    await page.getByRole('button', { name: /start consultation/i }).click()
    await expect(page.getByRole('tab', { name: 'Treatment' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(
      page.getByText('Consultation with Bob Reyes'),
    ).toBeVisible()

    // Step 1 — the treatment plan.
    await page.getByLabel(/plan title/i).fill('Shoulder rehabilitation')
    await page.getByLabel(/start date/i).fill('2026-03-01')
    await page
      .getByRole('button', { name: /^Create treatment plan$/ })
      .click()

    // Step 2 — goals, added one at a time against that plan.
    await expect(page.getByRole('button', { name: /^Add goal$/ })).toBeVisible()
    await page.getByLabel(/goal/i).first().fill('Raise arm above shoulder')
    await page.getByRole('button', { name: /^Add goal$/ }).click()
    await expect(page.getByText('Raise arm above shoulder')).toBeVisible()

    // Step 3 — the prescription and its schedule, in one submit.
    await page.getByRole('button', { name: /continue to medication/i }).click()
    await page.getByLabel(/prescription notes/i).fill('Take with food.')
    await page.getByLabel(/medicine/i).fill('Ibuprofen')
    await page.getByLabel(/dosage/i).fill('200 mg')
    await page.getByRole('button', { name: /^Add prescription$/ }).click()
    await expect(page.getByText('Ibuprofen')).toBeVisible()

    // Step 4 — review reads back what was saved, not what was typed.
    await page.getByRole('button', { name: /continue to review/i }).click()
    await expect(page.getByText(/Shoulder rehabilitation/)).toBeVisible()
    await expect(page.getByText('Raise arm above shoulder')).toBeVisible()

    // Step 5 — finish, and stay on the patient record.
    await page.getByRole('button', { name: /finish consultation/i }).click()
    await expect(page.getByText('Consultation recorded')).toBeVisible()
    await page
      .getByRole('button', { name: /back to the patient record/i })
      .click()

    // The records are the patient's now, not the wizard's.
    await expect(page.getByText('Shoulder rehabilitation')).toBeVisible()
    await expect(page.getByText('Raise arm above shoulder')).toBeVisible()

    await page.getByRole('tab', { name: 'Medication' }).click()
    await expect(page.getByText('Ibuprofen')).toBeVisible()
    await expect(page.getByText(/200 mg/)).toBeVisible()
  })

  test('names each screen in the browser tab', async ({ page, signInAs }) => {
    // F-02. Every signed-in page used to be "RecoverEase", so history was a
    // column of identical entries and a screen reader announced the same
    // title on every navigation.
    await signInAs('doctor')

    await page.goto('/doctor')
    await expect(page).toHaveTitle('RecoverEase | Dashboard')

    // Client-side navigation, not a fresh load: the title has to follow the
    // router, and must not stay stuck on the page just left.
    await page.getByRole('link', { name: 'Patients', exact: true }).first().click()
    await expect(page).toHaveTitle('RecoverEase | Patients')

    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    await expect(page).toHaveTitle('RecoverEase | Patient Record')
    // The record names the patient; the tab and the history entry do not.
    await expect(page).not.toHaveTitle(/Alice|Santos/)

    await page.goto('/doctor/appointments')
    await expect(page).toHaveTitle('RecoverEase | Appointments')
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

  test('names the administrator screens too', async ({ page, signInAs }) => {
    await signInAs('admin')

    await page.goto('/admin')
    await expect(page).toHaveTitle('RecoverEase | Dashboard')

    await page.goto('/admin/audit')
    await expect(page).toHaveTitle('RecoverEase | Audit Log')

    await page.goto('/admin/settings')
    await expect(page).toHaveTitle('RecoverEase | System Settings')
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
