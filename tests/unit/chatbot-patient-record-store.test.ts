import { describe, expect, it } from 'vitest'

import {
  patientRecordStore,
  type QueryBuilder,
  type RecordClient,
  RecordOwnershipError,
} from '../../supabase/functions/_shared/patient-record-store'

/**
 * The database side of the chatbot's patient records, against a fake client
 * that records every query. The real Row Level Security behind these queries
 * is tested in tests/db/chatbot-patient-records.test.ts.
 */

type Call = { method: string; args: unknown[] }
type Query = { table: string; calls: Call[] }

function fakeClient(answers: Record<string, unknown[] | Error>) {
  const queries: Query[] = []
  const client: RecordClient = {
    from(table) {
      const query: Query = { table, calls: [] }
      queries.push(query)
      const answer = answers[table] ?? []
      const builder: QueryBuilder = new Proxy({} as QueryBuilder, {
        get(_target, method: string) {
          if (method === 'then') {
            const result =
              answer instanceof Error
                ? { data: null, error: { message: answer.message } }
                : { data: answer, error: null }
            return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
          }
          return (...args: unknown[]) => {
            query.calls.push({ method, args })
            return builder
          }
        },
      })
      return builder
    },
  }
  return { client, queries }
}

const PAT = 'pat-alice'
const DOC = 'doc-a'
const deadline = () => new AbortController().signal

const columnsOf = (query: Query) =>
  String(query.calls.find((call) => call.method === 'select')?.args[0] ?? '')

describe('the patient record store', () => {
  it('filters every patient query by the patient the conversation belongs to', async () => {
    const { client, queries } = fakeClient({})
    const store = patientRecordStore(client, PAT, DOC, deadline)
    await store.medications()
    await store.appointments('2026-11-26T02:00:00Z')
    await store.rescheduleRequests()
    await store.treatmentPlans()

    const filters = queries.map((query) => [
      query.table,
      query.calls.filter((call) => call.method === 'eq').map((call) => call.args),
    ])
    expect(filters).toEqual([
      ['medication_schedule', [['prescription.pat_id', PAT]]],
      ['appointment', [['pat_id', PAT]]],
      ['appointment', [['pat_id', PAT]]],
      ['reschedule_request', [['appointment.pat_id', PAT]]],
      ['treatment_plan', [['pat_id', PAT]]],
    ])
    // Every query has a deadline and a row limit.
    for (const query of queries) {
      expect(query.calls.some((call) => call.method === 'abortSignal')).toBe(true)
      expect(query.calls.some((call) => call.method === 'limit')).toBe(true)
    }
  })

  it('reads the roadmap only for the plans it was given', async () => {
    const { client, queries } = fakeClient({})
    await patientRecordStore(client, PAT, DOC, deadline).roadmapPhases(['plan-1'])
    expect(queries[0]!.calls).toContainEqual({ method: 'in', args: ['treatment_plan_id', ['plan-1']] })
    expect(queries[0]!.calls).toContainEqual({ method: 'is', args: ['recovery_phase_archived_at', null] })
  })

  it('reads no roadmap at all without a plan', async () => {
    const { client, queries } = fakeClient({})
    expect(await patientRecordStore(client, PAT, DOC, deadline).roadmapPhases([])).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('selects no names, contact details, notes or patient-written reasons', async () => {
    const { client, queries } = fakeClient({})
    const store = patientRecordStore(client, PAT, DOC, deadline)
    await store.medications()
    await store.appointments('2026-11-26T02:00:00Z')
    await store.rescheduleRequests()
    await store.treatmentPlans()
    await store.roadmapPhases(['plan-1'])
    const selected = queries.map(columnsOf).join(' ')
    for (const column of [
      '*',
      'pat_first_name',
      'pat_last_name',
      'pat_birth_date',
      'pat_contact_no',
      'pat_address',
      'prescription_notes',
      'reschedule_request_reason',
      'recovery_log',
      'doctor_note',
      'doc_first_name',
    ]) {
      expect(selected).not.toContain(column)
    }
  })

  it.each([
    ['medications', 'medication_schedule', { prescription: { pat_id: 'pat-bob' } }],
    ['rescheduleRequests', 'reschedule_request', { appointment: { pat_id: 'pat-bob' } }],
    ['treatmentPlans', 'treatment_plan', { pat_id: 'pat-bob', treatment_goal: [] }],
  ] as const)('refuses the whole read when %s returns another patient’s row', async (method, table, row) => {
    const { client } = fakeClient({ [table]: [row] })
    await expect(patientRecordStore(client, PAT, DOC, deadline)[method]()).rejects.toBeInstanceOf(
      RecordOwnershipError,
    )
  })

  it('refuses another patient’s appointment', async () => {
    const { client } = fakeClient({ appointment: [{ appointment_id: 'a', pat_id: 'pat-bob' }] })
    await expect(
      patientRecordStore(client, PAT, DOC, deadline).appointments('2026-11-26T02:00:00Z'),
    ).rejects.toBeInstanceOf(RecordOwnershipError)
  })

  it('refuses a roadmap phase of a plan it was not given', async () => {
    const { client } = fakeClient({ recovery_phase: [{ treatment_plan_id: 'plan-bob' }] })
    await expect(
      patientRecordStore(client, PAT, DOC, deadline).roadmapPhases(['plan-1']),
    ).rejects.toBeInstanceOf(RecordOwnershipError)
  })

  it('throws, without the database’s wording, when a read fails', async () => {
    const { client } = fakeClient({ medication_schedule: new Error('permission denied for pat-alice') })
    const failure = patientRecordStore(client, PAT, DOC, deadline).medications()
    await expect(failure).rejects.toThrow('records could not be read')
    await expect(failure).rejects.not.toThrow(/pat-alice/)
  })

  it('maps rows to the fields an answer needs', async () => {
    const { client } = fakeClient({
      medication_schedule: [
        {
          medication_schedule_name: 'Amoxicillin',
          medication_schedule_dosage: '500 mg',
          medication_schedule_frequency: 2,
          medication_schedule_times: ['08:00:00', '20:00:00'],
          medication_schedule_instructions: 'After meals',
          medication_schedule_start_date: '2026-11-20',
          medication_schedule_end_date: null,
          medication_schedule_reminders_is_enabled: false,
          prescription: { pat_id: PAT },
        },
      ],
      treatment_plan: [
        {
          treatment_plan_id: 'plan-1',
          pat_id: PAT,
          treatment_plan_title: 'Recovery',
          treatment_plan_description: null,
          treatment_plan_status: 'active',
          treatment_plan_start_date: '2026-11-01',
          treatment_plan_end_date: null,
          treatment_plan_discharged_at: null,
          treatment_goal: [
            {
              treatment_goal_id: 'goal-1',
              treatment_goal_description: 'Walk',
              treatment_goal_status: 'achieved',
              treatment_goal_target_date: null,
              treatment_goal_status_event: [
                { treatment_goal_new_status: 'in_progress', treatment_goal_changed_at: '2026-11-10T00:00:00Z' },
                { treatment_goal_new_status: 'achieved', treatment_goal_changed_at: '2026-11-12T00:00:00Z' },
                { treatment_goal_new_status: 'achieved', treatment_goal_changed_at: '2026-11-11T00:00:00Z' },
              ],
            },
          ],
        },
      ],
    })
    const store = patientRecordStore(client, PAT, DOC, deadline)
    expect(await store.medications()).toEqual([
      {
        name: 'Amoxicillin',
        dosage: '500 mg',
        timesPerDay: 2,
        times: ['08:00:00', '20:00:00'],
        instructions: 'After meals',
        startDate: '2026-11-20',
        endDate: null,
        remindersOn: false,
      },
    ])
    const [plan] = await store.treatmentPlans()
    expect(plan!.goals[0]).toMatchObject({ status: 'achieved', statusSince: '2026-11-12T00:00:00Z' })
  })

  it('reads the clinic time zone only when exactly one clinic is visible', async () => {
    const one = fakeClient({ clinic: [{ clinic_timezone: 'Asia/Manila' }] })
    expect(await patientRecordStore(one.client, PAT, DOC, deadline).clinicTimeZone()).toBe('Asia/Manila')
    const two = fakeClient({ clinic: [{ clinic_timezone: 'Asia/Manila' }, { clinic_timezone: 'UTC' }] })
    await expect(patientRecordStore(two.client, PAT, DOC, deadline).clinicTimeZone()).rejects.toThrow()
  })
})

describe('the assigned doctor and clinic', () => {
  const row = {
    doc_id: DOC,
    doc_first_name: 'Mara',
    doc_last_name: 'Velasco',
    doc_specialization: 'Orthopaedics',
    doc_is_active: true,
    clinic: { clinic_name: 'Bayside Test Clinic', clinic_status: 'active' },
  }

  it('reads only the verified doctor, and no private field', async () => {
    const { client, queries } = fakeClient({ doctor: [row] })
    expect(await patientRecordStore(client, PAT, DOC, deadline).careTeam()).toEqual({
      doctorFirstName: 'Mara',
      doctorLastName: 'Velasco',
      specialization: 'Orthopaedics',
      doctorActive: true,
      clinicName: 'Bayside Test Clinic',
      clinicActive: true,
    })
    const query = queries.find((q) => q.table === 'doctor')!
    expect(query.calls).toContainEqual({ method: 'eq', args: ['doc_id', DOC] })
    const columns = columnsOf(query)
    for (const private_ of ['*', 'doc_license_no', 'doc_contact_no', 'user_id', 'email', 'clinic_id']) {
      expect(columns).not.toContain(private_)
    }
  })

  it('refuses the read when another doctor comes back', async () => {
    const { client } = fakeClient({ doctor: [{ ...row, doc_id: 'doc-b' }] })
    await expect(patientRecordStore(client, PAT, DOC, deadline).careTeam()).rejects.toBeInstanceOf(RecordOwnershipError)
  })

  it('treats a doctor it cannot see as a failed read, never as "no doctor"', async () => {
    const { client } = fakeClient({ doctor: [] })
    await expect(patientRecordStore(client, PAT, DOC, deadline).careTeam()).rejects.toThrow()
  })

  it('has no doctor when the patient has none, without querying', async () => {
    const { client, queries } = fakeClient({ doctor: [row] })
    expect(await patientRecordStore(client, PAT, null, deadline).careTeam()).toBeNull()
    expect(queries).toEqual([])
  })

  it('reports an inactive doctor and clinic, and a clinic it could not read', async () => {
    const inactive = fakeClient({ doctor: [{ ...row, doc_is_active: false, clinic: { clinic_name: 'Bayside Test Clinic', clinic_status: 'inactive' } }] })
    expect(await patientRecordStore(inactive.client, PAT, DOC, deadline).careTeam()).toMatchObject({ doctorActive: false, clinicActive: false })
    const noClinic = fakeClient({ doctor: [{ ...row, clinic: null }] })
    expect(await patientRecordStore(noClinic.client, PAT, DOC, deadline).careTeam()).toMatchObject({ clinicName: null, clinicActive: null })
  })
})
