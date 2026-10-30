import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * Module 5.7, the enhanced Recovery Roadmap (migration 45), in a real
 * browser against the stub: the patient's page - progress, phases, marking
 * an activity done, upcoming tasks, the way to the charts - and the doctor's
 * editor on the record. Who may do what is the database's
 * (tests/db/recovery-roadmap.test.ts); this is what each screen does with it.
 */

/** A `YYYY-MM-DD` day `days` from today, in this machine's zone. */
function dayFromToday(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const stamp = { recovery_phase_archived_at: null, recovery_phase_created_at: '2026-02-01T00:00:00Z', recovery_phase_updated_at: '2026-02-01T00:00:00Z' }
const PHASES = [
  { recovery_phase_id: 'ph-1', treatment_plan_id: IDS.planA, recovery_phase_title: 'Initial Recovery', recovery_phase_description: 'Rest and settle into the routine.', recovery_phase_order: 1, recovery_phase_start_date: null, recovery_phase_target_end_date: null, ...stamp },
  { recovery_phase_id: 'ph-2', treatment_plan_id: IDS.planA, recovery_phase_title: 'Rehabilitation', recovery_phase_description: null, recovery_phase_order: 2, recovery_phase_start_date: '2026-03-01', recovery_phase_target_end_date: null, ...stamp },
  { recovery_phase_id: 'ph-3', treatment_plan_id: IDS.planA, recovery_phase_title: 'Strength Building', recovery_phase_description: null, recovery_phase_order: 3, recovery_phase_start_date: null, recovery_phase_target_end_date: null, ...stamp },
]

const activity = (id: string, phaseId: string, order: number, title: string, extra: Record<string, unknown> = {}) => ({
  recovery_activity_id: id,
  recovery_phase_id: phaseId,
  recovery_activity_title: title,
  recovery_activity_description: null,
  recovery_activity_target_date: null,
  recovery_activity_order: order,
  recovery_activity_completed_at: null,
  recovery_activity_completed_by: null,
  recovery_activity_archived_at: null,
  recovery_activity_created_at: '2026-02-01T00:00:00Z',
  recovery_activity_updated_at: '2026-02-01T00:00:00Z',
  ...extra,
})

const ACTIVITIES = [
  activity('act-1', 'ph-1', 1, 'Follow prescribed rest instructions', {
    recovery_activity_completed_at: '2026-02-10T02:00:00Z',
    recovery_activity_completed_by: IDS.aliceUser,
  }),
  activity('act-2', 'ph-2', 1, 'Begin light physical therapy', { recovery_activity_target_date: dayFromToday(2) }),
  activity('act-3', 'ph-2', 2, 'Monitor symptoms and energy levels'),
  activity('act-4', 'ph-3', 1, 'Gradually increase physical activity'),
]

/** Alice's plan with its goal placed in Rehabilitation. */
const PLAN = {
  treatment_plan_id: IDS.planA,
  pat_id: IDS.alicePat,
  doc_id: IDS.doctorA,
  treatment_plan_title: 'Post-operative knee recovery',
  treatment_plan_description: 'Twelve week programme.',
  treatment_plan_start_date: '2026-02-01',
  treatment_plan_end_date: null,
  treatment_plan_status: 'active',
  treatment_plan_created_at: '2026-02-01T00:00:00Z',
  treatment_plan_updated_at: '2026-02-01T00:00:00Z',
  treatment_goal: [
    {
      treatment_goal_id: IDS.goalA,
      treatment_plan_id: IDS.planA,
      treatment_goal_description: 'Walk 500 metres unaided',
      treatment_goal_target_date: '2026-05-01',
      treatment_goal_status: 'in_progress',
      treatment_goal_created_at: '2026-02-01T00:00:00Z',
      recovery_phase_id: 'ph-2',
    },
  ],
}

const ROADMAP = () => ({
  treatment_plan: [structuredClone(PLAN)],
  recovery_phase: structuredClone(PHASES),
  recovery_activity: structuredClone(ACTIVITIES),
  treatment_goal_status_event: [],
})

/** Console errors and uncaught exceptions, for asserting there were none. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test.describe('the patient’s Recovery Roadmap', () => {
  test('shows the plan’s progress, its phases in order and what is coming up', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await signInAs('patient', ROADMAP())
    await page.goto('/patient/roadmap')

    await expect(page.getByRole('heading', { level: 1, name: 'Recovery Roadmap' })).toBeVisible()
    // 1 of 4 activities done and the linked goal in progress: 1 of 5 = 20%.
    await expect(page.getByText('20%', { exact: true })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Roadmap progress' })).toHaveAttribute('aria-valuetext', '1 of 5 done')

    const one = page.getByRole('region', { name: 'Phase 1 — Initial Recovery' })
    await expect(one.getByText('Completed')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Phase 2 — Rehabilitation' }).getByText('Goal:')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Phase 3 — Strength Building' }).getByText('Upcoming')).toBeVisible()

    const upcoming = page.getByRole('complementary', { name: 'Treatment goals and upcoming tasks' })
    await expect(upcoming.getByRole('link', { name: /Begin light physical therapy/ })).toHaveAttribute('href', '#activity-act-2')
    await expect(upcoming.getByRole('link', { name: 'View Calendar' })).toHaveAttribute('href', '/patient/calendar')
    await expect(page.getByRole('link', { name: 'Recovery roadmap' })).toHaveAttribute('aria-current', 'page')
    expect(errors).toEqual([])
  })

  test('marks an activity done from the keyboard, says so, and counts it', async ({ page, signInAs }) => {
    const stub = await signInAs('patient', ROADMAP())
    await page.goto('/patient/roadmap')

    const mark = page.getByRole('button', { name: 'Mark "Begin light physical therapy" as done' })
    await mark.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByText('Marked done: Begin light physical therapy. Your doctor can see it.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark "Begin light physical therapy" as not done' })).toBeVisible()
    await expect(page.getByText('40%', { exact: true })).toBeVisible()
    // One call to the database's function, and no direct write to the row.
    expect(stub.requests.filter((request) => request.includes('patient_complete_recovery_activity'))).toHaveLength(1)
    expect(stub.requests.filter((request) => /^(PATCH|POST|DELETE) recovery_activity/.test(request))).toEqual([])
  })

  test('takes the patient to the progress charts, with the 7- and 30-day periods and the roadmap view', async ({ page, signInAs }) => {
    await signInAs('patient', ROADMAP())
    await page.goto('/patient/roadmap')
    await page.getByRole('link', { name: 'View Progress Charts' }).click()

    await expect(page).toHaveURL(/\/patient\/recovery#progress-charts$/)
    // The panel itself; its overall chart is a region of the same name inside it.
    const panel = page.getByRole('region', { name: 'Recovery progress' }).first()
    await expect(panel).toBeInViewport()
    await expect(panel.getByRole('radio', { name: '7 days' })).toBeChecked()
    // The view is a radio group; Roadmap follows Treatment goals.
    await panel.getByRole('radio', { name: 'Treatment goals' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('radio', { name: 'Roadmap' })).toBeChecked()
    await expect(panel.getByText(/20% of the roadmap done/)).toBeVisible()
    await panel.getByRole('radio', { name: '7 days' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('radio', { name: '30 days' })).toBeChecked()
    await expect(panel.getByText(/How this is counted/)).toBeVisible()
  })

  test('fits a 360px phone, phases stacked, nothing running off it', async ({ page, signInAs }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('patient', ROADMAP())
    await page.goto('/patient/roadmap')
    await expect(page.getByRole('region', { name: 'Phase 3 — Strength Building' })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('the doctor’s roadmap editor', () => {
  const openTreatment = async (page: Page) => {
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)
    await expect(page.getByRole('heading', { name: 'Recovery roadmap' })).toBeVisible()
  }

  test('shows the patient’s completions, and builds the roadmap: a phase, an activity, a new order', async ({ page, signInAs }) => {
    const errors = watchForErrors(page)
    await signInAs('doctor', ROADMAP())
    await openTreatment(page)

    await expect(page.getByText('20% · 1 of 5 done')).toBeVisible()
    await expect(page.getByText(/Done by the patient on 10 February/)).toBeVisible()

    await page.getByRole('button', { name: 'Add phase' }).click()
    const phaseForm = page.getByRole('form', { name: 'Add phase' })
    await phaseForm.getByLabel(/Phase title/).fill('Long-Term Maintenance')
    await phaseForm.getByRole('button', { name: 'Add phase' }).click()
    const added = page.getByRole('heading', { name: 'Phase 4 — Long-Term Maintenance' })
    await expect(added).toBeVisible()

    const phaseItem = page.getByRole('listitem').filter({ has: added })
    await phaseItem.getByRole('button', { name: 'Add activity' }).click()
    const activityForm = page.getByRole('form', { name: 'Add activity' })
    await activityForm.getByLabel(/Activity/).fill('Attend the final follow-up appointment')
    await activityForm.getByRole('button', { name: 'Add activity' }).click()
    await expect(page.getByText('Attend the final follow-up appointment')).toBeVisible()
    // 1 of 6 now: 17%.
    await expect(page.getByText('17% · 1 of 6 done')).toBeVisible()

    await page.getByRole('button', { name: 'Move phase Long-Term Maintenance up' }).click()
    await expect(page.getByRole('heading', { name: 'Phase 3 — Long-Term Maintenance' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Phase 4 — Strength Building' })).toBeVisible()
    expect(errors).toEqual([])
  })
})
