import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * The 2nd-half plan, section 6, in a real browser: the in-app reminder of a
 * dose the server has just reminded the patient of, and of an appointment
 * about to start. Checked here what only a browser can show: that it appears
 * without taking focus, that acting on it writes what it says, and that it
 * never sits on top of what the person is using - the bottom bar on a phone,
 * the end of the page, or the chat's message box. The record is served by
 * the browser-only stub.
 */

const MIN = 60_000

/** A dose due in eight minutes, which the server reminded two minutes ago. */
function remindedDose() {
  const now = Date.now()
  return {
    medication_log_id: IDS.doseA,
    medication_schedule_id: IDS.scheduleA,
    medication_log_scheduled_at: new Date(now + 8 * MIN).toISOString(),
    medication_log_taken_at: null,
    medication_log_status: 'pending',
    medication_log_follow_up_sent_at: null,
    medication_log_pre_dose_sent_at: new Date(now - 2 * MIN).toISOString(),
    medication_schedule: {
      medication_schedule_id: IDS.scheduleA,
      medication_schedule_name: 'Paracetamol',
      medication_schedule_dosage: '500mg',
      prescription: { pat_id: IDS.alicePat },
    },
  }
}

const card = (page: Page) => page.getByRole('region', { name: 'Reminders' })

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test.describe('the reminder card', () => {
  test('appears for a reminded dose without taking focus, and marks it taken', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient', { medication_log: [remindedDose()] })
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/medication_log') && request.method() === 'PATCH') {
        writes.push(request.postData() ?? '')
      }
    })

    await page.goto('/patient')
    await expect(card(page)).toBeVisible()
    await expect(card(page)).toContainText(/Medication due in [78] minutes/)
    await expect(card(page)).toContainText('Paracetamol 500mg at')
    // Nothing in the card has focus: it never takes it.
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('section[aria-label="Reminders"]'))),
    ).toBe(false)

    await card(page).getByRole('button', { name: 'Mark taken: Paracetamol' }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toContain('"medication_log_status":"taken"')
  })

  test('dismisses with Escape', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient', { medication_log: [remindedDose()] })
    await page.goto('/patient')
    await card(page).getByRole('button', { name: 'Remind me in 5 min: Paracetamol' }).focus()
    await page.keyboard.press('Escape')
    await expect(card(page)).toBeHidden()
  })

  test('on a phone, sits above the bottom bar and leaves the end of the page reachable', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await signInAs('patient', { medication_log: [remindedDose()] })
    await page.goto('/patient')
    await expect(card(page)).toBeVisible()
    // The whole dashboard, not just the card: its other sections load too.
    await expect(page.getByRole('heading', { name: 'Your recovery' })).toBeVisible()
    await page.waitForLoadState('networkidle')

    const tray = (await card(page).boundingBox())!
    const bar = (await page.locator('[data-bottom-nav]').boundingBox())!
    expect(overlaps(tray, bar)).toBe(false)
    expect(tray.y + tray.height).toBeLessThanOrEqual(bar.y)

    // Scrolled to the very end, the page's content ends above the card: the
    // page keeps the card's space as padding under it.
    // Instantly: the page scrolls smoothly where motion is allowed.
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    )
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const contentEnd = await page.evaluate(() => {
      const main = document.getElementById('main-content')!
      const padding = parseFloat(getComputedStyle(main).paddingBottom)
      return main.getBoundingClientRect().bottom - padding
    })
    const trayAfterScroll = (await card(page).boundingBox())!
    expect(contentEnd).toBeLessThanOrEqual(trayAfterScroll.y + 1)
  })

  test('on a phone, several doses at once take at most half the screen, and each stays reachable', async ({ page, signInAs }) => {
    // Five medicines due within minutes of each other: usual after an operation.
    await page.setViewportSize({ width: 375, height: 667 })
    const medicines = ['Amoxicillin', 'Paracetamol', 'Ibuprofen', 'Omeprazole', 'Cefalexin']
    const now = Date.now()
    await signInAs('patient', {
      medication_log: medicines.map((name, index) => {
        const dose = remindedDose()
        return {
          ...dose,
          medication_log_id: `dose-${index}`,
          medication_log_scheduled_at: new Date(now + (3 + index) * MIN).toISOString(),
          medication_schedule: { ...dose.medication_schedule, medication_schedule_name: name },
        }
      }),
    })
    await page.goto('/patient')
    await expect(card(page).getByRole('listitem')).toHaveCount(5)

    const tray = (await card(page).boundingBox())!
    expect(tray.height).toBeLessThanOrEqual(667 / 2 + 1)
    expect(tray.y).toBeGreaterThanOrEqual(0)

    // The soonest is first; it and the last can both be brought into view.
    for (const name of [medicines[0], medicines.at(-1)]) {
      const markTaken = card(page).getByRole('button', { name: `Mark taken: ${name}` })
      await markTaken.scrollIntoViewIfNeeded()
      await expect(markTaken).toBeInViewport({ ratio: 1 })
    }
  })

  test('keeps clear of the chat’s message box', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('patient', { medication_log: [remindedDose()] })
    await page.goto('/patient/chat')
    await expect(card(page)).toBeVisible()

    const tray = (await card(page).boundingBox())!
    const send = (await page.getByRole('button', { name: /send message/i }).boundingBox())!
    const box = (await page.getByLabel(/your message/i).boundingBox())!
    expect(overlaps(tray, send)).toBe(false)
    expect(overlaps(tray, box)).toBe(false)
  })

  test('reminds a doctor of an appointment about to start, with the record a step away', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signInAs('doctor', {
      appointment: [
        {
          appointment_id: 'ap-soon',
          pat_id: IDS.alicePat,
          doc_id: IDS.doctorA,
          appointment_date: new Date(Date.now() + 8 * MIN).toISOString(),
          appointment_status: 'confirmed',
          appointment_created_at: new Date(Date.now() - 86_400_000).toISOString(),
          appointment_reminder_sent_at: null,
          patient: { pat_id: IDS.alicePat, pat_first_name: 'Alice', pat_last_name: 'Santos' },
        },
      ],
    })
    await page.goto('/doctor')

    await expect(card(page)).toContainText(/Appointment in [78] minutes/)
    await expect(card(page)).toContainText('Alice Santos')
    await card(page).getByRole('link', { name: 'Open record' }).click()
    await expect(page).toHaveURL(new RegExp(`/doctor/patients/${IDS.alicePat}$`))
  })
})
