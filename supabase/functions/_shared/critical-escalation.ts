import { type AssistantReply, raisesCriticalConcern } from './assistant.ts'

/**
 * Modules 8.2 and 8.3: flagging a conversation and alerting the treating
 * doctor when the assistant's reply raises a critical concern.
 *
 * WHEN this runs is the point of this file. It runs after the reply has been
 * validated and BEFORE the reply is saved. A saved reply is what makes a
 * retry answer `already_answered` and stop, so escalating afterwards left a
 * window - the reply saved, then the flag or the alert failing, or the
 * function dying - in which the concern was lost for good: the patient saw
 * an answer, and no retry would ever look at it again. Escalating first
 * closes that window. If any step fails the reply is not saved, the request
 * fails (and asks the doctor to review, `escalation.ts`), and the patient's
 * retry produces and escalates a reply afresh.
 *
 * What it costs: when escalation succeeds and the save then fails, the retry
 * escalates again. That second alert is suppressed here - an alert is sent at
 * most once per unanswered stretch of a conversation, recognised by a concern
 * alert written after the conversation's latest assistant reply. Both
 * timestamps are set by the server (assistant messages are written only by
 * `chatbot-reply`, migration 26; notification times by migration 44), so a
 * patient cannot make an alert look already sent. Two requests escalating at
 * the very same moment can both pass the check; a duplicate alert is the
 * accepted cost there, a lost one is not.
 *
 * Only a validated reply ever reaches this: an AI failure is never read as a
 * concern, and nothing here is inferred from a missing reply.
 *
 * Free of `Deno` and of any database client, so it is tested in Node.
 */

export const CRITICAL_ALERT_MESSAGE =
  'A patient raised a concern in the guidance chat that may need your attention.'

export function concernSummary(reply: AssistantReply): string {
  return reply.safety_level === 'urgent'
    ? 'The assistant advised seeking care now.'
    : 'The assistant suggested contacting the care team.'
}

export type CriticalEscalationStore = {
  /** Sets the conversation's critical flag and summary. Throws on failure. */
  flagConversation(summary: string): Promise<void>
  /** The treating doctor's user account, or null when the patient has none. Throws on failure. */
  doctorUserId(): Promise<string | null>
  /**
   * Whether that doctor already has a concern alert for this conversation
   * written at or after `since` (the latest assistant reply's time, or null
   * for a conversation with none). Throws on failure.
   */
  hasConcernAlertSince(doctorUserId: string, since: string | null): Promise<boolean>
  /** Writes the alert. Throws on failure. */
  insertConcernAlert(doctorUserId: string): Promise<void>
}

export type EscalationOutcome = 'not_critical' | 'alerted' | 'already_alerted' | 'no_doctor'

/** A step of escalation failed; the reply must not be saved. */
export class EscalationError extends Error {
  readonly step: 'flag' | 'doctor' | 'dedupe' | 'alert'

  constructor(step: EscalationError['step'], options?: { cause?: unknown }) {
    super(`Critical-concern escalation failed at: ${step}`, options)
    this.name = 'EscalationError'
    this.step = step
  }
}

async function step<T>(name: EscalationError['step'], run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    throw new EscalationError(name, { cause })
  }
}

/**
 * Flags and alerts for a critical reply; does nothing for any other. Every
 * step either completes or throws `EscalationError` - a failure is never
 * logged and passed over, as it was before.
 */
export async function escalateCriticalConcern(
  store: CriticalEscalationStore,
  reply: AssistantReply,
  latestAssistantReplyAt: string | null,
): Promise<EscalationOutcome> {
  if (!raisesCriticalConcern(reply)) return 'not_critical'

  await step('flag', () => store.flagConversation(concernSummary(reply)))

  const doctorUserId = await step('doctor', () => store.doctorUserId())
  // The flag is set and shows on the conversation; there is no one to alert.
  if (!doctorUserId) return 'no_doctor'

  const alreadyAlerted = await step('dedupe', () =>
    store.hasConcernAlertSince(doctorUserId, latestAssistantReplyAt),
  )
  if (alreadyAlerted) return 'already_alerted'

  await step('alert', () => store.insertConcernAlert(doctorUserId))
  return 'alerted'
}
