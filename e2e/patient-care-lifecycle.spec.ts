import type { Page } from '@playwright/test'

import { datasetFor, expect, IDS, SupabaseStub, test } from './support/fixtures'

/**
 * The patient's care (migration 63) in a real browser against the stub. The
 * doctor manually discharges and reopens the PATIENT - whatever plans they
 * have - and sees Account and Care status apart; the patient, once
 * discharged, is told so where they would act, keeps their history and can
 * book a follow-up; reopened, the check-in form comes back and saves. Who
 * may do what is the database's (tests/db/patient-care-lifecycle.test.ts).
 */

const ENDED = 'Your care has ended. Book a follow-up if you need more care.'

const DISCHARGED_CARE = {
  pat_care_status: 'discharged',
  pat_care_closure_reason: 'completed_recovery',
  pat_care_discharged_at: '2026-03-10T03:00:00Z',
}

/** The role's dataset's patients, with Alice discharged (her plan still active). */
function patientsWithAliceDischarged(role: 'doctor' | 'patient') {
  return datasetFor(role)['patient']!.map((row) =>
    row['pat_id'] === IDS.alicePat ? { ...row, ...DISCHARGED_CARE } : row,
  )
}

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/sign-in$/)
}

test.describe('the doctor', () => {
  test('sees Account Status and Care Status as separate columns', async ({ page, signInAs }) => {
    await signInAs('doctor', { patient: patientsWithAliceDischarged('doctor') })
    await page.goto('/doctor/patients')
    const table = page.getByRole('table', { name: 'Patients assigned to you' })
    await expect(table.getByRole('columnheader', { name: 'Account Status' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'Care Status' })).toBeVisible()
    const rows = table.locator('tbody tr')
    const alice = rows.filter({ hasText: 'Alice Santos' })
    await expect(alice.locator('td').nth(3)).toHaveText('Active')
    await expect(alice.locator('td').nth(4)).toHaveText('Discharged')
    // The other patient is In Care by default, plan or no plan.
    const other = rows.filter({ hasNotText: 'Alice Santos' })
    await expect(other.locator('td').nth(4)).toHaveText('In Care')
  })

  test('discharges a patient with no treatment plan, with a reason, and reopens them', async ({ page, signInAs }) => {
    const stub = await signInAs('doctor', { treatment_plan: [] })
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    const careStatus = page.getByTestId('patient-care-status')
    await expect(careStatus).toContainText('In Care')

    await page.getByRole('button', { name: 'Discharge patient' }).click()
    const dialog = page.getByRole('dialog', { name: 'Discharge patient' })
    await expect(dialog.getByText(/reminders are not changed by a discharge/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Confirm discharge' }).click()
    await expect(dialog.getByText('Choose a reason for the discharge.')).toBeVisible()
    await dialog.getByLabel(/Closure reason/).selectOption('transferred')
    await dialog.getByRole('button', { name: 'Confirm discharge' }).click()

    await expect(page.getByText(/Discharged on .* · Transferred/)).toBeVisible()
    await expect(careStatus).toContainText('Discharged')
    expect(stub.requests.filter((request) => request.includes('doctor_discharge_patient_care'))).toHaveLength(1)
    // Nothing written directly to the patient row, and no plan touched.
    expect(stub.requests.filter((request) => /^PATCH (patient|treatment_plan)/.test(request))).toEqual([])

    // The care status stays visible on every tab.
    for (const tab of ['Recovery', 'Treatment', 'Medication', 'Notes', 'Chat', 'Overview']) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(careStatus).toContainText('Discharged')
      await expect(page.getByRole('button', { name: 'Reopen case' })).toBeVisible()
    }

    await page.getByRole('button', { name: 'Reopen case' }).click()
    await page.getByRole('dialog', { name: 'Reopen case' }).getByRole('button', { name: 'Reopen case' }).click()
    await expect(page.getByRole('button', { name: 'Discharge patient' })).toBeVisible()
    await expect(careStatus).toContainText('In Care')
  })

  test('offers no plan-level discharge and no plan editing while the patient is discharged', async ({ page, signInAs }) => {
    await signInAs('doctor', { patient: patientsWithAliceDischarged('doctor') })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)
    await expect(page.getByText('Post-operative knee recovery').first()).toBeVisible()
    // The plan keeps its own status, apart from the patient's care.
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Discharge patient' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Edit plan' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add goal' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start consultation' })).toBeDisabled()
  })

  test('sees a booking made after discharge as a follow-up after discharge', async ({ page, signInAs }) => {
    await signInAs('doctor', {
      appointment: [
        {
          appointment_id: IDS.appointmentA,
          pat_id: IDS.alicePat,
          doc_id: IDS.doctorA,
          appointment_date: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          appointment_status: 'scheduled',
          appointment_created_at: '2026-03-12T00:00:00Z',
          appointment_reminder_sent_at: null,
          appointment_follow_up_of_care_event_id: '00000000-0000-4000-8000-0000000000e1',
          appointment_follow_up_of_plan_id: null,
          patient: { pat_id: IDS.alicePat, pat_first_name: 'Alice', pat_last_name: 'Santos' },
        },
      ],
    })
    await page.goto('/doctor/appointments')
    await expect(page.getByText('Follow-up after discharge')).toBeVisible()
  })
})

test.describe('the patient once discharged', () => {
  test('is told so where they would act, keeps their records, and can book a follow-up', async ({ page, signInAs }) => {
    await signInAs('patient', {
      patient: patientsWithAliceDischarged('patient'),
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

    // The plan is still active; the patient's care is what ended.
    await page.goto('/patient/roadmap')
    await expect(page.getByText(ENDED)).toBeVisible()
    await expect(page.getByRole('button', { name: /as done/ })).toHaveCount(0)

    await page.goto('/patient/treatment')
    await expect(page.getByText(ENDED)).toBeVisible()
    await expect(page.getByText('Post-operative knee recovery').first()).toBeVisible()

    await page.goto('/patient')
    await expect(page.getByText(ENDED)).toBeVisible()
    await page.getByRole('link', { name: 'Book a follow-up' }).first().click()
    await expect(page).toHaveURL(/\/patient\/appointments$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
})

test.describe('the whole lifecycle, doctor to patient and back', () => {
  test('discharge stops the check-in; reopening brings the form back and a new check-in saves', async ({ page }) => {
    // One stub for every sign-in, so what the doctor does is what the
    // patient sees - no fixture stands in for the reopened state.
    const stub = new SupabaseStub(datasetFor('doctor'))
    await stub.install(page)

    // 1. The doctor discharges Alice.
    await signIn(page, 'doctor.a@recoverease.test')
    await expect(page).toHaveURL(/\/doctor$/)
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    await page.getByRole('button', { name: 'Discharge patient' }).click()
    const discharge = page.getByRole('dialog', { name: 'Discharge patient' })
    await discharge.getByLabel(/Closure reason/).selectOption('completed_recovery')
    await discharge.getByRole('button', { name: 'Confirm discharge' }).click()
    await expect(page.getByTestId('patient-care-status')).toContainText('Discharged')
    await signOut(page)

    // 2. Alice sees her care has ended, and cannot check in.
    await signIn(page, 'alice@recoverease.test')
    await expect(page).toHaveURL(/\/patient$/)
    await expect(page.getByText(ENDED).first()).toBeVisible()
    await page.goto('/patient/recovery')
    await expect(page.getByText(ENDED)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Log today' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /save entry/i })).toHaveCount(0)
    await signOut(page)

    // 3. The doctor reopens her care.
    await signIn(page, 'doctor.a@recoverease.test')
    await expect(page).toHaveURL(/\/doctor$/)
    await page.goto(`/doctor/patients/${IDS.alicePat}`)
    await page.getByRole('button', { name: 'Reopen case' }).click()
    await page.getByRole('dialog', { name: 'Reopen case' }).getByRole('button', { name: 'Reopen case' }).click()
    await expect(page.getByTestId('patient-care-status')).toContainText('In Care')
    await signOut(page)

    // 4. Alice revisits Recovery: the notice is gone, the form is back, and
    //    a new check-in saves.
    await signIn(page, 'alice@recoverease.test')
    await expect(page).toHaveURL(/\/patient$/)
    await page.goto('/patient/recovery')
    await expect(page.getByText(ENDED)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Log today|Edit today’s entry/ })).toBeVisible()
    await page.getByText('Good', { exact: true }).click()
    await page.getByLabel(/how was today/i).fill('Back in care and walking again.')
    await page.getByRole('button', { name: /save entry|update entry/i }).click()
    await expect(page.getByRole('status')).toContainText(/saved/i)
    await expect(page.locator('li').filter({ hasText: 'Back in care and walking again.' })).toBeVisible()

    expect(stub.requests.filter((request) => request.includes('doctor_discharge_patient_care'))).toHaveLength(1)
    expect(stub.requests.filter((request) => request.includes('doctor_reopen_patient_care'))).toHaveLength(1)
    expect(stub.requests.filter((request) => request === 'POST recovery_log')).toHaveLength(1)
  })
})

test.describe('reminders after discharge (migration 63 leaves them unchanged)', () => {
  test('still shows a discharged patient’s medicine and appointment reminders', async ({ page, signInAs }) => {
    const MIN = 60_000
    const now = Date.now()
    await signInAs('patient', {
      patient: patientsWithAliceDischarged('patient'),
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
            medication_schedule_reminders_is_enabled: true,
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
          appointment_follow_up_of_care_event_id: null,
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
