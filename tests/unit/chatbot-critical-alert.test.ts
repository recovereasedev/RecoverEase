import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  FLAGGED_CONVERSATION_BADGE,
  FLAGGED_CONVERSATION_NOTICE,
} from '@/features/chat/flag-notice'

import {
  type AssignedDoctor,
  CRITICAL_ALERT_MESSAGE,
  type CriticalAlertStore,
  criticalAlertLogLine,
  HELD_ALERT_ADMIN_MESSAGE,
  type HoldOutcome,
  raiseCriticalAlert,
  toHoldOutcome,
} from '../../supabase/functions/_shared/critical-alert'

/**
 * A critical concern raised in the guidance chat (modules 8.2 and 8.3) goes
 * to a clinician who can open the conversation, or waits for one while the
 * clinic's administrators are told (docs/critical-alert-escalation.md,
 * option C).
 *
 * Before this, the alert was addressed to the patient's doctor without
 * checking whether they were still active. A deactivated doctor - whose
 * patients stay assigned to them until a Clinic Admin moves them (D8) -
 * cannot open the conversation, so the alert reached nobody, while the
 * patient was told their doctor had been notified.
 */

const ACTIVE: AssignedDoctor = { userId: 'doctor-a', isActive: true, clinicId: 'clinic-1' }
const DEACTIVATED: AssignedDoctor = { userId: 'doctor-c', isActive: false, clinicId: 'clinic-1' }

/**
 * A store for one conversation, recording what was sent. The hold behaves as
 * migration 38's does: held once, then already held, until delivered.
 */
function fakeStore(
  doctor: AssignedDoctor | null,
  overrides: Partial<CriticalAlertStore> = {},
  admins: Record<string, string[]> = { 'clinic-1': ['admin-1', 'admin-2'], 'clinic-2': ['admin-9'] },
) {
  const doctorAlerts: string[] = []
  const adminAlerts: string[][] = []
  let held = false
  const store: CriticalAlertStore = {
    assignedDoctor: async () => doctor,
    notifyDoctor: async (doctorUserId) => {
      doctorAlerts.push(doctorUserId)
    },
    holdAlert: async (): Promise<HoldOutcome> => {
      if (held) return 'already_held'
      held = true
      return 'held'
    },
    clinicAdminUserIds: async (clinicId) => admins[clinicId] ?? [],
    notifyClinicAdmins: async (adminUserIds) => {
      adminAlerts.push(adminUserIds)
    },
    ...overrides,
  }
  return { store, doctorAlerts, adminAlerts, isHeld: () => held }
}

describe('raising a critical alert', () => {
  it('sends it to the assigned doctor while they are active, and nothing else', async () => {
    const { store, doctorAlerts, adminAlerts, isHeld } = fakeStore(ACTIVE)

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('doctor_notified')
    expect(doctorAlerts).toEqual(['doctor-a'])
    expect(adminAlerts).toEqual([])
    expect(isHeld()).toBe(false)
  })

  it('never sends it to a deactivated doctor: it is held, and their clinic’s administrators are told', async () => {
    const { store, doctorAlerts, adminAlerts, isHeld } = fakeStore(DEACTIVATED)

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('held')
    expect(doctorAlerts).toEqual([])
    expect(isHeld()).toBe(true)
    // Every Clinic Admin of the patient's clinic, and nobody in another.
    expect(adminAlerts).toEqual([['admin-1', 'admin-2']])
  })

  it('tells the administrators once per conversation, however many replies raise a concern', async () => {
    const { store, adminAlerts } = fakeStore(DEACTIVATED)

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('held')
    expect(await raiseCriticalAlert(store, vi.fn())).toBe('already_held')
    expect(await raiseCriticalAlert(store, vi.fn())).toBe('already_held')
    expect(adminAlerts).toHaveLength(1)
  })

  it('tells nobody else when the database finds the doctor active after all and delivers it', async () => {
    // Reactivated, or the patient moved, between the lookup and the hold.
    const { store, doctorAlerts, adminAlerts } = fakeStore(DEACTIVATED, {
      holdAlert: async () => 'delivered',
    })

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('doctor_notified')
    expect(doctorAlerts).toEqual([])
    expect(adminAlerts).toEqual([])
  })

  it('still tells the administrators when the hold cannot be recorded', async () => {
    const holdFailure = new Error('function public.hold_chat_alert(uuid) does not exist')
    const onHoldError = vi.fn()
    const { store, doctorAlerts, adminAlerts } = fakeStore(DEACTIVATED, {
      holdAlert: async () => {
        throw holdFailure
      },
    })

    expect(await raiseCriticalAlert(store, onHoldError)).toBe('admins_notified')
    expect(onHoldError).toHaveBeenCalledWith(holdFailure)
    expect(adminAlerts).toEqual([['admin-1', 'admin-2']])
    expect(doctorAlerts).toEqual([])
  })

  it('holds it even when the clinic has no administrator to tell, and says so', async () => {
    const { store, adminAlerts, isHeld } = fakeStore(DEACTIVATED, {}, {})

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('held_no_admin')
    expect(isHeld()).toBe(true)
    expect(adminAlerts).toEqual([])
  })

  it('reports an alert that reached nobody as undelivered', async () => {
    const { store } = fakeStore(
      DEACTIVATED,
      {
        holdAlert: async () => {
          throw new Error('hold failed')
        },
      },
      {},
    )

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('undelivered')
  })

  it('holds the alert when no doctor can be found at all, telling no one it cannot place', async () => {
    const clinicAdminUserIds = vi.fn(async () => ['admin-1'])
    const { store, isHeld } = fakeStore(null, { clinicAdminUserIds })

    expect(await raiseCriticalAlert(store, vi.fn())).toBe('held_no_admin')
    expect(isHeld()).toBe(true)
    expect(clinicAdminUserIds).not.toHaveBeenCalled()
  })

  it('lets a failure to write the doctor’s alert through for the caller to log', async () => {
    const failure = new Error('notification insert failed')
    const holdAlert = vi.fn(async (): Promise<HoldOutcome> => 'held')
    const { store } = fakeStore(ACTIVE, {
      notifyDoctor: async () => {
        throw failure
      },
      holdAlert,
    })

    await expect(raiseCriticalAlert(store, vi.fn())).rejects.toBe(failure)
    expect(holdAlert).not.toHaveBeenCalled()
  })

  it('lets a failure to tell the administrators through, with the alert still held', async () => {
    const failure = new Error('notification insert failed')
    const { store, isHeld } = fakeStore(DEACTIVATED, {
      notifyClinicAdmins: async () => {
        throw failure
      },
    })

    await expect(raiseCriticalAlert(store, vi.fn())).rejects.toBe(failure)
    expect(isHeld()).toBe(true)
  })
})

describe('what an alert says, and to whom', () => {
  it('tells the doctor only that a concern was raised', () => {
    expect(CRITICAL_ALERT_MESSAGE).toBe(
      'A patient raised a concern in the guidance chat that may need your attention.',
    )
  })

  it('tells an administrator what unblocks it, and nothing about the patient or the concern', () => {
    expect(HELD_ALERT_ADMIN_MESSAGE).toMatch(/deactivated/)
    expect(HELD_ALERT_ADMIN_MESSAGE).toMatch(/Reassign/)
    expect(HELD_ALERT_ADMIN_MESSAGE).not.toMatch(
      /concern|urgent|emergency|critical|crisis|symptom|pain|said|wrote|asked|unwell/i,
    )
  })

  it('accepts only the outcomes migration 38 returns', () => {
    expect(toHoldOutcome('held')).toBe('held')
    expect(toHoldOutcome('already_held')).toBe('already_held')
    expect(toHoldOutcome('delivered')).toBe('delivered')
    for (const value of [null, undefined, '', 'HELD', { outcome: 'held' }, 1]) {
      expect(() => toHoldOutcome(value)).toThrow(/unexpected outcome/)
    }
  })

  it('logs where an alert went and nothing else', () => {
    const line = criticalAlertLogLine({
      requestId: 'req-1',
      outcome: 'held',
      // Not part of the type: what a careless caller might pass.
      ...({ message: 'I have chest pain', chatSessionId: 's-1', userId: 'doctor-c' } as object),
    } as Parameters<typeof criticalAlertLogLine>[0])

    expect(JSON.parse(line)).toEqual({
      event: 'chatbot_critical_alert',
      request_id: 'req-1',
      outcome: 'held',
    })
    expect(line).not.toContain('chest pain')
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const alertStore = source.slice(
    source.indexOf('function criticalAlertStore('),
    source.indexOf('function reviewStore('),
  )
  const reviewStore = source.slice(
    source.indexOf('function reviewStore('),
    source.indexOf('Deno.serve('),
  )
  const notifyAdmins = alertStore.slice(alertStore.indexOf('async notifyClinicAdmins('))
  const criticalStep = source.slice(
    source.indexOf('const critical = raisesCriticalConcern(parsed)'),
    source.indexOf('return respond(\n      {\n        message: inserted,'),
  )

  it('raises the alert only for a saved reply that raises a concern, after the flag is set', () => {
    expect(source.indexOf('await answerOrRequestReview(')).toBeLessThan(
      source.indexOf('const critical = raisesCriticalConcern(parsed)'),
    )
    expect(source.indexOf('if (answeredElsewhere)')).toBeLessThan(
      source.indexOf('await raiseCriticalAlert('),
    )
    expect(criticalStep).toMatch(/if \(critical\) \{[\s\S]*await raiseCriticalAlert\(/)
    expect(criticalStep.indexOf('chat_session_has_critical_flag: true')).toBeLessThan(
      criticalStep.indexOf('await raiseCriticalAlert('),
    )
    expect(criticalStep).toContain(
      'criticalAlertStore(admin, patient.doc_id, chatSessionId)',
    )
  })

  it('checks that the assigned doctor is active before alerting them', () => {
    expect(alertStore).toContain(".select('user_id, doc_is_active, clinic_id')")
    expect(alertStore).toContain(".eq('doc_id', docId)")
    expect(alertStore).toContain('isActive: data.doc_is_active === true')
    // The old lookup, which sent the alert to whoever was assigned, is gone.
    expect(source).not.toMatch(/\.select\('user_id'\)\s*\.eq\('doc_id', patient\.doc_id\)/)
  })

  it('writes chat alerts in the two stores only, never anywhere else in the handler', () => {
    const handler = source.slice(source.indexOf('Deno.serve('))
    expect(handler).not.toContain("from('notification')")
    expect(alertStore.match(/from\('notification'\)\.insert\(/g)).toHaveLength(2)
    expect(reviewStore.match(/from\('notification'\)\.insert\(/g)).toHaveLength(1)
  })

  it('addresses the doctor’s alert to the conversation, and the administrators’ to none', () => {
    expect(alertStore).toMatch(
      /async notifyDoctor\(doctorUserId\) \{[\s\S]*?chat_session_id: chatSessionId,[\s\S]*?notification_message: CRITICAL_ALERT_MESSAGE,/,
    )
    expect(notifyAdmins).toContain('notification_message: HELD_ALERT_ADMIN_MESSAGE')
    expect(notifyAdmins).not.toContain('chat_session_id')
  })

  it('holds through migration 38, and counts only Clinic Admins of the patient’s clinic', () => {
    expect(alertStore).toContain(
      "admin.rpc('hold_chat_alert', {\n        target_chat_session_id: chatSessionId,",
    )
    expect(alertStore).toContain('return toHoldOutcome(data)')
    expect(alertStore).toContain(".eq('clinic_id', clinicId)")
    expect(alertStore).toContain(".eq('user_account.user_role', 'admin')")
  })

  it('puts nothing the patient or the assistant said into an alert or its log', () => {
    for (const content of ['parsed', 'chat_message_content', 'history', 'turns', 'summary']) {
      expect(alertStore).not.toContain(content)
    }
    expect(criticalStep).toContain('console.log(criticalAlertLogLine({ requestId, outcome }))')
    expect(criticalStep).not.toMatch(/console\.(log|error)\([^)]*parsed/)
  })

  it('never lets a failed alert stop the patient getting their reply', () => {
    expect(criticalStep).toMatch(
      /try \{\s*const outcome = await raiseCriticalAlert\([\s\S]*?\} catch \(error\) \{\s*console\.error\('critical alert could not be written', error\)/,
    )
  })

  it('leaves review requests as they were: the assigned, active doctor, once per conversation', () => {
    expect(reviewStore).toContain('data?.doc_is_active ?')
    expect(reviewStore).toContain(".eq('notification_message', NEEDS_REVIEW_MESSAGE)")
    expect(reviewStore).toContain(".eq('notification_is_read', false)")
    expect(source).toContain(
      '() => requestReview(reviewStore(admin, patient.doc_id, chatSessionId))',
    )
  })
})

describe('migration 38', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260902100038_held_chat_alerts.sql'),
    'utf8',
  )

  it('delivers an alert to a doctor found active in chatbot-reply’s own words', () => {
    expect(migration).toContain(`'${CRITICAL_ALERT_MESSAGE}'`)
  })

  it('takes the doctor’s row before the patient’s, the order D8’s move takes them in', () => {
    const hold = migration.slice(migration.indexOf('function public.hold_chat_alert('))
    expect(hold.indexOf('from public.doctor d')).toBeLessThan(
      hold.indexOf('from public.patient p\n      where p.pat_id = the_patient'),
    )
    expect(hold).toMatch(/from public\.doctor d\s+where d\.doc_id = the_doctor\s+for share;/)
  })

  it('lets only chatbot-reply hold an alert', () => {
    expect(migration).toContain(
      'revoke all on function public.hold_chat_alert(uuid) from public, anon, authenticated;',
    )
    expect(migration).toContain('grant execute on function public.hold_chat_alert(uuid) to service_role;')
  })
})

describe('what the patient is told about a flagged conversation', () => {
  const page = readFileSync(
    join(process.cwd(), 'src/features/chat/pages/patient-chat-page.tsx'),
    'utf8',
  )

  it('never claims anyone was notified: the page cannot know whether the alert was delivered', () => {
    for (const copy of [FLAGGED_CONVERSATION_NOTICE, FLAGGED_CONVERSATION_BADGE]) {
      expect(copy).not.toMatch(/notified|told|alerted|has seen|will contact|reviewing/i)
    }
    expect(page).not.toMatch(/have been notified|has been notified/)
  })

  it('says what to do if it cannot wait', () => {
    expect(FLAGGED_CONVERSATION_NOTICE).toMatch(/contact your doctor or emergency services now/)
  })

  it('is what the page shows for a flagged conversation', () => {
    expect(page).toMatch(
      /chat_session_has_critical_flag \? \([\s\S]{0,120}\{FLAGGED_CONVERSATION_NOTICE\}/,
    )
    expect(page).toMatch(
      /session\.chat_session_has_critical_flag \? \([\s\S]{0,400}\{FLAGGED_CONVERSATION_BADGE\}/,
    )
  })
})
