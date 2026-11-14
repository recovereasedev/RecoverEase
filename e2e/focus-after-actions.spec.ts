import type { Locator, Page } from '@playwright/test'

import { expect, IDS, test } from './support/fixtures'

/**
 * Where keyboard focus goes when the control that had it goes away (after
 * PR #15, which kept focus on a saving button).
 *
 * A dialog removed while open is closed first, so focus returns to the
 * control that opened it. A row action that leaves with its row hands focus
 * to the next action. An inline form, saved or cancelled, hands it back to the
 * control that opened it. A goal's progress button is held busy while it saves
 * rather than disabled. And "Mark read" sends one request however fast it is pressed.
 */

/** Activates a control the way a keyboard user does. */
async function pressWithKeyboard(page: Page, control: Locator) {
  await page.keyboard.press('Shift')
  await control.focus()
  await page.keyboard.press('Enter')
}

/** Holds each write to a table long enough to look at the page mid-save. */
async function slowWrites(page: Page, table: string) {
  const writes: string[] = []
  await page.route(`**/rest/v1/${table}**`, async (route) => {
    const method = route.request().method()
    if (method !== 'GET' && method !== 'HEAD') {
      writes.push(method)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await route.fallback()
  })
  return writes
}

/**
 * Holds each write to a table until the test releases it, so the page can be
 * checked, and acted on, mid-save for as long as that takes. A fixed delay is
 * not enough for that: on a slow run the checks outlast it, the save ends
 * first, and a change meant for "while it saves" arrives after it.
 */
async function heldWrites(page: Page, table: string) {
  const writes: string[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/rest/v1/${table}**`, async (route) => {
    const method = route.request().method()
    if (method !== 'GET' && method !== 'HEAD') {
      writes.push(method)
      await released
    }
    await route.fallback()
  })
  return { writes, release }
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const pastScheduled = (id: string, daysAgo: number) => ({
  appointment_id: id,
  pat_id: IDS.alicePat,
  doc_id: IDS.doctorA,
  appointment_date: daysFromNow(-daysAgo),
  appointment_status: 'scheduled',
  appointment_created_at: daysFromNow(-9),
  appointment_reminder_sent_at: null,
  patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
})

const pendingRequest = (id: string) => ({
  reschedule_request_id: id,
  appointment_id: IDS.appointmentA,
  user_id: IDS.aliceUser,
  reschedule_request_date: daysFromNow(5),
  reschedule_request_reason: 'I have physiotherapy that morning.',
  reschedule_request_status: 'pending',
  reschedule_request_created_at: daysFromNow(0),
  appointment: {
    appointment_id: IDS.appointmentA,
    appointment_date: daysFromNow(3),
    appointment_status: 'scheduled',
    pat_id: IDS.alicePat,
    patient: { pat_first_name: 'Alice', pat_last_name: 'Santos' },
  },
})

test.describe('dialogs return focus to the control that opened them', () => {
  test('patient: "Keep appointment" returns to Cancel; cancelling moves on to "Book a follow-up"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient')
    await page.goto('/patient/appointments')
    const cancel = page.getByRole('button', { name: /^cancel$/i }).first()

    await pressWithKeyboard(page, cancel)
    await pressWithKeyboard(page, page.getByRole('dialog').getByRole('button', { name: /keep appointment/i }))
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(cancel).toBeFocused()

    await pressWithKeyboard(page, cancel)
    await pressWithKeyboard(page, page.getByRole('dialog').getByRole('button', { name: /cancel appointment/i }))
    // Its appointment cancelled, the Cancel it came back to has gone too.
    await expect(page.getByRole('button', { name: /book a follow-up/i }).first()).toBeFocused()
  })

  test('doctor: "Keep medication" returns to End medication', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      medication_schedule: [
        {
          medication_schedule_id: IDS.scheduleA,
          prescription_id: IDS.prescriptionA,
          medication_schedule_name: 'Paracetamol',
          medication_schedule_dosage: '500mg',
          medication_schedule_frequency: 2,
          medication_schedule_times: ['08:00:00', '20:00:00'],
          medication_schedule_start_date: '2026-02-01',
          medication_schedule_end_date: null,
          medication_schedule_created_at: '2026-02-01T00:00:00Z',
          prescription: {
            prescription_id: IDS.prescriptionA,
            prescription_issued_date: '2026-02-01',
            prescription_notes: 'Take with food.',
            pat_id: IDS.alicePat,
          },
        },
      ],
    })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    const end = page.getByRole('button', { name: /^end medication:/i }).first()

    await pressWithKeyboard(page, end)
    await pressWithKeyboard(page, page.getByRole('dialog').getByRole('button', { name: /keep medication/i }))

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(end).toBeFocused()
  })

  test('admin: deleting the last announcement moves on to "New announcement"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('admin')
    await page.goto('/admin/announcements')

    await pressWithKeyboard(page, page.getByRole('button', { name: /^delete/i }).first())
    await pressWithKeyboard(page, page.getByRole('dialog').getByRole('button', { name: /delete permanently/i }))

    await expect(page.getByRole('button', { name: /new announcement/i }).first()).toBeFocused()
  })
})

test.describe('row actions hand focus to the next action', () => {
  test('Mark completed moves on to the next visit’s action', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      appointment: [pastScheduled('ap-past-1', 2), pastScheduled('ap-past-2', 4)],
    })
    await slowWrites(page, 'appointment')
    await page.goto('/doctor/appointments')
    const first = page.getByRole('button', { name: /mark completed/i }).first()

    await pressWithKeyboard(page, first)
    await expect(page.getByRole('button', { name: /mark completed/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /mark completed/i })).toBeFocused()
  })

  test('Approve and move moves on to the next request', async ({ page, signInAs }) => {
    await signInAs('doctor', { reschedule_request: [pendingRequest('rr-1'), pendingRequest('rr-2')] })
    await slowWrites(page, 'reschedule_request')
    await page.goto('/doctor/appointments')

    await pressWithKeyboard(page, page.getByRole('button', { name: /approve and move/i }).first())

    await expect(page.getByRole('button', { name: /approve and move/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /approve and move/i })).toBeFocused()
  })
})

test.describe('inline forms hand focus back to the control that opened them', () => {
  test('Save plan returns to "Edit plan"', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await slowWrites(page, 'treatment_plan')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)
    const edit = page.getByRole('button', { name: /edit plan/i }).first()

    await pressWithKeyboard(page, edit)
    await pressWithKeyboard(page, page.getByRole('button', { name: /save plan/i }))

    await expect(page.getByRole('button', { name: /save plan/i })).toHaveCount(0)
    await expect(edit).toBeFocused()
  })

  test('a first plan, created, hands focus to its "Edit plan"; cancelled, back to "Create treatment plan"', async ({
    page,
    signInAs,
  }) => {
    await signInAs('doctor', { treatment_plan: [] })
    await slowWrites(page, 'treatment_plan')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)
    const create = page.getByRole('button', { name: /^create treatment plan$/i })

    await pressWithKeyboard(page, create)
    await pressWithKeyboard(page, page.getByRole('button', { name: /^cancel$/i }))
    await expect(create).toBeFocused()

    await pressWithKeyboard(page, create)
    await page.getByLabel(/plan title/i).fill('Knee rehabilitation')
    await pressWithKeyboard(page, page.getByRole('button', { name: /^create treatment plan$/i }))

    await expect(page.getByRole('button', { name: /edit plan/i })).toBeFocused()
  })

  test('cancelling the medication form returns to its button', async ({ page, signInAs }) => {
    await signInAs('doctor')
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=medication`)
    const add = page.getByRole('button', { name: /add another medicine|add prescription/i })

    await pressWithKeyboard(page, add)
    await pressWithKeyboard(page, page.getByRole('button', { name: /^cancel$/i }))

    await expect(add).toBeFocused()
  })
})

test('a goal’s progress button keeps focus while it saves, takes no second press, and focus stays on the goal', async ({
  page,
  signInAs,
}) => {
  // Migration 55: the patient records progress; the doctor's select is gone.
  const stub = await signInAs('patient')
  stub.setRpcHandler('patient_update_treatment_goal_status', (args) => {
    const goal = stub
      .rowsIn('treatment_plan')
      .flatMap((plan) => plan['treatment_goal'] as Record<string, unknown>[])
      .find((row) => row['treatment_goal_id'] === args['target_goal_id'])!
    goal['treatment_goal_status'] = args['new_status']
    return { result: goal }
  })
  const { writes, release } = await heldWrites(page, 'rpc/patient_update_treatment_goal_status')
  await page.goto('/patient/treatment')
  const achieve = page.getByRole('button', { name: 'Mark achieved: Walk 500 metres unaided' })

  await pressWithKeyboard(page, achieve)
  await expect(achieve).toHaveAttribute('aria-busy', 'true')
  await expect(achieve).toBeFocused()
  // Held, not disabled: a second press while it saves is not taken.
  await page.keyboard.press('Enter')

  release()
  await expect(achieve).toHaveCount(0)
  expect(writes).toHaveLength(1)
  // The button is gone with the goal achieved; focus stays on that goal.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
})

test('Mark read sends one request however fast it is pressed', async ({ page, signInAs }) => {
  await signInAs('patient', {
    notification: [
      {
        notification_id: 'n-1',
        user_id: IDS.aliceUser,
        chat_session_id: null,
        notification_type: 'general',
        notification_message: 'Please bring your medication list.',
        notification_is_read: false,
        notification_created_at: daysFromNow(0),
      },
    ],
  })
  const writes = await slowWrites(page, 'notification')
  await page.goto('/patient/notifications')

  await page.getByRole('button', { name: /^mark read/i }).dblclick()

  await expect(page.getByRole('button', { name: /^mark read/i })).toHaveCount(0)
  expect(writes).toHaveLength(1)
})
