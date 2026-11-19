import { expect, IDS, test } from './support/fixtures'

/**
 * Discharge and reopen (migration 61) in a real browser against the
 * stub: the doctor discharges an active plan with a reason and reopens it;
 * sees a follow-up request booked after discharge; and the
 * patient, once their care has ended, is told so where they would log a
 * check-in, keeps their history, and can book a follow-up. Who may do what
 * is the database's (tests/db/discharge-care-plan.test.ts).
 */

const ENDED = 'Your care plan has ended. Book a follow-up if you need more care.'

const plan = (status: string, extra: Record<string, unknown> = {}) => ({
  treatment_plan_id: IDS.planA,
  pat_id: IDS.alicePat,
  doc_id: IDS.doctorA,
  treatment_plan_title: 'Post-operative knee recovery',
  treatment_plan_description: 'Twelve week programme.',
  treatment_plan_start_date: '2026-02-01',
  treatment_plan_end_date: null,
  treatment_plan_status: status,
  treatment_plan_created_at: '2026-02-01T00:00:00Z',
  treatment_plan_updated_at: '2026-02-01T00:00:00Z',
  treatment_plan_closure_reason: null,
  treatment_plan_discharged_at: null,
  treatment_goal: [],
  ...extra,
})

const DISCHARGED = plan('discharged', {
  treatment_plan_closure_reason: 'completed_recovery',
  treatment_plan_discharged_at: '2026-03-10T03:00:00Z',
})

test.describe('the doctor', () => {
  test('discharges an active plan with a reason, and reopens it', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor', { treatment_plan: [plan('active')] })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)

    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/ready for discharge/i)).toHaveCount(0)
    await page.getByRole('button', { name: 'Discharge patient' }).click()
    const dialog = page.getByRole('dialog', { name: 'Discharge patient' })
    await expect(dialog.getByText(/ends this care plan/)).toBeVisible()
    // Reminders are not part of this release (migration 61): the dialog says so.
    await expect(dialog.getByText(/reminders are not changed by a discharge/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Confirm discharge' }).click()
    await expect(dialog.getByText('Choose a reason for the discharge.')).toBeVisible()
    await dialog.getByLabel(/Closure reason/).selectOption('transferred')
    await dialog.getByRole('button', { name: 'Confirm discharge' }).click()

    await expect(page.getByText(/Discharged on .* · Transferred/)).toBeVisible()
    expect(stub.requests.filter((request) => request.includes('doctor_discharge_treatment_plan'))).toHaveLength(1)
    // No direct write to the plan's status.
    expect(stub.requests.filter((request) => /^PATCH treatment_plan/.test(request))).toEqual([])

    await page.getByRole('button', { name: 'Reopen case' }).first().click()
    await page.getByRole('dialog', { name: 'Reopen case' }).getByRole('button', { name: 'Reopen case' }).click()
    await expect(page.getByRole('button', { name: 'Discharge patient' })).toBeVisible()
    await expect(page.getByText(/Discharged on/)).toHaveCount(0)
  })

  test('sees a follow-up booked after discharge marked as a follow-up request', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      treatment_plan: [DISCHARGED],
      appointment: [
        {
          appointment_id: IDS.appointmentA,
          pat_id: IDS.alicePat,
          doc_id: IDS.doctorA,
          appointment_date: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          appointment_status: 'scheduled',
          appointment_created_at: '2026-03-12T00:00:00Z',
          appointment_reminder_sent_at: null,
          appointment_follow_up_of_plan_id: IDS.planA,
          patient: { pat_id: IDS.alicePat, pat_first_name: 'Alice', pat_last_name: 'Santos' },
        },
      ],
    })
    await page.goto('/doctor/appointments')
    await expect(page.getByText('Follow-up request')).toBeVisible()
  })
})

test.describe('the patient once care has ended', () => {
  test('is told where they would log a check-in, keeps their records, and can book a follow-up', async ({ page, signInAs }) => {
    await signInAs('patient', {
      treatment_plan: [DISCHARGED],
      recovery_log: [
        {
          recovery_log_id: 'log-1',
          pat_id: IDS.alicePat,
          recovery_log_date: '2026-03-05',
          recovery_log_notes: 'Walked to the market',
          recovery_log_mood_rating: 4,
          recovery_log_created_at: '2026-03-05T02:00:00Z',
        },
      ],
    })

    await page.goto('/patient/recovery')
    await expect(page.getByText(ENDED)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Log today' })).toHaveCount(0)
    await expect(page.getByText('Walked to the market')).toBeVisible()

    await page.goto('/patient/roadmap')
    await expect(page.getByText(ENDED)).toBeVisible()

    await page.goto('/patient/treatment')
    await expect(page.getByText(ENDED)).toBeVisible()
    await expect(page.getByText('Discharged', { exact: true }).first()).toBeVisible()

    await page.goto('/patient')
    await expect(page.getByText(ENDED)).toBeVisible()
    await page.getByRole('link', { name: 'Book a follow-up' }).click()
    await expect(page).toHaveURL(/\/patient\/appointments$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('logs again once the doctor has reopened the case', async ({ page, signInAs }) => {
    await signInAs('patient', { treatment_plan: [plan('active')] })
    await page.goto('/patient/recovery')
    await expect(page.getByRole('heading', { name: 'Log today' })).toBeVisible()
    await expect(page.getByText(ENDED)).toHaveCount(0)
  })
})

test.describe('reminders after discharge (migration 61 leaves them unchanged)', () => {
  test('still shows a discharged patient’s medicine and appointment reminders', async ({ page, signInAs }) => {
    const MIN = 60_000
    const now = Date.now()
    await signInAs('patient', {
      treatment_plan: [DISCHARGED],
      medication_log: [
        {
          medication_log_id: '00000000-0000-4000-8000-0000000000d1',
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
        },
      ],
      appointment: [
        {
          appointment_id: '00000000-0000-4000-8000-0000000000a1',
          pat_id: IDS.alicePat,
          doc_id: IDS.doctorA,
          appointment_date: new Date(now + 9 * MIN).toISOString(),
          appointment_status: 'scheduled',
          appointment_created_at: '2026-03-12T00:00:00Z',
          appointment_reminder_sent_at: null,
          appointment_follow_up_of_plan_id: null,
          patient: { pat_id: IDS.alicePat, pat_first_name: 'Alice', pat_last_name: 'Santos' },
        },
      ],
    })
    await page.goto('/patient')
    const card = page.getByRole('region', { name: 'Reminders' })
    await expect(card).toContainText('Paracetamol 500mg at')
    await expect(card).toContainText(/Appointment in (8|9) minutes/)
  })
})
