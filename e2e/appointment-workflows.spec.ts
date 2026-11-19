import { expect, IDS, test } from './support/fixtures'

/**
 * NA-01 to NA-05 — the appointment screens, in the browser.
 *
 * What the database allows and refuses is covered by the database suite.
 * Here: what each person is offered, what they are told when something
 * fails, and exactly what the page sends.
 */

function iso(days: number, hour = 10): string {
  const when = new Date()
  when.setDate(when.getDate() + days)
  when.setHours(hour, 0, 0, 0)
  return when.toISOString()
}

/** A `datetime-local` value, as the picker produces it. */
function localValue(days: number, hour = 10): string {
  const when = new Date(iso(days, hour))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`
}

const alice = { pat_id: IDS.alicePat, pat_first_name: 'Alice', pat_last_name: 'Santos' }

function appointment(id: string, when: string, status: string) {
  return {
    appointment_id: id,
    pat_id: IDS.alicePat,
    doc_id: IDS.doctorA,
    appointment_date: when,
    appointment_status: status,
    appointment_created_at: '2026-09-01T00:00:00Z',
    appointment_reminder_sent_at: null,
    patient: alice,
  }
}

function request(id: string, appointmentId: string, when: string, status: string) {
  return {
    reschedule_request_id: id,
    appointment_id: appointmentId,
    user_id: IDS.aliceUser,
    reschedule_request_date: iso(9),
    reschedule_request_reason: 'Work clash',
    reschedule_request_status: 'pending',
    reschedule_request_responded_at: null,
    reschedule_request_created_at: '2026-09-10T00:00:00Z',
    appointment: {
      appointment_id: appointmentId,
      appointment_date: when,
      appointment_status: status,
      pat_id: IDS.alicePat,
      patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
    },
  }
}

const failure = (message: string, status = 500, code = 'P0001') => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ code, details: null, hint: null, message }),
})

test.describe('appointment workflows (NA-01 to NA-05)', () => {
  test('NA-01 a past visit can be closed out, and a future one is not completed early', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', {
      appointment: [
        appointment('past-1', iso(-2), 'scheduled'),
        appointment(IDS.appointmentA, iso(3), 'scheduled'),
      ],
    })
    const patches: unknown[] = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes('/rest/v1/appointment')) patches.push(r.postDataJSON())
    })

    await page.goto('/doctor/appointments')

    // Only the visit that has happened can be closed out.
    await expect(page.getByRole('button', { name: /mark completed/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /mark no-show/i })).toHaveCount(1)
    // The future one can still be called off, and nothing more.
    await expect(page.getByRole('button', { name: /^cancel$/i })).toHaveCount(1)

    await page.getByRole('button', { name: /mark no-show/i }).click()
    await expect.poll(() => patches).toEqual([{ appointment_status: 'no_show' }])
    await expect(page.getByText('Missed')).toBeVisible()
    await expect(page.getByRole('button', { name: /mark no-show|mark completed/i })).toHaveCount(0)
  })

  test('NA-02 a failed action says so, and can be retried', async ({ page, signInAs }) => {
    const when = iso(4)
    await signInAs('doctor', {
      appointment: [appointment(IDS.appointmentA, when, 'scheduled')],
      reschedule_request: [request('rr-1', IDS.appointmentA, when, 'scheduled')],
    })
    let attempts = 0
    await page.route('**/rest/v1/reschedule_request**', async (route) => {
      if (route.request().method() === 'PATCH') {
        attempts += 1
        if (attempts === 1) {
          return route.fulfill(
            failure('duplicate key value violates unique constraint "appointment_one_active_per_slot"', 409, '23505'),
          )
        }
      }
      return route.fallback()
    })

    await page.goto('/doctor/appointments')
    await page.getByRole('button', { name: /approve and move/i }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The request was not approved')
    await expect(alert).not.toContainText(/duplicate key|constraint/)
    // No false success: the request is still there to decide.
    await expect(page.getByRole('button', { name: /approve and move/i })).toBeVisible()

    await page.getByRole('button', { name: /approve and move/i }).click()
    await expect(page.getByText('No requests are waiting for a decision.')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('NA-02 a failed cancellation keeps the confirmation open', async ({ page, signInAs }) => {
    await signInAs('patient')
    let attempts = 0
    await page.route('**/rest/v1/appointment**', async (route) => {
      if (route.request().method() === 'PATCH') {
        attempts += 1
        if (attempts === 1) return route.fulfill(failure('upstream unavailable'))
      }
      return route.fallback()
    })

    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: /^cancel$/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /cancel appointment/i }).click()

    await expect(dialog.getByRole('alert')).toContainText('The appointment was not cancelled')
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: /cancel appointment/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Cancelled').first()).toBeVisible()
  })

  test('NA-03 a request on a closed appointment is shown as closed, not decided', async ({
    page,
    signInAs,
  }) => {
    const when = iso(5)
    await signInAs('doctor', {
      appointment: [appointment(IDS.appointmentA, when, 'cancelled')],
      reschedule_request: [request('rr-1', IDS.appointmentA, when, 'cancelled')],
    })

    await page.goto('/doctor/appointments')
    await expect(page.getByText(/This appointment was cancelled, so it can no longer be moved/)).toBeVisible()
    await expect(page.getByRole('button', { name: /approve and move/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^decline$/i })).toBeVisible()
  })

  test('NA-03 the patient is not told a closed appointment is awaiting review', async ({
    page,
    signInAs,
  }) => {
    const when = iso(5)
    const { reschedule_request_id, appointment_id, user_id, reschedule_request_date } = request(
      'rr-1',
      IDS.appointmentA,
      when,
      'cancelled',
    )
    await signInAs('patient', {
      appointment: [appointment(IDS.appointmentA, when, 'cancelled')],
      reschedule_request: [
        {
          reschedule_request_id,
          appointment_id,
          user_id,
          reschedule_request_date,
          reschedule_request_reason: null,
          reschedule_request_status: 'pending',
          reschedule_request_responded_at: null,
          reschedule_request_created_at: '2026-09-10T00:00:00Z',
        },
      ],
    })

    await page.goto('/patient/appointments')
    await expect(page.getByText(/This appointment was cancelled, so your request to move it/)).toBeVisible()
    await expect(page.getByText('Awaiting review')).toHaveCount(0)
    await expect(page.getByText(/has not responded/)).toHaveCount(0)
  })

  test('NA-04 two rapid clicks book once, and the booking is reported as made', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    const posts: string[] = []
    await page.route('**/rest/v1/appointment**', async (route) => {
      if (route.request().method() === 'POST') posts.push(route.request().postData() ?? '')
      return route.fallback()
    })

    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: /book a follow-up/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/date and time/i).fill(localValue(10))

    // Both clicks dispatched before React can commit a disabled state.
    await page.evaluate(() => {
      const submit = [...document.querySelectorAll('button')].find((b) =>
        /^book appointment$/i.test((b.textContent || '').trim()),
      ) as HTMLButtonElement
      submit.click()
      submit.click()
    })

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(posts).toHaveLength(1)
    await expect(page.getByText(/was not booked/)).toHaveCount(0)
  })

  test('NA-04 two rapid clicks send one reschedule request', async ({ page, signInAs }) => {
    await signInAs('patient')
    const posts: string[] = []
    await page.route('**/rest/v1/reschedule_request**', async (route) => {
      if (route.request().method() === 'POST') posts.push(route.request().postData() ?? '')
      return route.fallback()
    })

    await page.goto('/patient/appointments')
    await page.getByRole('button', { name: /request new time/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/preferred new date and time/i).fill(localValue(12))

    await page.evaluate(() => {
      const submit = [...document.querySelectorAll('button')].find((b) =>
        /^send request$/i.test((b.textContent || '').trim()),
      ) as HTMLButtonElement
      submit.click()
      submit.click()
    })

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(posts).toHaveLength(1)
    await expect(page.getByText(/was not sent/)).toHaveCount(0)
  })

  test('NA-05 past times are refused before anything is sent, and a future time goes through', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    const posts: { table: string; body: Record<string, unknown> }[] = []
    page.on('request', (r) => {
      if (r.method() !== 'POST') return
      if (r.url().includes('/rest/v1/appointment')) posts.push({ table: 'appointment', body: r.postDataJSON() })
      if (r.url().includes('/rest/v1/reschedule_request')) posts.push({ table: 'reschedule_request', body: r.postDataJSON() })
    })

    await page.goto('/patient/appointments')

    // Booking.
    await page.getByRole('button', { name: /book a follow-up/i }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel(/date and time/i).fill('2024-01-15T09:00')
    await dialog.getByRole('button', { name: /^book appointment$/i }).click()
    await expect(dialog.getByText('Choose a time in the future.')).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(posts).toHaveLength(0)

    await dialog.getByLabel(/date and time/i).fill(localValue(14))
    await dialog.getByRole('button', { name: /^book appointment$/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0]!.table).toBe('appointment')
    expect(new Date(String(posts[0]!.body['appointment_date'])).getTime()).toBeGreaterThan(Date.now())

    // Reschedule request.
    await page.getByRole('button', { name: /request new time/i }).first().click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel(/preferred new date and time/i).fill('2024-02-01T09:00')
    await dialog.getByRole('button', { name: /^send request$/i }).click()
    await expect(dialog.getByText('Choose a time in the future.')).toBeVisible()
    expect(posts).toHaveLength(1)

    await dialog.getByLabel(/preferred new date and time/i).fill(localValue(16))
    await dialog.getByRole('button', { name: /^send request$/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => posts.length).toBe(2)
    expect(posts[1]!.table).toBe('reschedule_request')
  })
})
