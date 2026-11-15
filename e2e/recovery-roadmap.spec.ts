import { expect, IDS, test, type Page } from './support/fixtures'

/**
 * Module 5.7, the Recovery Roadmap (migrations 45, 56), in a real browser
 * against the stub: the patient's page - progress, the generated phases,
 * marking an activity done, the follow-up appointment, upcoming tasks, the
 * way to the charts - and the doctor's roadmap on the record, which monitors
 * phases and manages activities but cannot add, move or archive a phase.
 * Generation and who may do what are the database's
 * (tests/db/automatic-recovery-roadmap.test.ts); this is what each screen
 * does with it.
 */

/** A `YYYY-MM-DD` day `days` from today, in this machine's zone. */
function dayFromToday(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const stamp = { recovery_phase_archived_at: null, recovery_phase_created_at: '2026-02-01T00:00:00Z', recovery_phase_updated_at: '2026-02-01T00:00:00Z' }
// As the database generates them for a plan with one goal: 1 + 2 = 3 phases.
const PHASES = [
  { recovery_phase_id: 'ph-1', treatment_plan_id: IDS.planA, recovery_phase_kind: 'initial', treatment_goal_id: null, recovery_phase_title: 'Initial Recovery', recovery_phase_description: 'Rest and settle into the routine.', recovery_phase_order: 1, recovery_phase_start_date: '2026-02-01', recovery_phase_target_end_date: null, ...stamp },
  { recovery_phase_id: 'ph-2', treatment_plan_id: IDS.planA, recovery_phase_kind: 'goal', treatment_goal_id: IDS.goalA, recovery_phase_title: 'Recovery and Monitoring', recovery_phase_description: null, recovery_phase_order: 2, recovery_phase_start_date: null, recovery_phase_target_end_date: '2026-05-01', ...stamp },
  { recovery_phase_id: 'ph-3', treatment_plan_id: IDS.planA, recovery_phase_kind: 'follow_up', treatment_goal_id: null, recovery_phase_title: 'Follow-up and Assessment', recovery_phase_description: null, recovery_phase_order: 1000000, recovery_phase_start_date: null, recovery_phase_target_end_date: null, ...stamp },
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
  activity('act-4', 'ph-3', 1, 'Final mobility assessment'),
]

/** Alice's plan, its one goal in its own Recovery and Monitoring phase. */
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
  treatment_plan_follow_up_appointment_id: null,
  treatment_plan_closure_reason: null,
  treatment_plan_discharged_at: null,
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
    const goalPhase = page.getByRole('region', { name: 'Phase 2 — Recovery and Monitoring: Walk 500 metres unaided' })
    await expect(goalPhase.getByText('Goal target date 1 May')).toBeVisible()
    await expect(goalPhase.getByRole('link', { name: 'Update your progress' })).toHaveAttribute('href', '/patient/treatment')
    const last = page.getByRole('region', { name: 'Phase 3 — Follow-up and Assessment' })
    await expect(last.getByText('Upcoming')).toBeVisible()
    await expect(last.getByText('Your doctor has not chosen a follow-up appointment yet.')).toBeVisible()
    await expect(page.getByRole('button', { name: /phase/i })).toHaveCount(0)

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
    await expect(page.getByRole('region', { name: 'Phase 3 — Follow-up and Assessment' })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('the doctor’s roadmap', () => {
  const openTreatment = async (page: Page) => {
    await page.goto(`/doctor/patients/${IDS.alicePat}?tab=treatment`)
    await expect(page.getByRole('heading', { name: 'Recovery roadmap' })).toBeVisible()
  }

  test('monitors the generated phases, adds an assessment, and chooses the follow-up appointment', async ({
    page,
    signInAs,
  }) => {
    const errors = watchForErrors(page)
    const stub = await signInAs('doctor', ROADMAP())
    await openTreatment(page)

    await expect(page.getByText('20% · 1 of 5 done')).toBeVisible()
    await expect(page.getByText(/Done by the patient on 10 February/)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Phase 2 — Recovery and Monitoring: Walk 500 metres unaided' })).toBeVisible()
    // No phase is the doctor's to add, edit, move or archive.
    for (const name of [/Add phase/, /Edit phase/, /Move phase/, /Archive phase/]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0)
    }

    const last = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Phase 3 — Follow-up and Assessment' }) })
    await last.getByRole('button', { name: 'Add activity to Follow-up and Assessment' }).click()
    const activityForm = page.getByRole('form', { name: 'Add activity' })
    await activityForm.getByLabel(/Activity/).fill('Final strength assessment')
    await activityForm.getByRole('button', { name: 'Add activity' }).click()
    await expect(page.getByText('Final strength assessment')).toBeVisible()
    // 1 of 6 now: 17%.
    await expect(page.getByText('17% · 1 of 6 done')).toBeVisible()

    await expect(last.getByText('No follow-up appointment chosen yet.')).toBeVisible()
    await last.getByLabel('Follow-up appointment').selectOption(IDS.appointmentA)
    await last.getByRole('button', { name: 'Save follow-up' }).click()
    await expect(last.getByText(/^Follow-up appointment \d/)).toBeVisible()
    expect(stub.requests.filter((request) => /^(POST|PATCH|DELETE) recovery_phase/.test(request))).toEqual([])
    expect(errors).toEqual([])
  })

  test('fits a 360px phone, with its confirmations and the archived list, nothing running off it', async ({
    page,
    signInAs,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await signInAs('doctor', ROADMAP())
    await openTreatment(page)
    await expect(page.getByText('20% · 1 of 5 done')).toBeVisible()

    await page.getByRole('button', { name: 'Archive activity Follow prescribed rest instructions' }).click()
    await expect(page.getByText(/that they did it stays on record/)).toBeVisible()
    await page.getByRole('button', { name: 'Show archived activities' }).click()
    await expect(page.getByText('No activity in this plan is archived.')).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
