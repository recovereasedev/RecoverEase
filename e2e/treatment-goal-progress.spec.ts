import { expect, IDS, test, type Page } from './support/fixtures'
import type { SupabaseStub } from './support/supabase-stub'

/**
 * Treatment goals end to end in a real browser against the stub (migration
 * 55): the doctor sets a goal and monitors it; the patient starts it and
 * marks it achieved; a goal the system marked missed reads as missed to both.
 * Who may do what, and the missed job itself, are the database's
 * (tests/db/treatment-goal-progress.test.ts); this is what each screen does.
 */

/** A `YYYY-MM-DD` day `days` from today, in this machine's zone. */
function dayFromToday(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const goal = (id: string, description: string, status: string, target: string | null) => ({
  treatment_goal_id: id,
  treatment_plan_id: IDS.planA,
  treatment_goal_description: description,
  treatment_goal_target_date: target,
  treatment_goal_status: status,
  treatment_goal_created_at: '2026-02-01T00:00:00Z',
  recovery_phase_id: null,
})

const PLAN = () => ({
  treatment_plan: [
    {
      treatment_plan_id: IDS.planA,
      pat_id: IDS.alicePat,
      doc_id: IDS.doctorA,
      treatment_plan_title: 'Post-operative knee recovery',
      treatment_plan_description: null,
      treatment_plan_start_date: '2026-02-01',
      treatment_plan_end_date: null,
      treatment_plan_status: 'active',
      treatment_plan_created_at: '2026-02-01T00:00:00Z',
      treatment_plan_updated_at: '2026-02-01T00:00:00Z',
      treatment_plan_follow_up_appointment_id: null,
      treatment_goal: [
        goal('goal-new', 'Climb one flight of stairs', 'pending', dayFromToday(14)),
        // What the scheduled job leaves once the date has passed.
        goal('goal-late', 'Walk 500 metres unaided', 'missed', '2026-03-01'),
      ],
    },
  ],
  treatment_goal_status_event: [],
})

const CLINIC = {
  clinic_id: IDS.clinic,
  clinic_name: 'Harborview Recovery Clinic',
  clinic_status: 'active',
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-01-01T00:00:00Z',
  clinic_updated_at: '2026-01-01T00:00:00Z',
}

const ALLOWED: Record<string, string[]> = {
  pending: ['in_progress', 'achieved'],
  in_progress: ['achieved'],
  missed: ['achieved'],
  achieved: [],
}

/** The patient's function as the browser sees it: the goal with its new status, or the refusal. */
function modelProgress(stub: SupabaseStub): void {
  stub.setRpcHandler('patient_update_treatment_goal_status', (args) => {
    const goals = stub.rowsIn('treatment_plan').flatMap(
      (plan) => plan['treatment_goal'] as Record<string, unknown>[],
    )
    const row = goals.find((candidate) => candidate['treatment_goal_id'] === args['target_goal_id'])
    if (!row) {
      return { status: 403, error: { code: '42501', message: 'Only the patient can record progress on their own goal' } }
    }
    const next = String(args['new_status'])
    if (!ALLOWED[String(row['treatment_goal_status'])]!.includes(next)) {
      return { status: 400, error: { code: '23514', message: `This goal cannot move from ${String(row['treatment_goal_status'])} to ${next}` } }
    }
    row['treatment_goal_status'] = next
    return { result: row }
  })
}

function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test.describe('the patient’s treatment goals', () => {
  test('starts a goal, then marks it achieved, with one call each and no direct write', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    const stub = await signInAs('patient', PLAN())
    modelProgress(stub)
    await page.goto('/patient/treatment')

    const start = page.getByRole('button', { name: 'Start goal: Climb one flight of stairs' })
    await start.click()
    await expect(page.getByRole('button', { name: 'Start goal: Climb one flight of stairs' })).toHaveCount(0)
    await expect(page.getByText('In progress')).toBeVisible()

    await page.getByRole('button', { name: 'Mark achieved: Climb one flight of stairs' }).click()
    await expect(page.getByRole('button', { name: 'Mark achieved: Climb one flight of stairs' })).toHaveCount(0)
    await expect(page.getByText('Achieved', { exact: true })).toBeVisible()

    expect(stub.requests.filter((request) => request.includes('patient_update_treatment_goal_status'))).toHaveLength(2)
    expect(stub.requests.filter((request) => /^(PATCH|POST|DELETE) treatment_goal/.test(request))).toEqual([])

    // A new visit reads the saved state.
    await page.reload()
    await expect(page.getByText('Achieved', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Climb one flight of stairs/ })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('sees a missed goal as missed, and may still achieve it late', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', PLAN())
    modelProgress(stub)
    await page.goto('/patient/treatment')

    await expect(page.getByText('Missed', { exact: true })).toBeVisible()
    await expect(page.getByText(/target date has passed/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start goal: Walk 500 metres unaided' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Mark achieved: Walk 500 metres unaided' }).click()
    await expect(page.getByText(/target date has passed/i)).toHaveCount(0)
  })

  test('says so when the database refuses, and keeps the goal as it was', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', PLAN())
    stub.setRpcHandler('patient_update_treatment_goal_status', () => ({
      status: 400,
      error: { code: '23514', message: 'Progress can be recorded only while the treatment plan is active' },
    }))
    await page.goto('/patient/treatment')

    await page.getByRole('button', { name: 'Start goal: Climb one flight of stairs' }).click()
    await expect(page.getByText('Your progress was not saved')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start goal: Climb one flight of stairs' })).toBeVisible()
  })
})

test.describe('the doctor’s view of the goals', () => {
  test('sees each goal’s progress and target date, with no control to record it', async ({ page, signInAs }) => {
    const data = PLAN()
    data.treatment_plan[0]!.treatment_goal.push(goal('goal-done', 'Kneel without pain', 'achieved', null))
    await signInAs('doctor', data)
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)

    const list = page.getByRole('tabpanel')
    await expect(list.getByText('Not started')).toBeVisible()
    await expect(list.getByText('Missed', { exact: true })).toBeVisible()
    await expect(list.getByText('Achieved', { exact: true })).toBeVisible()
    await expect(list.getByText(/Target:/).first()).toBeVisible()
    await expect(list.getByRole('combobox')).toHaveCount(0)
    await expect(list.getByRole('button', { name: /mark achieved|start goal/i })).toHaveCount(0)
  })

  test('adds a goal with a target date, and is told plainly when the date is in the past', async ({ page, signInAs }) => {
    // The hint judges the date by the clinic's day, so the clinic's zone is known.
    await signInAs('doctor', { ...PLAN(), clinic: [CLINIC] })
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)

    await page.getByRole('button', { name: /^Add goal$/ }).click()
    await page.getByRole('textbox', { name: /^Goal/ }).fill('Balance on one leg for 30 seconds')
    await page.getByLabel(/target date/i).fill('2020-01-01')
    await page.getByRole('button', { name: /^Add goal$/ }).click()
    await expect(page.getByText('Choose today or a later date.')).toBeVisible()

    await page.getByLabel(/target date/i).fill(dayFromToday(30))
    await page.getByRole('button', { name: /^Add goal$/ }).click()
    await expect(page.getByText('Balance on one leg for 30 seconds')).toBeVisible()
  })
})
