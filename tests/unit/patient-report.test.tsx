import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PatientReport, type ReportVariant } from '@/features/reports/components/patient-report'
import { summariseReport, type PatientReportData } from '@/features/reports/report-data'
import type { Doctor } from '@/features/patients/api'

/**
 * The printed patient report, in both copies.
 *
 * What these pin is what matters on paper: every section is present and
 * says something even when there is nothing to show; a long history prints
 * all of it under a header that repeats; nothing on the page is a control;
 * the patient copy never carries the clinical notes; and nothing is printed
 * that the record does not hold.
 */

const NOW = new Date('2026-09-11T09:00:00')
const PATIENT_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'

const DOCTOR: Doctor = {
  doc_id: 'd-1',
  user_id: 'u-doctor',
  doc_first_name: 'Alan',
  doc_last_name: 'Cruz',
  doc_specialization: 'Orthopaedic rehabilitation',
  doc_license_no: 'LIC-A-001',
  doc_contact_no: null,
  doc_is_active: true,
  doc_created_at: '2026-01-01T00:00:00Z',
}

const NOTE_TEXT = 'Wound healing well.\nContinue physiotherapy twice weekly.'

function recordFor(overrides: Partial<PatientReportData> = {}): PatientReportData {
  return {
    patient: {
      pat_id: PATIENT_ID,
      user_id: 'u-alice',
      doc_id: 'd-1',
      pat_first_name: 'Alice',
      pat_last_name: 'Santos',
      pat_birth_date: '1991-04-02',
      pat_gender: 'Female',
      pat_contact_no: '0917 000 0000',
      pat_address: 'Cebu City',
      pat_consent_at: '2026-01-02T00:00:00Z',
      pat_created_at: '2026-01-01T00:00:00Z',
      pat_status: 'active',
      pat_reminder_preferred_time: null,
      pat_reminder_is_enabled: false,
    },
    recoveryLogs: [
      {
        recovery_log_id: 'l-1',
        pat_id: PATIENT_ID,
        recovery_log_date: '2026-09-10',
        recovery_log_notes: 'Walked to the end of the road.',
        recovery_log_mood_rating: 4,
        recovery_log_created_at: '2026-09-10T09:00:00Z',
      },
      {
        recovery_log_id: 'l-2',
        pat_id: PATIENT_ID,
        recovery_log_date: '2026-09-09',
        recovery_log_notes: null,
        recovery_log_mood_rating: null,
        recovery_log_created_at: '2026-09-09T09:00:00Z',
      },
    ],
    plans: [
      {
        treatment_plan_id: 'tp-1',
        pat_id: PATIENT_ID,
        doc_id: 'd-1',
        treatment_plan_title: 'Post-operative knee recovery',
        treatment_plan_description: 'Twelve week programme.',
        treatment_plan_start_date: '2026-02-01',
        treatment_plan_end_date: null,
        treatment_plan_status: 'active',
        treatment_plan_created_at: '2026-02-01T00:00:00Z',
        treatment_plan_updated_at: '2026-02-01T00:00:00Z',
        treatment_goal: [
          {
            treatment_goal_id: 'g-1',
            treatment_plan_id: 'tp-1',
            treatment_goal_description: 'Walk 500 metres unaided',
            treatment_goal_target_date: '2026-10-01',
            treatment_goal_status: 'in_progress',
            treatment_goal_created_at: '2026-02-01T00:00:00Z',
          },
          {
            treatment_goal_id: 'g-2',
            treatment_plan_id: 'tp-1',
            treatment_goal_description: 'Climb stairs without a rail',
            treatment_goal_target_date: null,
            treatment_goal_status: 'achieved',
            treatment_goal_created_at: '2026-02-01T00:00:00Z',
          },
        ],
      },
    ],
    schedules: [
      {
        medication_schedule_id: 's-1',
        prescription_id: 'rx-1',
        medication_schedule_name: 'Paracetamol',
        medication_schedule_dosage: '500mg',
        medication_schedule_frequency: 2,
        medication_schedule_times: ['08:00:00', '20:00:00'],
        medication_schedule_start_date: '2026-09-01',
        medication_schedule_end_date: null,
        medication_schedule_created_at: '2026-09-01T00:00:00Z',
        prescription: {
          prescription_id: 'rx-1',
          prescription_notes: 'Take with food.',
        } as PatientReportData['schedules'][number]['prescription'],
      },
    ],
    appointments: [
      {
        appointment_id: 'a-1',
        pat_id: PATIENT_ID,
        doc_id: 'd-1',
        appointment_date: '2026-09-14T02:00:00Z',
        appointment_status: 'scheduled',
        appointment_created_at: '2026-09-01T00:00:00Z',
      },
      {
        appointment_id: 'a-2',
        pat_id: PATIENT_ID,
        doc_id: 'd-1',
        appointment_date: '2026-08-01T01:00:00Z',
        appointment_status: 'completed',
        appointment_created_at: '2026-07-01T00:00:00Z',
      },
    ],
    weekAdherence: { taken: 5, missed: 1, skipped: 0, pending: 2, resolved: 6, rate: 83 },
    notes: [
      {
        doctor_note_id: 'n-1',
        pat_id: PATIENT_ID,
        doc_id: 'd-1',
        doctor_note_text: NOTE_TEXT,
        doctor_note_created_at: '2026-09-09T03:00:00Z',
      } as PatientReportData['notes'][number],
    ],
    ...overrides,
  }
}

const EMPTY: Partial<PatientReportData> = {
  recoveryLogs: [],
  plans: [],
  schedules: [],
  appointments: [],
  notes: [],
  weekAdherence: { taken: 0, missed: 0, skipped: 0, pending: 0, resolved: 0, rate: null },
}

function renderReport(
  variant: ReportVariant,
  data: PatientReportData = recordFor(),
  preparedBy: Doctor | null = DOCTOR,
) {
  const view = render(
    <PatientReport
      variant={variant}
      data={data}
      preparedBy={preparedBy}
      generatedAt="2026-09-11T08:30:00"
      now={NOW}
    />,
  )
  const sheet = view.container.querySelector<HTMLElement>('[data-report-document]')
  if (!sheet) throw new Error('no report document')
  return { ...view, sheet }
}

describe('the clinical copy', () => {
  it('prints the record as the care team reviews it', () => {
    const { sheet } = renderReport('clinical')
    const page = within(sheet)

    expect(page.getByRole('heading', { level: 2, name: /patient care report/i })).toBeInTheDocument()
    expect(page.getByText('Alice Santos')).toBeInTheDocument()
    // Printed dates always carry the year.
    expect(page.getByText('2 Apr 1991 (35 years)')).toBeInTheDocument()
    expect(page.getByText('Assigned clinician')).toBeInTheDocument()
    expect(page.getAllByText('Dr. Alan Cruz').length).toBeGreaterThan(0)

    expect(page.getByText('Walked to the end of the road.')).toBeInTheDocument()
    expect(page.getByText('4 of 5 · Good')).toBeInTheDocument()
    expect(page.getByText('Not rated')).toBeInTheDocument()

    expect(page.getByText('Post-operative knee recovery')).toBeInTheDocument()
    expect(page.getByText('Walk 500 metres unaided')).toBeInTheDocument()
    expect(page.getByText('In progress')).toBeInTheDocument()
    expect(page.getByText('Achieved')).toBeInTheDocument()

    expect(page.getByText('Paracetamol')).toBeInTheDocument()
    expect(page.getByText('2× daily · 08:00, 20:00')).toBeInTheDocument()
    expect(page.getByText('Take with food.')).toBeInTheDocument()
    expect(
      page.getByText(
        'Doses due in the last 7 days: 5 taken, 1 missed, 0 skipped of 6 (83% taken).',
      ),
    ).toBeInTheDocument()

    expect(page.getByText('Scheduled')).toBeInTheDocument()
    expect(page.getByText('Completed')).toBeInTheDocument()

    expect(page.getByRole('heading', { name: 'Clinical notes' })).toBeInTheDocument()
    expect(page.getByText('Licence no. LIC-A-001')).toBeInTheDocument()
  })

  it('keeps a long note’s line breaks, and wraps it', () => {
    const { sheet } = renderReport('clinical')
    const note = within(sheet).getByText((_, element) => element?.textContent === NOTE_TEXT && element.tagName === 'P')

    expect(note).toHaveClass('whitespace-pre-wrap')
  })
})

describe('the patient copy', () => {
  it('leaves the clinical notes out', () => {
    // The notes are clinician-only everywhere else in the app; a printout
    // handed across the desk must not be the way round that.
    const { sheet } = renderReport('patient')
    const page = within(sheet)

    expect(page.getByRole('heading', { level: 2, name: /patient recovery report/i })).toBeInTheDocument()
    expect(page.queryByText(/Wound healing well/)).not.toBeInTheDocument()
    expect(page.queryByRole('heading', { name: /clinical notes/i })).not.toBeInTheDocument()
  })

  it('is written for the patient, with less on the page', () => {
    const { sheet } = renderReport('patient')
    const page = within(sheet)

    expect(page.getByRole('heading', { name: 'Your recovery journal' })).toBeInTheDocument()
    expect(page.getByText('How you felt')).toBeInTheDocument()
    expect(page.getByText('Your doctor')).toBeInTheDocument()
    expect(page.getByText('2 times a day at 08:00, 20:00')).toBeInTheDocument()
    expect(
      page.getByText('In the last 7 days you took 5 of the 6 doses that were due.'),
    ).toBeInTheDocument()

    // Clinical detail that is not the patient's working copy.
    expect(page.queryByText('Contact number')).not.toBeInTheDocument()
    expect(page.queryByText('Address')).not.toBeInTheDocument()
    expect(page.queryByText(/Licence no\./)).not.toBeInTheDocument()
    expect(page.queryByText('Clinician signature')).not.toBeInTheDocument()
  })
})

describe('both copies', () => {
  it.each<ReportVariant>(['clinical', 'patient'])(
    'put nothing interactive on the %s page',
    (variant) => {
      const { sheet } = renderReport(variant)

      expect(
        sheet.querySelectorAll('button, input, select, textarea, a[href], [role="button"]'),
      ).toHaveLength(0)
    },
  )

  it.each<ReportVariant>(['clinical', 'patient'])(
    'print only what the record holds, on the %s copy',
    (variant) => {
      const { sheet } = renderReport(variant)
      const text = sheet.textContent ?? ''

      // No invented identifier, and not the internal one either.
      expect(text).not.toMatch(/\bMRN\b|record number/i)
      expect(text).not.toContain(PATIENT_ID)
      // No signature or attestation the app does not perform.
      expect(text).not.toMatch(/electronically|digitally|attested|verified/i)
    },
  )

  it('carry the RecoverEase mark and the disclaimer', () => {
    const { sheet } = renderReport('clinical')

    expect(within(sheet).getByRole('img', { name: 'RecoverEase' })).toBeInTheDocument()
    expect(within(sheet).getByText(/not a medical diagnosis/i)).toBeInTheDocument()
  })
})

describe('an empty record', () => {
  it('says so in every clinical section, with no empty tables', () => {
    const { sheet } = renderReport('clinical', recordFor(EMPTY))
    const page = within(sheet)

    expect(page.getByText('No recovery entries recorded')).toBeInTheDocument()
    expect(page.getByText('No treatment plan on record')).toBeInTheDocument()
    expect(page.getByText('No prescriptions on record')).toBeInTheDocument()
    expect(page.getByText('No appointments on record')).toBeInTheDocument()
    expect(page.getByText('No clinical notes recorded')).toBeInTheDocument()
    expect(sheet.querySelectorAll('table')).toHaveLength(0)
  })

  it('says so in every patient section', () => {
    const { sheet } = renderReport('patient', recordFor(EMPTY))
    const page = within(sheet)

    expect(page.getByText('No journal entries yet')).toBeInTheDocument()
    expect(page.getByText('No treatment plan yet')).toBeInTheDocument()
    expect(page.getByText('No medicines prescribed')).toBeInTheDocument()
    expect(page.getByText('No appointments yet')).toBeInTheDocument()
  })

  it('says so for a plan that has no goals yet', () => {
    const data = recordFor()
    data.plans = [{ ...data.plans[0], treatment_goal: [] }]
    const { sheet } = renderReport('clinical', data)

    expect(within(sheet).getByText('No goals set for this plan')).toBeInTheDocument()
  })
})

describe('a long history', () => {
  it('prints every entry, under a header that repeats on each page', () => {
    const logs = Array.from({ length: 120 }, (_, index) => ({
      recovery_log_id: `l-${index}`,
      pat_id: PATIENT_ID,
      recovery_log_date: `2026-0${1 + Math.floor(index / 28)}-${String((index % 28) + 1).padStart(2, '0')}`,
      recovery_log_notes: `Entry ${index}`,
      recovery_log_mood_rating: (index % 5) + 1,
      recovery_log_created_at: '2026-01-01T09:00:00Z',
    }))
    const { sheet } = renderReport('clinical', recordFor({ recoveryLogs: logs }))
    const table = within(sheet).getByRole('table', { name: 'Recovery log' })

    // A header row, then every one of the 120 entries.
    expect(within(table).getAllByRole('row')).toHaveLength(121)
    // Browsers repeat a `thead` at the top of each printed page.
    expect(table.querySelector('thead')).not.toBeNull()
  })
})

describe('the clinician named on the report', () => {
  it('is named as the patient’s own only when the record says so', () => {
    const other = { ...DOCTOR, doc_id: 'd-2', doc_first_name: 'Bea', doc_last_name: 'Lim' }
    const { sheet } = renderReport('clinical', recordFor(), other)
    const page = within(sheet)

    expect(page.queryByText('Assigned clinician')).not.toBeInTheDocument()
    // Who prepared it is still a fact worth printing.
    expect(page.getAllByText('Dr. Bea Lim').length).toBeGreaterThan(0)
  })
})

describe('the overview figures', () => {
  it('are counts of records the patient actually has', () => {
    const data = recordFor({
      schedules: [
        ...recordFor().schedules,
        // Ended, and not yet started: neither is a current medicine.
        { ...recordFor().schedules[0], medication_schedule_id: 's-2', medication_schedule_end_date: '2026-09-01' },
        { ...recordFor().schedules[0], medication_schedule_id: 's-3', medication_schedule_start_date: '2026-10-01' },
      ],
      appointments: [
        ...recordFor().appointments,
        // Ahead, but cancelled: not upcoming.
        {
          ...recordFor().appointments[0],
          appointment_id: 'a-3',
          appointment_status: 'cancelled',
        },
      ],
    })

    expect(summariseReport(data, NOW)).toEqual({
      recoveryEntries: 2,
      goals: { total: 2, achieved: 1, percentage: 50 },
      activePlans: 1,
      totalPlans: 1,
      currentMedicines: 1,
      upcomingAppointments: 1,
    })
  })
})

it('renders nothing that names the patient outside the document', () => {
  renderReport('clinical')
  expect(document.title).not.toContain('Alice')
  expect(screen.getAllByText('Alice Santos')).toHaveLength(1)
})
