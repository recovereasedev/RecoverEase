import { expect, IDS, test } from './support/fixtures'

/**
 * QA-01 — ending a medication, in the browser.
 *
 * What the database does when an end date is set — which doses go, which
 * stay, what the reminder and overdue jobs skip — is covered by the database
 * suite. Here: the clinician's confirmation, the one request it sends, and
 * what both people see afterwards.
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

const TODAY = dateKey()

const PRESCRIPTION = {
  prescription_id: 'rx-end',
  prescription_issued_date: dateKey(-10),
  prescription_notes: 'Take with food.',
  pat_id: IDS.alicePat,
}

function amoxicillin(endDate: string | null) {
  return {
    medication_schedule_id: 'ms-end',
    prescription_id: PRESCRIPTION.prescription_id,
    medication_schedule_name: 'Amoxicillin',
    medication_schedule_dosage: '500mg',
    medication_schedule_frequency: 2,
    medication_schedule_times: ['08:00:00', '20:00:00'],
    medication_schedule_start_date: dateKey(-10),
    medication_schedule_end_date: endDate,
    medication_schedule_created_at: `${dateKey(-10)}T00:00:00Z`,
    prescription: PRESCRIPTION,
  }
}

test.describe('ending a medication (QA-01)', () => {
  test('the doctor confirms first, and the medication then ends today', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', {
      prescription: [PRESCRIPTION],
      medication_schedule: [amoxicillin(null)],
    })
    // The clinic's today, as the database reckons it.
    await page.route('**/rest/v1/rpc/app_today', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TODAY),
      }),
    )
    const patches: unknown[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        request.url().includes('/rest/v1/medication_schedule')
      ) {
        patches.push(request.postDataJSON())
      }
    })

    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    // Exact: the End button also names the medicine, for screen readers.
    await expect(page.getByText('Amoxicillin', { exact: true })).toBeVisible()
    await expect(page.getByText(/ongoing/)).toBeVisible()

    // Asked first, and told what it does.
    await page.getByRole('button', { name: /end medication/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('End this medication?')
    await expect(dialog).toContainText('Amoxicillin, 500mg.')
    await expect(dialog).toContainText('no longer scheduled')
    await expect(dialog).toContainText('not reminded')

    // Keeping it changes nothing.
    await dialog.getByRole('button', { name: /keep medication/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(patches).toHaveLength(0)
    await expect(page.getByText(/ongoing/)).toBeVisible()

    // Ending it sends the end date, and only that.
    await page.getByRole('button', { name: /end medication/i }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^end medication$/i })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(patches).toEqual([{ medication_schedule_end_date: TODAY }])

    // The list shows it ended, and there is nothing left to end.
    await expect(page.getByText(/until/)).toBeVisible()
    await expect(page.getByText(/ongoing/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /end medication/i })).toHaveCount(0)
  })

  test('the patient sees the ended medication and has no way to end it', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', { medication_schedule: [amoxicillin(TODAY)] })
    await page.goto('/patient/medications')

    await expect(page.getByText('Amoxicillin').first()).toBeVisible()
    await expect(page.getByText(/until/)).toBeVisible()
    await expect(page.getByRole('button', { name: /end medication/i })).toHaveCount(0)
  })
})
