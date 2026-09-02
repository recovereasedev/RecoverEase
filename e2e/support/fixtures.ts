import { test as base, type Page } from '@playwright/test'

import { SupabaseStub, type TableRows } from './supabase-stub'

/**
 * The same cast as the database suite, so a reader comparing the two is
 * comparing like with like:
 *
 *   doctorA ──► alice, bob     (two patients sharing one clinician)
 *   doctorB ──► carol
 *   admin
 *
 * Alice and Bob share a doctor deliberately. It is the arrangement that
 * catches a scope written one level too wide.
 */
export const IDS = {
  aliceUser: '11111111-1111-4111-8111-111111111111',
  alicePat: '11111111-1111-4111-8111-aaaaaaaaaaaa',
  bobUser: '22222222-2222-4222-8222-222222222222',
  bobPat: '22222222-2222-4222-8222-bbbbbbbbbbbb',
  carolUser: '33333333-3333-4333-8333-333333333333',
  carolPat: '33333333-3333-4333-8333-cccccccccccc',
  doctorAUser: 'aaaa1111-1111-4111-8111-111111111111',
  doctorA: 'aaaa1111-1111-4111-8111-dddddddddddd',
  doctorBUser: 'bbbb2222-2222-4222-8222-222222222222',
  doctorB: 'bbbb2222-2222-4222-8222-dddddddddddd',
  adminUser: 'cccc3333-3333-4333-8333-333333333333',
  admin: 'cccc3333-3333-4333-8333-eeeeeeeeeeee',
  planA: 'p1a11111-1111-4111-8111-111111111111',
  goalA: 'g1a11111-1111-4111-8111-111111111111',
  prescriptionA: 'r1a11111-1111-4111-8111-111111111111',
  scheduleA: 's1a11111-1111-4111-8111-111111111111',
  doseA: 'd1a11111-1111-4111-8111-111111111111',
  appointmentA: 'x1a11111-1111-4111-8111-111111111111',
} as const

const today = new Date().toISOString().slice(0, 10)

function at(hour: number): string {
  const when = new Date()
  when.setHours(hour, 0, 0, 0)
  return when.toISOString()
}

function inDays(days: number): string {
  const when = new Date()
  when.setDate(when.getDate() + days)
  when.setHours(10, 0, 0, 0)
  return when.toISOString()
}

/**
 * The stub answers per-principal, the way the database would after RLS has
 * filtered. Building the rows this way keeps the browser tests honest about
 * what each role is actually shown, without pretending to enforce anything.
 */
export function datasetFor(role: 'patient' | 'doctor' | 'admin'): TableRows {
  const accounts = [
    {
      user_id: IDS.aliceUser,
      user_email: 'alice@recoverease.test',
      user_role: 'patient',
    },
    {
      user_id: IDS.doctorAUser,
      user_email: 'doctor.a@recoverease.test',
      user_role: 'doctor',
    },
    {
      user_id: IDS.adminUser,
      user_email: 'admin@recoverease.test',
      user_role: 'admin',
    },
  ]

  const alice = {
    pat_id: IDS.alicePat,
    user_id: IDS.aliceUser,
    doc_id: IDS.doctorA,
    pat_first_name: 'Alice',
    pat_last_name: 'Santos',
    pat_birth_date: '1991-04-02',
    pat_gender: null,
    pat_contact_no: '0917 000 0000',
    pat_address: 'Cebu City',
    pat_consent_at: '2026-01-02T00:00:00Z',
    pat_created_at: '2026-01-01T00:00:00Z',
    pat_status: 'active',
    pat_reminder_preferred_time: '08:00:00',
    pat_reminder_is_enabled: true,
  }

  const bob = {
    ...alice,
    pat_id: IDS.bobPat,
    user_id: IDS.bobUser,
    pat_first_name: 'Bob',
    pat_last_name: 'Reyes',
    pat_contact_no: '0917 111 1111',
  }

  const doctorA = {
    doc_id: IDS.doctorA,
    user_id: IDS.doctorAUser,
    doc_first_name: 'Alan',
    doc_last_name: 'Cruz',
    doc_specialization: 'Orthopaedic rehabilitation',
    doc_license_no: 'LIC-A-001',
    doc_contact_no: '032 000 0000',
    doc_is_active: true,
    doc_created_at: '2026-01-01T00:00:00Z',
  }

  const doctorB = {
    ...doctorA,
    doc_id: IDS.doctorB,
    user_id: IDS.doctorBUser,
    doc_first_name: 'Bea',
    doc_last_name: 'Lim',
    doc_license_no: 'LIC-B-002',
  }

  const base: TableRows = {
    user_account: accounts,
    admin: [
      {
        admin_id: IDS.admin,
        user_id: IDS.adminUser,
        admin_first_name: 'Ada',
        admin_last_name: 'Reyes',
        admin_created_at: '2026-01-01T00:00:00Z',
      },
    ],
    announcement: [
      {
        announcement_id: 'ann-1',
        admin_id: IDS.admin,
        announcement_title: 'Clinic hours',
        announcement_content: 'Open 8am to 5pm on weekdays.',
        announcement_published_at: '2026-02-01T00:00:00Z',
        announcement_created_at: '2026-02-01T00:00:00Z',
      },
    ],
    notification: [],
    report: [],
    chat_session: [],
    chat_message: [],
    reschedule_request: [],
    audit_log: [],
    system_setting: [],
    doctor_note: [],
  }

  if (role === 'admin') {
    // Mirrors the policies: an administrator gets doctors and the audit log,
    // and no patient rows at all.
    return {
      ...base,
      doctor: [doctorA, doctorB],
      patient: [],
      audit_log: [
        {
          audit_log_id: 'audit-1',
          user_id: IDS.doctorAUser,
          audit_log_action: 'update',
          audit_log_entity: 'patient',
          audit_log_entity_id: IDS.alicePat,
          audit_log_timestamp: '2026-03-01T09:00:00Z',
          // Keys only. Values here would leak PHI to a role that cannot read
          // the patient table.
          audit_log_details: { changed_columns: ['pat_contact_no'] },
          user_account: {
            user_email: 'doctor.a@recoverease.test',
            user_role: 'doctor',
          },
        },
      ],
      system_setting: [
        {
          system_setting_id: 'set-1',
          admin_id: IDS.admin,
          system_setting_key: 'app.timezone',
          system_setting_value: 'Asia/Manila',
          system_setting_updated_at: '2026-03-01T00:00:00Z',
        },
      ],
    }
  }

  if (role === 'doctor') {
    return {
      ...base,
      doctor: [doctorA],
      // doctorA's caseload only. Carol belongs to doctorB and is absent,
      // exactly as the policy would leave her.
      patient: [alice, bob],
      treatment_plan: [
        {
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
            },
          ],
        },
      ],
      recovery_log: [
        {
          recovery_log_id: 'log-1',
          pat_id: IDS.alicePat,
          recovery_log_date: today,
          recovery_log_notes: 'Walked to the end of the road.',
          recovery_log_mood_rating: 4,
          recovery_log_created_at: at(9),
        },
      ],
      appointment: [
        {
          appointment_id: IDS.appointmentA,
          pat_id: IDS.alicePat,
          doc_id: IDS.doctorA,
          appointment_date: inDays(3),
          appointment_status: 'scheduled',
          appointment_created_at: '2026-03-01T00:00:00Z',
          patient: {
            pat_id: IDS.alicePat,
            pat_first_name: 'Alice',
            pat_last_name: 'Santos',
          },
        },
      ],
      medication_schedule: [],
      medication_log: [],
    }
  }

  // Patient: their own record and nothing else.
  return {
    ...base,
    doctor: [doctorA],
    patient: [alice],
    treatment_plan: [
      {
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
          },
        ],
      },
    ],
    recovery_log: [],
    appointment: [
      {
        appointment_id: IDS.appointmentA,
        pat_id: IDS.alicePat,
        doc_id: IDS.doctorA,
        appointment_date: inDays(3),
        appointment_status: 'scheduled',
        appointment_created_at: '2026-03-01T00:00:00Z',
        patient: {
          pat_id: IDS.alicePat,
          pat_first_name: 'Alice',
          pat_last_name: 'Santos',
        },
      },
    ],
    medication_schedule: [
      {
        medication_schedule_id: IDS.scheduleA,
        prescription_id: IDS.prescriptionA,
        medication_schedule_name: 'Paracetamol',
        medication_schedule_dosage: '500mg',
        medication_schedule_frequency: 2,
        medication_schedule_times: ['08:00:00', '20:00:00'],
        medication_schedule_start_date: '2026-02-01',
        medication_schedule_end_date: null,
        medication_schedule_created_at: '2026-02-01T00:00:00Z',
        prescription: {
          prescription_id: IDS.prescriptionA,
          prescription_issued_date: '2026-02-01',
          prescription_notes: 'Take with food.',
          pat_id: IDS.alicePat,
        },
      },
    ],
    medication_log: [
      {
        medication_log_id: IDS.doseA,
        medication_schedule_id: IDS.scheduleA,
        medication_log_scheduled_at: at(8),
        medication_log_taken_at: null,
        medication_log_status: 'pending',
        medication_log_follow_up_sent_at: null,
        medication_schedule: {
          medication_schedule_id: IDS.scheduleA,
          medication_schedule_name: 'Paracetamol',
          medication_schedule_dosage: '500mg',
          prescription: { pat_id: IDS.alicePat },
        },
      },
    ],
  }
}

type Fixtures = {
  stub: SupabaseStub
  signInAs: (
    role: 'patient' | 'doctor' | 'admin',
    overrides?: Partial<TableRows>,
  ) => Promise<void>
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  stub: async ({}, use) => {
    await use(new SupabaseStub({}))
  },

  signInAs: async ({ page }, use) => {
    await use(async (role, overrides = {}) => {
      const data: TableRows = datasetFor(role)
      // Assigned rather than spread: spreading a Partial widens every value
      // to `| undefined`, which TableRows does not allow.
      for (const [table, rows] of Object.entries(overrides)) {
        if (rows) data[table] = rows
      }
      const stub = new SupabaseStub(data)
      await stub.install(page)

      const session =
        role === 'patient'
          ? { userId: IDS.aliceUser, email: 'alice@recoverease.test' }
          : role === 'doctor'
            ? { userId: IDS.doctorAUser, email: 'doctor.a@recoverease.test' }
            : { userId: IDS.adminUser, email: 'admin@recoverease.test' }

      await stub.signInAs(page, session)
    })
  },
})

export { expect } from '@playwright/test'
export { SupabaseStub }
export type { Page }
