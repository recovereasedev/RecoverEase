/**
 * Getting a critical-concern alert (modules 8.2 and 8.3) to someone who can
 * act on it.
 *
 * The alert goes to the patient's assigned doctor while that doctor is
 * active. Decision D8 (migration 30) leaves a deactivated doctor's patients
 * assigned to them until a Clinic Admin moves them, and a deactivated doctor
 * can no longer open the conversation - so an alert addressed to them
 * reached no clinician at all. In that window (docs/critical-alert-escalation.md,
 * option C):
 *
 *   - the alert is held against the conversation (migration 38), once
 *     however many replies raise a concern, and the database delivers it to
 *     whichever clinician can open the conversation next: the doctor the
 *     patients are moved to, or the same doctor reactivated;
 *   - the clinic's administrators are told, once per held conversation, that
 *     an alert is waiting for a clinician. They cannot read the conversation,
 *     and the notification names no patient and says nothing about what was
 *     raised: what they can do is move the patients or reactivate the doctor.
 *
 * If the hold cannot be recorded - the database refuses, or migration 38 is
 * not applied yet - the administrators are told anyway: told on every such
 * reply is better than nobody told.
 *
 * Free of Deno and of any database client, like `escalation.ts`, so the
 * rules are tested in Node; `chatbot-reply` supplies the database side.
 */

/** The alert an active doctor receives. Migration 38 sends the same words. */
export const CRITICAL_ALERT_MESSAGE =
  'A patient raised a concern in the guidance chat that may need your attention.'

/**
 * What a Clinic Admin is told while an alert is held. No patient, no
 * conversation and nothing about the concern - only the doctor's state and
 * what unblocks it.
 */
export const HELD_ALERT_ADMIN_MESSAGE =
  "An alert from the guidance chat could not reach a clinician because the patient's doctor is deactivated. Reassign that doctor's patients, or reactivate the account, so it can be delivered."

/** The patient's assigned doctor, as far as an alert needs them. */
export type AssignedDoctor = {
  userId: string
  isActive: boolean
  clinicId: string
}

/**
 * What holding an alert did (migration 38's `hold_chat_alert`): held it,
 * found it already held from an earlier reply, or found the patient's doctor
 * active after all and delivered it to them.
 */
export type HoldOutcome = 'held' | 'already_held' | 'delivered'

/** What raising an alert needs from the database, for one conversation. */
export type CriticalAlertStore = {
  /** The patient's assigned doctor, or null when there is none. */
  assignedDoctor(): Promise<AssignedDoctor | null>
  /** Writes the alert to the doctor. Throws when it could not be written. */
  notifyDoctor(doctorUserId: string): Promise<void>
  /** Holds the alert for the next clinician. Throws when it could not. */
  holdAlert(): Promise<HoldOutcome>
  /** The user accounts of a clinic's Clinic Admins. */
  clinicAdminUserIds(clinicId: string): Promise<string[]>
  /** Tells them an alert is waiting. Throws when it could not be written. */
  notifyClinicAdmins(adminUserIds: string[]): Promise<void>
}

export type CriticalAlertOutcome =
  /** A doctor who can open the conversation has the alert. */
  | 'doctor_notified'
  /** Held for the next clinician; the Clinic Admins were told. */
  | 'held'
  /** Still held from an earlier reply, which told the Clinic Admins. */
  | 'already_held'
  /** Held, but the clinic has no Clinic Admin to tell. */
  | 'held_no_admin'
  /** The hold could not be recorded; the Clinic Admins were told. */
  | 'admins_notified'
  /** Neither held nor told: the hold failed and there is no Clinic Admin. */
  | 'undelivered'

/**
 * Sends the alert to the patient's doctor if they are active; otherwise
 * holds it and tells the clinic's administrators, once per conversation. A
 * hold that fails is handed to `onHoldError` and the administrators are
 * told regardless. Any other failure is thrown for the caller to log.
 */
export async function raiseCriticalAlert(
  store: CriticalAlertStore,
  onHoldError: (error: unknown) => void,
): Promise<CriticalAlertOutcome> {
  const doctor = await store.assignedDoctor()
  if (doctor?.isActive) {
    await store.notifyDoctor(doctor.userId)
    return 'doctor_notified'
  }

  let hold: HoldOutcome | null
  try {
    hold = await store.holdAlert()
  } catch (error) {
    onHoldError(error)
    hold = null
  }
  if (hold === 'delivered') return 'doctor_notified'
  if (hold === 'already_held') return 'already_held'

  const admins = doctor ? await store.clinicAdminUserIds(doctor.clinicId) : []
  if (admins.length === 0) return hold ? 'held_no_admin' : 'undelivered'

  await store.notifyClinicAdmins(admins)
  return hold ? 'held' : 'admins_notified'
}

/** The database's answer to a hold, or an error if it is not one of them. */
export function toHoldOutcome(value: unknown): HoldOutcome {
  if (value === 'held' || value === 'already_held' || value === 'delivered') {
    return value
  }
  throw new Error('hold_chat_alert returned an unexpected outcome')
}

/**
 * One line per alert, beside `replyLogLine`: an id to find the request by,
 * and where the alert went. Built from these two fields only, so nothing a
 * patient wrote and no account or conversation id can reach the log.
 */
export function criticalAlertLogLine(entry: {
  requestId: string
  outcome: CriticalAlertOutcome
}): string {
  return JSON.stringify({
    event: 'chatbot_critical_alert',
    request_id: entry.requestId,
    outcome: entry.outcome,
  })
}
