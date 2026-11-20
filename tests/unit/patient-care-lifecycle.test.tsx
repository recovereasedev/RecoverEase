import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The patient's care on screen (migration 63): In Care or Discharged, kept
 * apart from the account and from each plan's status; the doctor's
 * Discharge patient (with its required reason) and Reopen case; and what
 * the patient sees, read from their care - never from their plans. The
 * database's own refusals are tests/db/patient-care-lifecycle.test.ts.
 */

const api = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  care: vi.fn(),
  plans: vi.fn(),
  discharge: vi.fn(),
  reopen: vi.fn(),
  logs: vi.fn(),
}))

vi.mock('@/features/auth/auth-context', () => ({ useCurrentUser: () => api.user }))
vi.mock('@/features/patient-care/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patient-care/api')>()),
  fetchPatientCare: api.care,
  dischargePatientCare: api.discharge,
  reopenPatientCare: api.reopen,
}))
vi.mock('@/features/treatment-plans/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/treatment-plans/api')>()),
  fetchTreatmentPlans: api.plans,
}))
vi.mock('@/features/recovery-logs/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/recovery-logs/api')>()),
  fetchRecoveryLogs: api.logs,
}))
vi.mock('@/features/recovery-progress/components/recovery-progress', () => ({ RecoveryProgress: () => null }))

const { isDischarged } = await import('@/features/patient-care/api')
const { isOpenCare, CLOSURE_REASONS } = await import('@/features/treatment-plans/api')
const { patientCareStatus, patientCareStatusOf, patientStatus, treatmentPlanStatusOf } = await import('@/lib/status')
const { PatientCareControls } = await import('@/features/patient-care/components/patient-care-controls')
const { RecoveryPage } = await import('@/features/recovery-logs/pages/recovery-page')

const ENDED = 'Your care has ended. Book a follow-up if you need more care.'

const IN_CARE = { pat_id: 'p-alice', pat_care_status: 'in_care', pat_care_closure_reason: null, pat_care_discharged_at: null }
const DISCHARGED = {
  pat_id: 'p-alice',
  pat_care_status: 'discharged',
  pat_care_closure_reason: 'completed_recovery',
  pat_care_discharged_at: '2026-11-10T03:00:00Z',
}

const plan = (status: string) => ({
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
  treatment_plan_closure_reason: null,
  treatment_plan_discharged_at: null,
  treatment_goal: [],
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
  api.care.mockReset()
  api.plans.mockReset().mockResolvedValue([])
  api.discharge.mockReset().mockResolvedValue({})
  api.reopen.mockReset().mockResolvedValue({})
  api.logs.mockReset().mockResolvedValue([])
})

describe('three statuses, kept apart', () => {
  it('names care In Care or Discharged, apart from the account and each plan', () => {
    expect(Object.values(patientCareStatus).map((status) => status.label)).toEqual(['In Care', 'Discharged'])
    expect(patientCareStatusOf('in_care').label).toBe('In Care')
    expect(patientCareStatusOf('discharged').label).toBe('Discharged')
    // Anything not discharged - a missing value included - is in care.
    expect(patientCareStatusOf(undefined).label).toBe('In Care')
    expect(patientStatus.active.label).toBe('Active')
    expect(treatmentPlanStatusOf('discharged').label).toBe('Discharged')
    expect(isOpenCare('active')).toBe(true)
  })

  it('reads discharge from the care status alone', () => {
    expect(isDischarged(DISCHARGED)).toBe(true)
    expect(isDischarged(IN_CARE)).toBe(false)
    expect(isDischarged(undefined)).toBe(false)
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

describe('the doctor discharges and reopens the patient', () => {
  beforeEach(() => {
    api.user = { userId: 'u-alan', role: 'doctor', profile: { kind: 'doctor', doctor: { doc_id: 'd-alan' } } }
  })

  it('discharges only once a reason is chosen, once however often confirmed', async () => {
    let release!: () => void
    api.discharge.mockReturnValue(new Promise((resolve) => (release = () => resolve({}))))
    renderWith(<PatientCareControls care={IN_CARE as never} patientName="Alice Santos" />)
    expect(screen.queryByRole('button', { name: 'Reopen case' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discharge patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discharge patient' })
    expect(within(dialog).getByText(/ends the patient’s care with you/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Each plan keeps its own status/)).toBeInTheDocument()
    expect(within(dialog).getByText(/reminders are not changed by a discharge/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm discharge' }))
    expect(await within(dialog).findByText('Choose a reason for the discharge.')).toBeInTheDocument()
    expect(api.discharge).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText(/Closure reason/), { target: { value: 'transferred' } })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm discharge' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    release()
    await waitFor(() => expect(api.discharge).toHaveBeenCalledTimes(1))
    expect(api.discharge).toHaveBeenCalledWith('p-alice', 'transferred')
  })

  it('says why a discharge was refused and keeps the dialog open', async () => {
    api.discharge.mockRejectedValue(new Error('Only the patient’s assigned doctor can discharge this patient'))
    renderWith(<PatientCareControls care={IN_CARE as never} patientName="Alice Santos" />)
    fireEvent.click(screen.getByRole('button', { name: 'Discharge patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discharge patient' })
    fireEvent.change(within(dialog).getByLabelText(/Closure reason/), { target: { value: 'withdrew' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm discharge' }))
    expect(await within(dialog).findByText(/assigned doctor can discharge/)).toBeInTheDocument()
  })

  it('shows the discharge’s reason and date, and reopens after confirming', async () => {
    renderWith(<PatientCareControls care={DISCHARGED as never} patientName="Alice Santos" />)
    expect(screen.getByText(/Discharged on 10 November · Completed recovery/)).toBeInTheDocument()
    expect(screen.getByText(/read-only until you reopen the case/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discharge patient' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen case' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reopen case' })
    expect(within(dialog).getByText(/discharge stays in the patient’s care history/)).toBeInTheDocument()
    expect(api.reopen).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen case' }))
    await waitFor(() => expect(api.reopen).toHaveBeenCalledWith('p-alice'))
  })

  it('says why a reopening was refused and keeps the dialog open', async () => {
    api.reopen.mockRejectedValue(new Error('Only the patient’s assigned doctor can reopen this patient’s care'))
    renderWith(<PatientCareControls care={DISCHARGED as never} patientName="Alice Santos" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reopen case' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reopen case' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen case' }))
    expect(await within(dialog).findByText(/assigned doctor can reopen/)).toBeInTheDocument()
  })
})

describe('the patient', () => {
  beforeEach(() => {
    api.user = { userId: 'u-alice', role: 'patient', profile: { kind: 'patient', patient: { pat_id: 'p-alice', doc_id: 'd-alan' } } }
  })

  it('once discharged: says care has ended, offers a follow-up, keeps the journal and offers no check-in', async () => {
    api.care.mockResolvedValue(DISCHARGED)
    // An active plan does not keep a discharged patient's check-in open.
    api.plans.mockResolvedValue([plan('active')])
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
    expect(screen.queryByRole('heading', { name: 'Log today' })).not.toBeInTheDocument()
    expect(await screen.findByText('Walked to the park')).toBeInTheDocument()
  })

  it('offers no check-in until it knows the patient’s care', async () => {
    api.care.mockReturnValue(new Promise(() => {}))
    renderWith(<RecoveryPage />)
    expect(await screen.findByText('Checking your care…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Log today' })).not.toBeInTheDocument()
  })

  it('keeps the check-in for a patient in care with no plan, or only a discharged plan', async () => {
    api.care.mockResolvedValue(IN_CARE)
    for (const plans of [[], [plan('discharged')]]) {
      api.plans.mockResolvedValue(plans)
      const view = renderWith(<RecoveryPage />)
      expect(await screen.findByRole('heading', { name: 'Log today' })).toBeInTheDocument()
      expect(screen.queryByText(ENDED)).not.toBeInTheDocument()
      view.unmount()
    }
  })
})
