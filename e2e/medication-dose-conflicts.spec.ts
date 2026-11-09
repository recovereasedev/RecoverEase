import type { Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Dose conflicts (migration 48) in the browser, against the production build
 * and the stub: what the patient reads, and the treating doctor's decision.
 * Who may read or decide, and every check on a decision, are
 * tests/db/medication-dose-identity.test.ts against the real migrations.
 *
 * The workflow and its wording are PROVISIONAL until the clinical adviser
 * approves them (docs/medication-clock-change-decisions.md).
 */

function dateKey(daysFromToday = 0): string {
  const when = new Date()
  when.setDate(when.getDate() + daysFromToday)
  return [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-')
}

const DAY = dateKey(5)

const PRESCRIPTION = {
  prescription_id: 'rx-conflict',
  prescription_issued_date: dateKey(-10),
  prescription_notes: null,
  pat_id: IDS.alicePat,
  doc_id: IDS.doctorA,
}

const SCHEDULE = {
  medication_schedule_id: 'ms-conflict',
  prescription_id: PRESCRIPTION.prescription_id,
  medication_schedule_name: 'Medicine X',
  medication_schedule_dosage: '1 tablet',
  medication_schedule_frequency: 2,
  medication_schedule_times: ['08:00:00', '20:00:00'],
  medication_schedule_start_date: dateKey(-10),
  medication_schedule_end_date: null,
  medication_schedule_created_at: `${dateKey(-10)}T00:00:00Z`,
  prescription: PRESCRIPTION,
}

function heldConflict() {
  return {
    medication_dose_conflict_id: 'conflict-1',
    medication_schedule_id: SCHEDULE.medication_schedule_id,
    conflict_dose_date: DAY,
    conflict_dose_time: '08:00:00',
    conflict_reason: 'same_moment_collision',
    conflict_at: `${DAY}T00:00:00Z`,
    conflicting_log_id: null,
    conflict_detected_at: new Date().toISOString(),
    conflict_resolution: null,
    resolved_log_id: null,
    resolved_by_doc_id: null,
    conflict_resolved_at: null,
    conflict_resolution_note: null,
    conflict_doctor_alerted_at: null,
    conflict_doctor_final_alert_at: null,
    medication_schedule: {
      medication_schedule_id: SCHEDULE.medication_schedule_id,
      medication_schedule_name: 'Medicine X',
      medication_schedule_dosage: '1 tablet',
      prescription: { pat_id: IDS.alicePat },
    },
  }
}

/** The doctor's own clinic, which the policy lets them read. */
const CLINIC = [
  {
    clinic_id: 'clinic-harborview',
    clinic_name: 'Harborview Recovery Clinic',
    clinic_status: 'active',
    clinic_timezone: 'Asia/Manila',
    clinic_created_at: '2026-01-01T00:00:00Z',
    clinic_updated_at: '2026-03-01T00:00:00Z',
  },
]

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('a dose time held for review', () => {
  test('the patient reads a neutral notice, with no action, and it is no dose to mark', async ({ page, signInAs }) => {
    await signInAs('patient', {
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    await page.goto('/patient/medications')

    const section = page.getByRole('list', { name: 'Dose times reviewed because of a clock change' })
    await expect(section).toContainText("awaiting your doctor's review because of a clock change")
    await expect(section).toContainText('Medicine X (1 tablet)')
    await expect(section).not.toContainText(/\b(take|skip)\b/i)
    await expect(section.getByRole('button')).toHaveCount(0)
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test('the treating doctor decides, choosing the time themselves, with a reason', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor', {
      clinic: CLINIC,
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    const sent: Record<string, unknown>[] = []
    stub.setRpcHandler('doctor_resolve_medication_conflict', (args) => {
      sent.push(args)
      const row = stub.rowsIn('medication_dose_conflict')[0]!
      Object.assign(row, {
        conflict_resolution: args['resolution'],
        conflict_resolution_note: args['resolution_note'],
        // The dose the chosen time became.
        resolved_log_id: 'log-rescheduled',
        conflict_resolved_at: new Date().toISOString(),
        resolved_by_doc_id: IDS.doctorA,
      })
      return { result: [row] }
    })

    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    await expect(page.getByText('1 dose time needs your review')).toBeVisible()
    await expect(page.getByText(/already due at the same moment/)).toBeVisible()
    await page.getByRole('button', { name: /Review the 08:00 dose time/ }).click()

    const dialog = page.getByRole('dialog', { name: 'Review a dose time' })
    await expect(dialog).toContainText('Times are in Asia/Manila')
    for (const radio of await dialog.getByRole('radio').all()) await expect(radio).not.toBeChecked()

    await dialog.getByRole('button', { name: 'Record decision' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Choose a time for this dose or no separate dose.')

    await dialog.getByRole('radio', { name: /Set a time for this dose/ }).check()
    const time = dialog.getByLabel(/Time on/)
    await expect(time).toHaveValue('')
    await time.fill('09:15')
    await dialog.getByLabel(/Reason for this decision/).fill('Given later that morning')
    await dialog.getByRole('button', { name: 'Record decision' }).click()

    await expect(dialog).toHaveCount(0)
    // 09:15 in Manila is 01:15 UTC, on the same date.
    expect(sent).toEqual([
      {
        target_conflict_id: 'conflict-1',
        resolution: 'rescheduled',
        new_scheduled_at: `${DAY}T01:15:00.000Z`,
        resolution_note: 'Given later that morning',
      },
    ])
    await expect(page.getByText(/Rescheduled by the doctor · Reason: Given later that morning/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Review the 08:00 dose time/ })).toHaveCount(0)
  })

  test('when someone already decided, says so and refreshes the list', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor', {
      clinic: CLINIC,
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    // Another decision lands first, so the database refuses this one.
    stub.setRpcHandler('doctor_resolve_medication_conflict', () => {
      Object.assign(stub.rowsIn('medication_dose_conflict')[0]!, {
        conflict_resolution: 'not_given_separately',
        conflict_resolution_note: 'Decided earlier',
        conflict_resolved_at: new Date().toISOString(),
        resolved_by_doc_id: IDS.doctorA,
      })
      return { status: 400, error: { code: '55000', message: 'This dose conflict has already been resolved' } }
    })

    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    await page.getByRole('button', { name: /Review the 08:00 dose time/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Review a dose time' })
    await dialog.getByRole('radio', { name: /No separate dose/ }).check()
    await dialog.getByLabel(/Reason for this decision/).fill('Reason')
    await dialog.getByRole('button', { name: 'Record decision' }).click()

    await expect(dialog).toContainText('This dose conflict has already been resolved')
    // Behind the dialog (outside the accessibility tree while it is open), the
    // list already shows the earlier decision and no Review button.
    await expect(page.getByText(/Doctor decided: not given separately · Reason: Decided earlier/)).toBeAttached()
    await expect(page.locator('button[aria-label^="Review the 08:00 dose time"]')).toHaveCount(0)
  })

  test('says so, and offers no review, when the clinic’s time zone cannot be read', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    // The website retries the failed read twice before it says so.
    await expect(page.getByText(/time zone could not be loaded/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /Review the 08:00 dose time/ })).toBeDisabled()
  })

  /** Fails every read of the conflicts, as a network or server error would. */
  const failConflicts = (page: Page) =>
    page.route('**/rest/v1/medication_dose_conflict**', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'upstream unavailable' }),
          })
        : route.fallback(),
    )

  test('a failed load is shown as an error to the patient, never as no conflicts', async ({ page, signInAs }) => {
    await signInAs('patient', {
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    await failConflicts(page)
    await page.goto('/patient/medications')

    // The website retries a failed read twice before it says so.
    await expect(page.getByRole('heading', { name: 'Clock-change dose reviews could not be loaded' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/so any are missing here/)).toBeVisible()
    await expect(page.getByRole('button', { name: /try again/i }).first()).toBeVisible()
  })

  test('a failed load is shown as an error to the doctor, never as no conflicts', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      clinic: CLINIC,
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    await failConflicts(page)
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)

    // The website retries a failed read twice before it says so.
    await expect(page.getByRole('heading', { name: 'Clock-change dose reviews could not be loaded' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText('1 dose time needs your review')).toHaveCount(0)

    // Once the database answers again, "Try again" brings the review back.
    await page.unroute('**/rest/v1/medication_dose_conflict**')
    const section = page.getByRole('region', { name: 'Clock-change dose reviews could not be loaded' })
    await section.getByRole('button', { name: /try again/i }).click()
    await expect(page.getByText('1 dose time needs your review')).toBeVisible()
  })

  test('shows nothing about conflicts when there are none', async ({ page, signInAs }) => {
    await signInAs('doctor', { prescription: [PRESCRIPTION], medication_schedule: [SCHEDULE] })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    await expect(page.getByText('Medicine X', { exact: true })).toBeVisible()
    await expect(page.getByText('Clock-change dose reviews')).toHaveCount(0)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('the doctor’s reviews and the decision dialog fit the screen', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      clinic: CLINIC,
      prescription: [PRESCRIPTION],
      medication_schedule: [SCHEDULE],
      medication_dose_conflict: [heldConflict()],
    })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    await expect(page.getByText('1 dose time needs your review')).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: /Review the 08:00 dose time/ }).click()
    await expect(page.getByRole('dialog', { name: 'Review a dose time' })).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
})
