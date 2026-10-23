import { expect, IDS, test } from './support/fixtures'

/**
 * Module 7.3 from the doctor's My profile page, in a real browser: their
 * appointment reminders turned off, saved on their own, and on again. Who may
 * change it, and what the reminder job does with it, is in
 * tests/db/doctor-reminder-setting.test.ts; the stub here stands in for the
 * database.
 */

test.describe('a doctor’s appointment reminder setting', () => {
  test('turns their reminders off and on, saving only that', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor')
    const sent: unknown[] = []
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes('/rest/v1/doctor')) {
        sent.push(JSON.parse(request.postData() ?? '{}'))
      }
    })
    await page.goto('/doctor/profile')

    const settings = page.getByRole('region', { name: 'Reminder settings' })
    const box = settings.getByRole('checkbox', {
      name: /send me a reminder the day before each appointment/i,
    })
    await expect(box).toBeChecked()

    await box.uncheck()
    await settings.getByRole('button', { name: 'Save reminder settings' }).click()

    await expect(settings.getByRole('status')).toHaveText('Appointment reminders are off.')
    const alan = () => stub.rowsIn('doctor').find((row) => row['doc_id'] === IDS.doctorA)
    expect(alan()).toMatchObject({
      doc_appointment_reminder_is_enabled: false,
      doc_first_name: 'Alan',
      doc_contact_no: '032 000 0000',
    })
    expect(sent).toEqual([{ doc_appointment_reminder_is_enabled: false }])

    // Reloaded from what is stored.
    await page.reload()
    await expect(box).not.toBeChecked()

    await box.check()
    await settings.getByRole('button', { name: 'Save reminder settings' }).click()
    await expect(settings.getByRole('status')).toHaveText('Appointment reminders are on.')
    expect(alan()?.['doc_appointment_reminder_is_enabled']).toBe(true)
    expect(sent).toHaveLength(2)
  })

  test('fits a 360px phone, beneath the profile details', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('doctor')
    await page.goto('/doctor/profile')
    await expect(page.getByRole('heading', { name: 'Reminder settings' })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
