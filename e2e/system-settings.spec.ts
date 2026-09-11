import { expect, IDS, test } from './support/fixtures'

/**
 * QA-03 — the missed-dose grace period, in the browser.
 *
 * What the overdue job does with the value is covered by the database suite.
 * Here: the administrator sees the stored value, a usable one is sent as
 * typed, and one the job could not use is refused before anything is sent.
 */

const GRACE = 'medication.reminder_grace_hours'

const SETTINGS = [
  {
    system_setting_id: 'set-1',
    admin_id: IDS.admin,
    system_setting_key: 'app.timezone',
    system_setting_value: 'Asia/Manila',
    system_setting_updated_at: '2026-03-01T00:00:00Z',
  },
  {
    system_setting_id: 'set-2',
    admin_id: IDS.admin,
    system_setting_key: GRACE,
    system_setting_value: '6',
    system_setting_updated_at: '2026-03-01T00:00:00Z',
  },
]

test.describe('missed dose grace period (QA-03)', () => {
  test('the administrator sets it, and a value the job cannot use is refused', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin', { system_setting: SETTINGS })
    const writes: unknown[] = []
    page.on('request', (request) => {
      if (
        request.url().includes('/rest/v1/system_setting') &&
        ['POST', 'PATCH'].includes(request.method())
      ) {
        writes.push(request.postDataJSON())
      }
    })

    await page.goto('/admin/settings')
    const grace = page.getByLabel('Missed dose grace period (hours)', { exact: true })
    const form = page.locator('form').filter({ has: grace })

    // The stored value.
    await expect(grace).toHaveValue('6')

    // A usable value is sent, and only that.
    await grace.fill('2')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(() => writes)
      .toEqual([
        {
          admin_id: IDS.admin,
          system_setting_key: GRACE,
          system_setting_value: '2',
        },
      ])

    // One the job could not use is refused, with the reason, and not sent.
    for (const value of ['0', '25', '1.5', 'abc']) {
      await grace.fill(value)
      await form.getByRole('button', { name: 'Save' }).click()
      await expect(form.getByRole('alert')).toHaveText(
        'Enter a whole number of hours from 1 to 24.',
      )
      await expect(grace).toHaveAttribute('aria-invalid', 'true')
    }
    expect(writes).toHaveLength(1)
  })
})
