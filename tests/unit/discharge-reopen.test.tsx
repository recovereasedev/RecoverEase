import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Discharge and reopen (migration 57), on screen: what counts as open care,
 * the doctor's discharge dialog with its required reason and its reopen
 * confirmation, and what the patient sees once their care has ended. The
 * database's own refusals are tests/db/discharge-reopen.test.ts.
 */

const api = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  plans: vi.fn(),
  discharge: vi.fn(),
  reopen: vi.fn(),
  logs: vi.fn(),
}))

vi.mock('@/features/auth/auth-context', () => ({ useCurrentUser: () => api.user }))
vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: api.plans,
  dischargeTreatmentPlan: api.discharge,
  reopenTreatmentPlan: api.reopen,
}))
vi.mock('@/features/recovery-logs/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-logs/api')>()),
  fetchRecoveryLogs: api.logs,
}))
vi.mock('@/features/recovery-progress/components/recovery-progress', () => ({ RecoveryProgress: () => null }))

const { careHasEnded, isOpenCare, CLOSURE_REASONS } = await import('@/features/treatment-plans/api')
const { CaseLifecycle } = await import('@/features/treatment-plans/components/case-lifecycle')
const { RecoveryPage } = await import('@/features/recovery-logs/pages/recovery-page')

const ENDED = 'Your care plan has ended. Book a follow-up if you need more care.'

const plan = (status: string, extra: Record<string, unknown> = {}) => ({
  treatment_plan_id: `plan-${status}`,
  pat_id: 'p-alice',
  doc_id: 'd-alan',
  treatment_plan_title: 'Knee recovery',
  treatment_plan_description: null,
  treatment_plan_start_date: '2026-10-01',
  treatment_plan_end_date: null,
  treatment_plan_status: status,
  treatment_plan_created_at: '2026-10-01T00:00:00Z',
  treatment_plan_updated_at: '2026-10-01T00:00:00Z',
  treatment_plan_follow_up_appointment_id: null,
  treatment_plan_closure_reason: null,
  treatment_plan_discharged_at: null,
  treatment_goal: [],
  ...extra,
})

const DISCHARGED = plan('discharged', {
  treatment_plan_closure_reason: 'completed_recovery',
  treatment_plan_discharged_at: '2026-11-10T03:00:00Z',
})

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

// jsdom has no modal dialogs; the project's other dialog tests stand them in.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  api.plans.mockReset()
  api.discharge.mockReset().mockResolvedValue({})
  api.reopen.mockReset().mockResolvedValue({})
  api.logs.mockReset().mockResolvedValue([])
})

describe('open care and ended care', () => {
  it('treats a plan ready for discharge as open care, like an active one', () => {
    expect((['draft', 'active', 'ready_for_discharge', 'discharged', 'completed', 'cancelled'] as const).filter((status) => isOpenCare(status))).toEqual([
      'active',
      'ready_for_discharge',
    ])
  })

  it('says care has ended only with a discharged plan and no open one', () => {
    const status = (...statuses: string[]) => statuses.map((value) => ({ treatment_plan_status: value }) as never)
    expect(careHasEnded(status('discharged'))).toBe(true)
    expect(careHasEnded(status('discharged', 'cancelled'))).toBe(true)
    expect(careHasEnded(status('discharged', 'active'))).toBe(false)
    expect(careHasEnded(status('discharged', 'ready_for_discharge'))).toBe(false)
    expect(careHasEnded(status('completed'))).toBe(false)
    expect(careHasEnded([])).toBe(false)
  })

  it('lists the five closure reasons in plain words', () => {
    expect(CLOSURE_REASONS.map((reason) => reason.label)).toEqual([
      'Completed recovery',
      'Transferred',
      'Withdrew',
      'Lost to follow-up',
      'Referred',
    ])
  })
})

describe('the doctor discharges and reopens', () => {
  beforeEach(() => {
    api.user = { userId: 'u-alan', role: 'doctor', profile: { kind: 'doctor', doctor: { doc_id: 'd-alan' } } }
  })

  it('discharges only once a reason is chosen, once however often confirmed', async () => {
    let release!: () => void
    api.discharge.mockReturnValue(new Promise((resolve) => (release = () => resolve({}))))
    renderWith(<CaseLifecycle patientId="p-alice" plan={plan('ready_for_discharge') as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'Discharge patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discharge patient' })
    expect(within(dialog).getByText(/ends this care plan/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm discharge' }))
    expect(await within(dialog).findByText('Choose a reason for the discharge.')).toBeInTheDocument()
    expect(api.discharge).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText(/Closure reason/), { target: { value: 'transferred' } })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm discharge' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    release()
    await waitFor(() => expect(api.discharge).toHaveBeenCalledTimes(1))
    expect(api.discharge).toHaveBeenCalledWith('plan-ready_for_discharge', 'transferred')
  })

  it('says why a discharge was refused and keeps the dialog open', async () => {
    api.discharge.mockRejectedValue(new Error('Only the patient’s assigned doctor can discharge this plan'))
    renderWith(<CaseLifecycle patientId="p-alice" plan={plan('active') as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discharge patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discharge patient' })
    fireEvent.change(within(dialog).getByLabelText(/Closure reason/), { target: { value: 'withdrew' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm discharge' }))
    expect(await within(dialog).findByText(/assigned doctor can discharge/)).toBeInTheDocument()
  })

  it('shows a discharged plan’s reason and date, and reopens it after confirming', async () => {
    renderWith(<CaseLifecycle patientId="p-alice" plan={DISCHARGED as never} />)
    expect(screen.getByText(/Discharged on 10 November · Completed recovery/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discharge patient' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen case' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reopen case' })
    expect(within(dialog).getByText(/discharge stays in the plan’s history/)).toBeInTheDocument()
    expect(within(dialog).getByText(/end date has passed, extend it/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen case' }))
    await waitFor(() => expect(api.reopen).toHaveBeenCalledWith('plan-discharged'))
  })

  it('offers nothing on a draft, completed or cancelled plan', () => {
    for (const status of ['draft', 'completed', 'cancelled']) {
      const { unmount } = renderWith(<CaseLifecycle patientId="p-alice" plan={plan(status) as never} />)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe('the patient once care has ended', () => {
  beforeEach(() => {
    api.user = { userId: 'u-alice', role: 'patient', profile: { kind: 'patient', patient: { pat_id: 'p-alice', doc_id: 'd-alan' } } }
  })

  it('says the care plan has ended, offers a follow-up, and offers no new check-in', async () => {
    api.plans.mockResolvedValue([DISCHARGED])
    api.logs.mockResolvedValue([
      {
        recovery_log_id: 'log-1',
        pat_id: 'p-alice',
        recovery_log_date: '2026-11-01',
        recovery_log_mood_rating: 4,
        recovery_log_notes: 'Walked to the park',
        recovery_log_created_at: '2026-11-01T02:00:00Z',
      },
    ])
    renderWith(<RecoveryPage />)
    expect(await screen.findByText(ENDED)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Book a follow-up' })).toHaveAttribute('href', '/patient/appointments')
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
    // The journal stays.
    expect(await screen.findByText('Walked to the park')).toBeInTheDocument()
  })

  it('offers no check-in until it knows whether care has ended', async () => {
    api.plans.mockReturnValue(new Promise(() => {}))
    renderWith(<RecoveryPage />)
    expect(await screen.findByText('Checking your care plan…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Log today' })).not.toBeInTheDocument()
  })

  it('keeps the daily check-in while any care is open', async () => {
    api.plans.mockResolvedValue([DISCHARGED, plan('ready_for_discharge')])
    renderWith(<RecoveryPage />)
    expect(await screen.findByRole('heading', { name: 'Log today' })).toBeInTheDocument()
    expect(screen.queryByText(ENDED)).not.toBeInTheDocument()
  })
})
