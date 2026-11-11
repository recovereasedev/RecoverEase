import { describe, expect, it } from 'vitest'

import type { AssistantReply } from '../../supabase/functions/_shared/assistant'
import {
  CRITICAL_ALERT_MESSAGE,
  type CriticalEscalationStore,
  EscalationError,
  escalateCriticalConcern,
} from '../../supabase/functions/_shared/critical-escalation'

/**
 * Modules 8.2 and 8.3 when something goes wrong: escalation either completes
 * or fails loudly, never half-done and passed over, and a retry recovers it
 * without alerting the doctor twice.
 *
 * The store is an in-memory stand-in for the flag and the notification table.
 */

const URGENT: AssistantReply = {
  message: 'Please contact emergency services now.',
  safety_level: 'urgent',
  should_contact_provider: true,
}
const CAUTION: AssistantReply = {
  message: 'Let your care team know about this.',
  safety_level: 'caution',
  should_contact_provider: true,
}
const NORMAL: AssistantReply = {
  message: 'That is common during recovery.',
  safety_level: 'normal',
  should_contact_provider: false,
}

type Alert = { doctor: string; at: number }

function fakeStore(options: {
  doctor?: string | null
  fail?: Partial<Record<'flag' | 'doctor' | 'dedupe' | 'alert', boolean>>
  alerts?: Alert[]
  clock?: () => number
}) {
  const state = {
    flagged: false,
    summary: null as string | null,
    alerts: options.alerts ?? ([] as Alert[]),
    fail: { ...options.fail },
  }
  const clock = options.clock ?? (() => Date.now())
  const store: CriticalEscalationStore = {
    async flagConversation(summary) {
      if (state.fail.flag) throw new Error('db down')
      state.flagged = true
      state.summary = summary
    },
    async doctorUserId() {
      if (state.fail.doctor) throw new Error('db down')
      return options.doctor === undefined ? 'doctor-1' : options.doctor
    },
    async hasConcernAlertSince(doctor, since) {
      if (state.fail.dedupe) throw new Error('db down')
      const from = since ? Date.parse(since) : -Infinity
      return state.alerts.some((alert) => alert.doctor === doctor && alert.at >= from)
    },
    async insertConcernAlert(doctor) {
      if (state.fail.alert) throw new Error('db down')
      state.alerts.push({ doctor, at: clock() })
    },
  }
  return { store, state }
}

describe('escalateCriticalConcern', () => {
  it('does nothing for a reply that raises no concern - no false flag', async () => {
    const { store, state } = fakeStore({})
    expect(await escalateCriticalConcern(store, NORMAL, null)).toBe('not_critical')
    expect(state.flagged).toBe(false)
    expect(state.alerts).toHaveLength(0)
  })

  it('flags the conversation and alerts the doctor for an urgent reply', async () => {
    const { store, state } = fakeStore({})
    expect(await escalateCriticalConcern(store, URGENT, null)).toBe('alerted')
    expect(state.flagged).toBe(true)
    expect(state.summary).toBe('The assistant advised seeking care now.')
    expect(state.alerts).toHaveLength(1)
  })

  it('escalates "contact your provider" as well as emergencies', async () => {
    const { store, state } = fakeStore({})
    expect(await escalateCriticalConcern(store, CAUTION, null)).toBe('alerted')
    expect(state.summary).toBe('The assistant suggested contacting the care team.')
  })

  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'fails loudly when the %s step fails, so the reply is not saved',
    async (step) => {
      const { store } = fakeStore({ fail: { [step]: true } })
      const error = await escalateCriticalConcern(store, URGENT, null).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EscalationError)
      expect((error as EscalationError).step).toBe(step)
    },
  )

  it('a retry after a failed alert completes it - the concern is not lost', async () => {
    const { store, state } = fakeStore({ fail: { alert: true } })
    await expect(escalateCriticalConcern(store, URGENT, null)).rejects.toBeInstanceOf(EscalationError)
    expect(state.alerts).toHaveLength(0)

    state.fail.alert = false
    expect(await escalateCriticalConcern(store, URGENT, null)).toBe('alerted')
    expect(state.alerts).toHaveLength(1)
  })

  it('a retry after escalation succeeded but the save failed does not alert twice', async () => {
    const { store, state } = fakeStore({})
    expect(await escalateCriticalConcern(store, URGENT, null)).toBe('alerted')
    // ...the reply's save fails; the patient tries again and the new reply
    // is critical too.
    expect(await escalateCriticalConcern(store, CAUTION, null)).toBe('already_alerted')
    expect(state.alerts).toHaveLength(1)
    expect(state.flagged).toBe(true)
  })

  it('a new concern after the conversation was answered is alerted again', async () => {
    let now = 1_000
    const { store, state } = fakeStore({ clock: () => now })
    expect(await escalateCriticalConcern(store, URGENT, null)).toBe('alerted')
    // The reply was saved at 2 000; a later message raises a fresh concern.
    now = 3_000
    expect(await escalateCriticalConcern(store, URGENT, new Date(2_000).toISOString())).toBe('alerted')
    expect(state.alerts).toHaveLength(2)
  })

  it('with no treating doctor, still flags the conversation', async () => {
    const { store, state } = fakeStore({ doctor: null })
    expect(await escalateCriticalConcern(store, URGENT, null)).toBe('no_doctor')
    expect(state.flagged).toBe(true)
  })

  it('carries no clinical detail in the alert', () => {
    expect(CRITICAL_ALERT_MESSAGE).not.toMatch(/swelling|pain|bleed|urgent/i)
  })
})
