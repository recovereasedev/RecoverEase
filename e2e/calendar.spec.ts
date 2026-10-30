import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * Module 6.2 "View Appointment Calendar" in a real browser, for the patient
 * and for the doctor: the month, today's records, the keyboard moving
 * through the days, a phone's width, and nothing written. The records are
 * the browser-only stub's; the clinic and this browser both keep Manila time,
 * so a dose at 08:00 is 08:00 on the calendar.
 */

test.use({ timezoneId: 'Asia/Manila' })

const CLINIC = {
  clinic_id: IDS.clinic,
  clinic_name: 'Harborview Recovery Clinic',
  clinic_status: 'active',
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-01-01T00:00:00Z',
  clinic_updated_at: '2026-01-01T00:00:00Z',
}

function dayKey(offsetDays: number): string {
  const when = new Date()
  when.setDate(when.getDate() + offsetDays)
  return [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-')
}

const TODAY_LOG = {
  recovery_log_id: 'rl-e2e-today',
  pat_id: IDS.alicePat,
  recovery_log_date: dayKey(0),
  recovery_log_notes: 'Walked to the corner shop.',
  recovery_log_mood_rating: 4,
  recovery_log_created_at: new Date().toISOString(),
}

function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

function watchForWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if ((url.includes('/rest/v1/') || url.includes('/functions/v1/')) && request.method() !== 'GET' && request.method() !== 'HEAD') {
      writes.push(`${request.method()} ${url}`)
    }
  })
  return writes
}

const agenda = (page: Page) =>
  page.getByRole('region', { name: /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) / })

test.describe('the calendar', () => {
  test('the patient sees today’s medicine, check-in and the coming appointment', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await signInAs('patient', { clinic: [CLINIC], recovery_log: [TODAY_LOG] })
    await page.goto('/patient/calendar')

    const grid = page.getByRole('grid')
    await expect(grid).toBeVisible()
    const today = grid.locator('button[aria-current="date"]')
    await expect(today).toHaveAccessibleName(/, today: 1 medicine dose, 1 mood check-in$/)

    const panel = agenda(page)
    await expect(panel).toContainText('Today')
    await expect(panel).toContainText('Mood check-in')
    await expect(panel).toContainText('Good (4 of 5)')
    await expect(panel.getByRole('listitem').filter({ hasText: 'Paracetamol, 500mg' })).toContainText('08:00')

    // Three days on, by keyboard, is the appointment - into next month's
    // grid if that is where it falls.
    await today.focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
    await expect(page.locator(`[data-day="${dayKey(3)}"]`)).toBeFocused()
    await expect(panel.getByRole('listitem').filter({ hasText: 'Appointment' })).toContainText('10:00')
    await expect(panel).toContainText('With Dr. Alan Cruz')
    await expect(panel).toContainText('Scheduled')

    // The legend says each kind in words.
    await expect(page.getByRole('list', { name: 'What the calendar shows' })).toHaveText(
      /Medicine\s*Appointment\s*Mood check-in/,
    )
    // Same zone on both clocks, so no note about time zones.
    await expect(page.getByText(/time zone/)).toHaveCount(0)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })

  test('the patient reaches it from the navigation', async ({ page, signInAs }) => {
    await signInAs('patient', { clinic: [CLINIC] })
    await page.goto('/patient')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calendar' }).click()
    await expect(page).toHaveURL(/\/patient\/calendar$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible()
  })

  test('fits a phone’s width with nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('patient', { clinic: [CLINIC], recovery_log: [TODAY_LOG] })
    await page.goto('/patient/calendar')
    await expect(page.getByRole('grid')).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    // Every day is still a target a finger can hit.
    const box = await page.locator('button[aria-current="date"]').boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(40)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('the doctor sees their appointments, linked to the patient’s record', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const writes = watchForWrites(page)
    await signInAs('doctor', { clinic: [CLINIC] })
    await page.goto('/doctor/calendar')

    // Three days on, which may be in next month's grid: the keyboard goes there.
    await page.getByRole('grid').locator('button[aria-current="date"]').focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
    await expect(page.locator(`[data-day="${dayKey(3)}"]`)).toBeFocused()
    const panel = agenda(page)
    await expect(panel.getByRole('listitem').filter({ hasText: 'Appointment' })).toContainText('10:00')
    await expect(panel).toContainText('With Alice Santos')
    await expect(panel.getByRole('link', { name: 'Open patient record' })).toHaveAttribute(
      'href',
      `/doctor/patients/${IDS.alicePat}`,
    )
    await expect(page.getByRole('link', { name: 'Manage appointments' })).toHaveAttribute(
      'href',
      '/doctor/appointments',
    )
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })
})
