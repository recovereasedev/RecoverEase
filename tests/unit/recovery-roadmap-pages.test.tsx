import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Recovery Roadmap's screens (migration 45): the patient's page, the
 * doctor's editor on the record, and the progress panel's roadmap view.
 * Every read and write is the API module's, stood in for here; the
 * database's own refusals are tests/db/recovery-roadmap.test.ts.
 */

const api = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  plans: vi.fn(),
  roadmap: vi.fn(),
  goalEvents: vi.fn(),
  doses: vi.fn(),
  appointments: vi.fn(),
  zone: vi.fn(),
  complete: vi.fn(),
  reopen: vi.fn(),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  archivePhase: vi.fn(),
  reorderPhases: vi.fn(),
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  archiveActivity: vi.fn(),
  reorderActivities: vi.fn(),
  linkGoal: vi.fn(),
  archived: vi.fn(),
  restorePhase: vi.fn(),
  restoreActivity: vi.fn(),
}))

vi.mock('@/features/auth/auth-context', () => ({ useCurrentUser: () => api.user }))
vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: api.plans,
}))
vi.mock('@/features/recovery-roadmap/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-roadmap/api')>()),
  fetchRoadmap: api.roadmap,
  fetchGoalStatusEvents: api.goalEvents,
  completeActivity: api.complete,
  reopenActivity: api.reopen,
  createPhase: api.createPhase,
  updatePhase: api.updatePhase,
  archivePhase: api.archivePhase,
  reorderPhases: api.reorderPhases,
  createActivity: api.createActivity,
  updateActivity: api.updateActivity,
  archiveActivity: api.archiveActivity,
  reorderActivities: api.reorderActivities,
  linkGoalToPhase: api.linkGoal,
  fetchArchived: api.archived,
  restorePhase: api.restorePhase,
  restoreActivity: api.restoreActivity,
}))
vi.mock('@/features/medications/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/medications/api')>()),
  fetchAllDoses: api.doses,
}))
vi.mock('@/features/appointments/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/appointments/api')>()),
  fetchAppointments: api.appointments,
}))
vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  fetchOwnClinicTimeZone: api.zone,
}))

const { PatientRoadmapPage } = await import('@/features/recovery-roadmap/pages/patient-roadmap-page')
const { RoadmapEditor } = await import('@/features/recovery-roadmap/components/roadmap-editor')
const { RoadmapProgress } = await import('@/features/recovery-roadmap/components/roadmap-progress')

// 10:00 on Wednesday 4 November 2026 in Manila.
const NOW = new Date('2026-11-04T02:00:00Z')

const goal = (id: string, description: string, status: string, phaseId: string | null, target: string | null = null) => ({
  treatment_goal_id: id,
  treatment_plan_id: 'plan-1',
  treatment_goal_description: description,
  treatment_goal_target_date: target,
  treatment_goal_status: status,
  treatment_goal_created_at: '2026-10-01T00:00:00Z',
  recovery_phase_id: phaseId,
})

const PLAN = {
  treatment_plan_id: 'plan-1',
  pat_id: 'p-alice',
  doc_id: 'd-alan',
  treatment_plan_title: 'Post-operative knee recovery',
  treatment_plan_description: 'Twelve week programme.',
  treatment_plan_start_date: '2026-10-01',
  treatment_plan_end_date: '2026-12-31',
  treatment_plan_status: 'active',
  treatment_plan_created_at: '2026-10-01T00:00:00Z',
  treatment_plan_updated_at: '2026-10-01T00:00:00Z',
  treatment_goal: [
    goal('g-early', 'Walk without crutches', 'achieved', 'p1'),
    goal('g-walk', 'Walk 500 metres unaided', 'in_progress', 'p2', '2026-11-05'),
    goal('g-loose', 'Climb one flight of stairs', 'pending', null),
  ],
}

const phase = (id: string, order: number, title: string, start: string | null = null) => ({
  recovery_phase_id: id,
  treatment_plan_id: 'plan-1',
  recovery_phase_title: title,
  recovery_phase_description: null,
  recovery_phase_order: order,
  recovery_phase_start_date: start,
  recovery_phase_target_end_date: null,
  recovery_phase_archived_at: null,
  recovery_phase_created_at: '2026-10-01T00:00:00Z',
  recovery_phase_updated_at: '2026-10-01T00:00:00Z',
})

const activity = (id: string, phaseId: string, order: number, title: string, completedAt: string | null, target: string | null = null) => ({
  recovery_activity_id: id,
  recovery_phase_id: phaseId,
  recovery_activity_title: title,
  recovery_activity_description: null,
  recovery_activity_target_date: target,
  recovery_activity_order: order,
  recovery_activity_completed_at: completedAt,
  recovery_activity_completed_by: completedAt ? 'u-alice' : null,
  recovery_activity_archived_at: null,
  recovery_activity_created_at: '2026-10-01T00:00:00Z',
  recovery_activity_updated_at: '2026-10-01T00:00:00Z',
})

// Phase 1 all done (2 activities, 1 goal achieved); phase 2 under way (1 of
// 2 activities done, its goal in progress); phase 3 not started.
const ROADMAP = {
  phases: [
    phase('p1', 1, 'Initial Recovery'),
    phase('p2', 2, 'Rehabilitation', '2026-11-01'),
    phase('p3', 3, 'Strength Building', '2026-12-01'),
  ],
  activities: [
    activity('a1', 'p1', 1, 'Take prescribed medication', '2026-11-02T01:00:00+00:00'),
    activity('a2', 'p1', 2, 'Attend initial consultation', '2026-10-05T01:00:00+00:00'),
    activity('a3', 'p2', 1, 'Begin light exercise', null, '2026-11-06'),
    activity('a4', 'p2', 2, 'Monitor energy levels', '2026-11-03T01:00:00+00:00'),
    activity('a5', 'p3', 1, 'Increase physical activity', null),
  ],
}

const DOSE = {
  medication_log_id: 'dose-tonight',
  medication_schedule_id: 'ms-1',
  medication_log_scheduled_at: '2026-11-04T12:00:00Z',
  medication_log_taken_at: null,
  medication_log_status: 'pending',
  medication_schedule: { medication_schedule_id: 'ms-1', medication_schedule_name: 'Amoxicillin', medication_schedule_dosage: '500 mg' },
}

const APPOINTMENT = {
  appointment_id: 'appt-7th',
  pat_id: 'p-alice',
  doc_id: 'd-alan',
  appointment_date: '2026-11-07T06:00:00Z',
  appointment_status: 'confirmed',
  patient: { pat_id: 'p-alice', pat_first_name: 'Alice', pat_last_name: 'Santos' },
}

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  api.user = {
    userId: 'u-alice',
    role: 'patient',
    profile: { kind: 'patient', patient: { pat_id: 'p-alice', doc_id: 'd-alan' } },
  }
  api.plans.mockReset().mockResolvedValue([PLAN])
  api.roadmap.mockReset().mockResolvedValue(ROADMAP)
  api.goalEvents.mockReset().mockResolvedValue([])
  api.doses.mockReset().mockResolvedValue([DOSE])
  api.appointments.mockReset().mockResolvedValue([APPOINTMENT])
  api.zone.mockReset().mockResolvedValue('Asia/Manila')
  for (const write of [
    api.complete,
    api.reopen,
    api.createPhase,
    api.updatePhase,
    api.archivePhase,
    api.reorderPhases,
    api.createActivity,
    api.updateActivity,
    api.archiveActivity,
    api.reorderActivities,
    api.linkGoal,
    api.restorePhase,
    api.restoreActivity,
  ]) {
    write.mockReset().mockResolvedValue({})
  }
  api.archived.mockReset().mockResolvedValue({ phases: [], activities: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

const phaseRegion = (name: string) => screen.getByRole('region', { name })

describe('the patient’s Recovery Roadmap', () => {
  it('shows the plan, its overall progress from activities and phase goals only, and every phase in order', async () => {
    renderWith(<PatientRoadmapPage />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovery Roadmap' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Progress Charts' })).toHaveAttribute(
      'href',
      '/patient/recovery#progress-charts',
    )
    expect(await screen.findByRole('heading', { name: 'Post-operative knee recovery' })).toBeInTheDocument()

    // 3 of 4 activities done, 1 of 2 linked goals achieved: 4 of 7 = 57%.
    // The goal in no phase is not counted.
    expect(await screen.findByText('57%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Roadmap progress' })).toHaveAttribute('aria-valuetext', '4 of 7 done')
    expect(screen.getByText('4 of 7')).toBeInTheDocument()

    const one = phaseRegion('Phase 1 — Initial Recovery')
    expect(within(one).getByText('Completed')).toBeInTheDocument()
    expect(within(one).getByText('3 of 3 done')).toBeInTheDocument()
    expect(within(one).getByText(/Done on 2 November/)).toBeInTheDocument()

    const two = phaseRegion('Phase 2 — Rehabilitation')
    // The phase's state, and its goal's: both in progress.
    expect(within(two).getAllByText('In progress')).toHaveLength(2)
    expect(within(two).getByText(/Walk 500 metres unaided/)).toBeInTheDocument()
    expect(within(two).getByText(/marked by your doctor/)).toBeInTheDocument()

    expect(within(phaseRegion('Phase 3 — Strength Building')).getByText('Upcoming')).toBeInTheDocument()
  })

  it('marks an activity done once, however often it is pressed, and says so', async () => {
    let release!: () => void
    api.complete.mockReturnValue(new Promise((resolve) => (release = () => resolve({}))))
    renderWith(<PatientRoadmapPage />)

    const mark = await screen.findByRole('button', { name: 'Mark "Begin light exercise" as done' })
    fireEvent.click(mark)
    fireEvent.click(mark)
    release()

    expect(await screen.findByText('Marked done: Begin light exercise. Your doctor can see it.')).toBeInTheDocument()
    expect(api.complete).toHaveBeenCalledTimes(1)
    expect(api.complete.mock.calls[0]![0]).toBe('a3')
    // Read again, so the page shows what the database now holds.
    await waitFor(() => expect(api.roadmap).toHaveBeenCalledTimes(2))
  })

  it('lets the patient undo a mistaken mark, and says when one could not be saved', async () => {
    renderWith(<PatientRoadmapPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Mark "Take prescribed medication" as not done' }))
    await waitFor(() => expect(api.reopen.mock.calls[0]![0]).toBe('a1'))
    expect(await screen.findByText('Marked not done: Take prescribed medication.')).toBeInTheDocument()

    api.complete.mockRejectedValue(new Error('This activity is no longer on the roadmap'))
    fireEvent.click(screen.getByRole('button', { name: 'Mark "Begin light exercise" as done' }))
    expect(await screen.findByText('The activity was not updated')).toBeInTheDocument()
  })

  it('lists goals with their doctor-set status, and upcoming tasks linked to where they are done', async () => {
    renderWith(<PatientRoadmapPage />)
    const goals = await screen.findByRole('heading', { name: 'Treatment goals' })
    const goalsCard = goals.closest('div[class*="rounded"]') as HTMLElement
    expect(within(goalsCard).getByText('1 of 3 achieved')).toBeInTheDocument()
    expect(within(goalsCard).getByText(/Phase 2/)).toBeInTheDocument()

    const upcoming = (await screen.findByRole('heading', { name: 'Upcoming tasks' })).closest('div[class*="rounded"]') as HTMLElement
    await within(upcoming).findByText('Amoxicillin, 500 mg')
    const links = within(upcoming).getAllByRole('link')
    expect(links.map((link) => [link.textContent?.replace(/\s+/g, ' ').trim(), link.getAttribute('href')])).toEqual([
      [expect.stringContaining('Amoxicillin, 500 mg'), '/patient/medications'],
      [expect.stringContaining('Walk 500 metres unaided'), '/patient/treatment'],
      [expect.stringContaining('Begin light exercise'), '#activity-a3'],
      [expect.stringContaining('Follow-up appointment'), '/patient/appointments'],
      [expect.stringContaining('View Calendar'), '/patient/calendar'],
    ])
    expect(within(upcoming).getByText('Today, 20:00')).toBeInTheDocument()
    expect(within(upcoming).getByText('Tomorrow')).toBeInTheDocument()
  })

  it('says "No activities yet" rather than 0% for a plan with no phases', async () => {
    api.roadmap.mockResolvedValue({ phases: [], activities: [] })
    api.plans.mockResolvedValue([{ ...PLAN, treatment_goal: PLAN.treatment_goal.map((item) => ({ ...item, recovery_phase_id: null })) }])
    renderWith(<PatientRoadmapPage />)
    expect(await screen.findByText('No phases yet')).toBeInTheDocument()
    expect(screen.getByText('No activities yet')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('says so when there is no active plan, and when the phases cannot be read', async () => {
    api.plans.mockResolvedValue([{ ...PLAN, treatment_plan_status: 'completed' }])
    const { unmount } = renderWith(<PatientRoadmapPage />)
    expect(await screen.findByText('No active treatment plan')).toBeInTheDocument()
    unmount()

    api.plans.mockResolvedValue([PLAN])
    api.roadmap.mockRejectedValue(new Error('Network down'))
    renderWith(<PatientRoadmapPage />)
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('keeps each active plan’s roadmap and progress apart', async () => {
    const second = {
      ...PLAN,
      treatment_plan_id: 'plan-2',
      treatment_plan_title: 'Shoulder mobility',
      treatment_goal: [],
    }
    api.plans.mockResolvedValue([PLAN, second])
    api.roadmap.mockResolvedValue({
      phases: [...ROADMAP.phases, { ...phase('q1', 1, 'Stretching'), treatment_plan_id: 'plan-2' }],
      activities: [...ROADMAP.activities, activity('b1', 'q1', 1, 'Shoulder rolls', '2026-11-03T01:00:00+00:00')],
    })
    renderWith(<PatientRoadmapPage />)

    expect(await screen.findByText('57%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Shoulder mobility' }))
    expect(await screen.findByText('100%')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Phase 1 — Stretching' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Phase 1 — Initial Recovery' })).not.toBeInTheDocument()
  })
})

describe('the doctor’s roadmap editor', () => {
  beforeEach(() => {
    api.user = { userId: 'u-alan', role: 'doctor', profile: { kind: 'doctor', doctor: { doc_id: 'd-alan' } } }
  })

  const editor = () => renderWith(<RoadmapEditor patientId="p-alice" plan={PLAN as never} />)

  it('shows the same progress and each completion with its date', async () => {
    editor()
    expect(await screen.findByText('57% · 4 of 7 done')).toBeInTheDocument()
    expect(screen.getByText('Done by the patient on 2 November')).toBeInTheDocument()
    expect(screen.getByText(/Not done yet · by 6 November/)).toBeInTheDocument()
    expect(screen.getByText('1 goal of this plan is in no phase, so it is not counted.')).toBeInTheDocument()
  })

  it('adds a phase, refusing a missing title or dates out of order or outside the plan', async () => {
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Add phase' }))
    const form = screen.getByRole('form', { name: 'Add phase' })
    fireEvent.click(within(form).getByRole('button', { name: 'Add phase' }))
    expect(await within(form).findByText('Enter a title for the phase.')).toBeInTheDocument()

    fireEvent.change(within(form).getByLabelText(/Phase title/), { target: { value: 'Long-Term Maintenance' } })
    fireEvent.change(within(form).getByLabelText('Start date'), { target: { value: '2026-12-10' } })
    fireEvent.change(within(form).getByLabelText('Target end date'), { target: { value: '2026-12-01' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add phase' }))
    expect(await within(form).findByText('The end cannot come before the start.')).toBeInTheDocument()

    fireEvent.change(within(form).getByLabelText('Target end date'), { target: { value: '2027-02-01' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add phase' }))
    expect(await within(form).findByText(/Choose a date between/)).toBeInTheDocument()
    expect(api.createPhase).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('Target end date'), { target: { value: '2026-12-31' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add phase' }))
    await waitFor(() =>
      expect(api.createPhase).toHaveBeenCalledWith('plan-1', {
        planId: 'plan-1',
        title: 'Long-Term Maintenance',
        description: null,
        startDate: '2026-12-10',
        targetEndDate: '2026-12-31',
      }),
    )
  })

  it('reorders phases and activities in one call each', async () => {
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Move phase Initial Recovery down' }))
    await waitFor(() => expect(api.reorderPhases).toHaveBeenCalledWith('plan-1', ['p2', 'p1', 'p3']))
    expect(screen.getByRole('button', { name: 'Move phase Initial Recovery up' })).toBeDisabled()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Move activity Take prescribed medication down' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Move activity Take prescribed medication down' }))
    await waitFor(() => expect(api.reorderActivities).toHaveBeenCalledWith('p1', ['a2', 'a1']))
  })

  it('adds an activity to a phase, and places and removes goals', async () => {
    editor()
    await screen.findByText('57% · 4 of 7 done')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add activity' })[1]!)
    const form = screen.getByRole('form', { name: 'Add activity' })
    fireEvent.change(within(form).getByLabelText(/Activity/), { target: { value: 'Attend scheduled check-ups' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add activity' }))
    await waitFor(() =>
      expect(api.createActivity).toHaveBeenCalledWith('p2', {
        phaseId: 'p2',
        title: 'Attend scheduled check-ups',
        description: null,
        targetDate: null,
      }),
    )

    const picker = screen.getByLabelText('Place a goal in Strength Building')
    fireEvent.change(picker, { target: { value: 'g-loose' } })
    fireEvent.click(within(picker.closest('form') as HTMLElement).getByRole('button', { name: 'Place goal' }))
    await waitFor(() => expect(api.linkGoal).toHaveBeenCalledWith('g-loose', 'p3'))

    fireEvent.click(screen.getByRole('button', { name: 'Take goal "Walk 500 metres unaided" out of phase Rehabilitation' }))
    await waitFor(() => expect(api.linkGoal).toHaveBeenCalledWith('g-walk', null))
  })

  it('archives a phase only once the doctor confirms', async () => {
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Archive phase Strength Building' }))
    expect(screen.getByText(/what was done stays on record/)).toBeInTheDocument()
    expect(api.archivePhase).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Archive phase' }))
    await waitFor(() => expect(api.archivePhase.mock.calls[0]![0]).toBe('p3'))
  })

  it('says why a change was refused', async () => {
    api.reorderPhases.mockRejectedValue(new Error('Only the patient’s assigned doctor can change their roadmap'))
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Move phase Rehabilitation up' }))
    expect(await screen.findByText('The roadmap was not changed')).toBeInTheDocument()
  })

  it('clears a refusal once a later change goes through', async () => {
    api.reorderPhases.mockRejectedValue(new Error('The new order must list each of the plan’s current phases once'))
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Move phase Rehabilitation up' }))
    expect(await screen.findByText('The roadmap was not changed')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Move activity Take prescribed medication down' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Move activity Take prescribed medication down' }))
    await waitFor(() => expect(api.reorderActivities).toHaveBeenCalledWith('p1', ['a2', 'a1']))
    await waitFor(() => expect(screen.queryByText('The roadmap was not changed')).not.toBeInTheDocument())
  })

  it('archives an activity only once the doctor confirms, saying what is kept', async () => {
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Archive activity Take prescribed medication' }))
    expect(screen.getByText(/that they did it stays on record/)).toBeInTheDocument()
    expect(api.archiveActivity).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByText(/that they did it stays on record/)).not.toBeInTheDocument()
    expect(api.archiveActivity).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Archive activity Take prescribed medication' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive activity' }))
    await waitFor(() => expect(api.archiveActivity.mock.calls[0]![0]).toBe('a1'))
  })

  it('judges a phase by the clinic’s day, not this device’s', async () => {
    // 12:30 UTC on 4 November is already 5 November at a clinic on UTC+14.
    vi.setSystemTime(new Date('2026-11-04T12:30:00Z'))
    api.zone.mockResolvedValue('Pacific/Kiritimati')
    api.roadmap.mockResolvedValue({
      phases: [phase('p1', 1, 'Starts on the 5th', '2026-11-05')],
      activities: [activity('a1', 'p1', 1, 'Begin', null)],
    })
    editor()
    const heading = await screen.findByRole('heading', { name: 'Phase 1 — Starts on the 5th' })
    await waitFor(() => expect(within(heading.parentElement as HTMLElement).getByText('In progress')).toBeInTheDocument())
  })

  it('lists what was archived and restores a phase or an activity', async () => {
    api.archived.mockResolvedValue({
      phases: [{ ...phase('p-old', 4, 'Long-Term Maintenance'), recovery_phase_archived_at: '2026-11-01T02:00:00Z' }],
      activities: [
        {
          ...activity('a-old', 'p2', 3, 'Attend check-ups', '2026-10-20T01:00:00+00:00'),
          recovery_activity_archived_at: '2026-11-02T02:00:00Z',
        },
      ],
    })
    editor()
    const toggle = await screen.findByRole('button', { name: 'Show archived' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(api.archived).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide archived' })).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText(/done, archived 2 November/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restore phase Long-Term Maintenance' }))
    await waitFor(() => expect(api.restorePhase.mock.calls[0]![0]).toBe('p-old'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore activity Attend check-ups' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Restore activity Attend check-ups' }))
    await waitFor(() => expect(api.restoreActivity.mock.calls[0]![0]).toBe('a-old'))
  })
})

describe('the progress panel’s roadmap view', () => {
  it('counts what was done in the period once each, from the records, and explains how', async () => {
    api.goalEvents.mockResolvedValue([
      {
        treatment_goal_status_event_id: 'e1',
        treatment_goal_id: 'g-early',
        treatment_goal_previous_status: 'in_progress',
        treatment_goal_new_status: 'achieved',
        treatment_goal_changed_by: 'u-alan',
        treatment_goal_changed_at: '2026-11-03T05:00:00+00:00',
      },
    ])
    renderWith(
      <RoadmapProgress patientId="p-alice" plans={[PLAN as never]} range={7} today="2026-11-04" period="29 Oct – 4 Nov" />,
    )

    expect(await screen.findByText(/57% of the roadmap done/)).toBeInTheDocument()
    // a1 (2 Nov) and a4 (3 Nov) fall in the 7 days; a2 (5 Oct) does not.
    expect(screen.getByText('Take prescribed medication')).toBeInTheDocument()
    expect(screen.getByText('Monitor energy levels')).toBeInTheDocument()
    expect(screen.queryByText('Attend initial consultation')).not.toBeInTheDocument()
    expect(screen.getByText(/goal, achieved 3 November/)).toBeInTheDocument()
    expect(screen.getByText(/How this is counted/)).toBeInTheDocument()
    expect(api.goalEvents.mock.calls[0]![0]).toEqual(['g-early', 'g-walk', 'g-loose'])
  })
})
