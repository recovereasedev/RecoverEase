import { ESCALATION_FAILED_MESSAGE, EscalationError } from './critical-escalation.ts'

/**
 * Asking the patient's doctor to review a conversation the guidance
 * assistant could not answer.
 *
 * When `chatbot-reply` cannot give a patient an answer - the provider is
 * unconfigured, unreachable, slow, busy or erroring, it returns something
 * that does not satisfy the reply schema, or the reply cannot be saved - the
 * patient's own message is already stored, but nobody has read it. Before
 * this, that was where it ended: the patient was told the assistant was
 * unavailable, and no one on the care team was told anything.
 *
 * This is deliberately NOT the critical-concern alert (module 8.2). A failure
 * says nothing about what the patient wrote, so the conversation is not
 * flagged and no summary is written - both would tell the patient and the
 * doctor that a concern had been found. The doctor is sent a notification
 * that says only that a message went unanswered, with no clinical content,
 * and it opens the conversation like any other chat alert (module 8.5).
 *
 * One failure does say something: a reply that raised a concern, whose
 * escalation then failed (`critical-escalation.ts`). The request for that one
 * says a concern was detected - `reviewMessageFor` below - because "could not
 * answer" would pass a detected concern off as an outage.
 *
 * Free of Deno and of any database client, like `assistant.ts`, so the rules
 * can be tested in Node; `chatbot-reply` supplies the database side.
 */

export const NEEDS_REVIEW_MESSAGE =
  "The guidance assistant could not answer a patient's message. Please review the conversation."

/** The only two things a review request can say. Both are fixed text. */
export type ReviewMessage = typeof NEEDS_REVIEW_MESSAGE | typeof ESCALATION_FAILED_MESSAGE

/**
 * What to ask the doctor with, for the failure that ended the request: the
 * concern wording when a concern's escalation failed, and "could not answer"
 * for everything else. Decided by the kind of failure alone - nothing is
 * read from it.
 */
export function reviewMessageFor(failure: unknown): ReviewMessage {
  return failure instanceof EscalationError ? ESCALATION_FAILED_MESSAGE : NEEDS_REVIEW_MESSAGE
}

/** What asking for a review needs from the database, for one conversation. */
export type ReviewRequestStore = {
  /**
   * The user account of the patient's assigned doctor, or null when there is
   * none or they are deactivated - a deactivated doctor can no longer open
   * the conversation.
   */
  assignedDoctorUserId(): Promise<string | null>
  /** Whether that doctor already has an unread request saying this for it. */
  hasUnreadReviewRequest(doctorUserId: string, message: ReviewMessage): Promise<boolean>
  /** Writes the review request. Throws when it could not be written. */
  insertReviewRequest(doctorUserId: string, message: ReviewMessage): Promise<void>
}

export type ReviewRequestOutcome = 'requested' | 'already_requested' | 'no_doctor'

/**
 * Asks the assigned doctor to review the conversation, once. While a request
 * is still unread the conversation is not asked about again, so a patient
 * who keeps trying during the same outage produces one notification, not one
 * per attempt. Each message is asked once on its own: an unread "could not
 * answer" never holds back the one that says a concern was detected.
 *
 * With no assigned, active doctor nobody is asked, whichever message it is -
 * a detected concern included. Every patient has a doctor on record, so this
 * is the window in which that doctor is deactivated and the patients have not
 * been moved yet. Telling anyone else is not decided here: only the patient
 * and their active doctor can open a conversation. What is left of a concern
 * then is the flag on the conversation when the failure came after it was
 * set, and the log: `chatbot-reply`'s line for the failed escalation, and the
 * line `answerOrRequestReview` writes to say that nobody was told.
 */
export async function requestReview(
  store: ReviewRequestStore,
  message: ReviewMessage = NEEDS_REVIEW_MESSAGE,
): Promise<ReviewRequestOutcome> {
  const doctorUserId = await store.assignedDoctorUserId()
  if (!doctorUserId) return 'no_doctor'
  if (await store.hasUnreadReviewRequest(doctorUserId, message)) return 'already_requested'
  await store.insertReviewRequest(doctorUserId, message)
  return 'requested'
}

/**
 * Runs `produce` - getting the assistant's answer and saving it - and, if
 * that fails for any reason, asks for a review before letting the failure
 * through unchanged. `review` is given the failure, so it can choose what to
 * ask with. The patient's response is still the failure: nothing here invents
 * an answer. A review request that itself fails is handed to `onReviewError`
 * and never replaces the original error.
 *
 * When the failure was a concern's escalation and there was no active doctor
 * to ask, the concern has reached nobody: `logUnreachedConcern` is given one
 * fixed line saying so, once per failed attempt. No other failure writes it -
 * an unanswered message with no doctor to ask is logged as it was before. A
 * line that cannot be written changes nothing else.
 */
export async function answerOrRequestReview<T>(
  produce: () => Promise<T>,
  review: (failure: unknown) => Promise<ReviewRequestOutcome>,
  onReviewError: (error: unknown) => void,
  logUnreachedConcern?: (line: string) => void,
): Promise<T> {
  try {
    return await produce()
  } catch (error) {
    try {
      const outcome = await review(error)
      if (error instanceof EscalationError && outcome === 'no_doctor') {
        try {
          logUnreachedConcern?.(noActiveDoctorLogLine(error.step))
        } catch {
          // A line that cannot be written is not a review request that failed,
          // so it is not reported as one; there is nowhere else to say it.
        }
      }
    } catch (reviewError) {
      onReviewError(reviewError)
    }
    throw error
  }
}

/** Every step an escalation can fail at; the type keeps it to real ones. */
const ESCALATION_STEPS: readonly EscalationError['step'][] = ['flag', 'doctor', 'dedupe', 'alert']

/**
 * One line for a detected concern that reached nobody: its escalation failed
 * at this step, and the patient's doctor is deactivated, so no review was
 * asked for either. The step is checked against what it may be and the rest
 * is fixed text - no patient, no conversation, nothing anyone wrote.
 */
function noActiveDoctorLogLine(escalationStep: unknown): string {
  return JSON.stringify({
    event: 'critical_escalation_fallback_no_active_doctor',
    escalation_step: ESCALATION_STEPS.find((step) => step === escalationStep) ?? null,
    recipient_state: 'no_active_doctor',
  })
}

/**
 * One line for a review request that could not be written: the kind of error
 * and, when it was a concern's escalation that had failed, at which step - a
 * detected concern that reached nobody must be findable in the log. Built
 * from those two fields only, each checked against what it may be, so nothing
 * a patient wrote and no reply can reach the log.
 */
export function reviewFailureLogLine(reviewError: unknown, escalationStep: unknown): string {
  const name = reviewError instanceof Error ? reviewError.name : ''
  return JSON.stringify({
    event: 'review_request_failed',
    error: /^\w{1,40}$/.test(name) ? name : 'unknown',
    escalation_step: ESCALATION_STEPS.find((step) => step === escalationStep) ?? null,
  })
}
