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
 * Free of Deno and of any database client, like `assistant.ts`, so the rules
 * can be tested in Node; `chatbot-reply` supplies the database side.
 */

export const NEEDS_REVIEW_MESSAGE =
  "The guidance assistant could not answer a patient's message. Please review the conversation."

/** What asking for a review needs from the database, for one conversation. */
export type ReviewRequestStore = {
  /**
   * The user account of the patient's assigned doctor, or null when there is
   * none or they are deactivated - a deactivated doctor can no longer open
   * the conversation.
   */
  assignedDoctorUserId(): Promise<string | null>
  /** Whether that doctor already has an unread review request for it. */
  hasUnreadReviewRequest(doctorUserId: string): Promise<boolean>
  /** Writes the review request. Throws when it could not be written. */
  insertReviewRequest(doctorUserId: string): Promise<void>
}

export type ReviewRequestOutcome = 'requested' | 'already_requested' | 'no_doctor'

/**
 * Asks the assigned doctor to review the conversation, once. While a request
 * is still unread the conversation is not asked about again, so a patient
 * who keeps trying during the same outage produces one notification, not one
 * per attempt.
 */
export async function requestReview(
  store: ReviewRequestStore,
): Promise<ReviewRequestOutcome> {
  const doctorUserId = await store.assignedDoctorUserId()
  if (!doctorUserId) return 'no_doctor'
  if (await store.hasUnreadReviewRequest(doctorUserId)) return 'already_requested'
  await store.insertReviewRequest(doctorUserId)
  return 'requested'
}

/**
 * Runs `produce` - getting the assistant's answer and saving it - and, if
 * that fails for any reason, asks for a review before letting the failure
 * through unchanged. The patient's response is still the failure: nothing
 * here invents an answer. A review request that itself fails is handed to
 * `onReviewError` and never replaces the original error.
 */
export async function answerOrRequestReview<T>(
  produce: () => Promise<T>,
  review: () => Promise<ReviewRequestOutcome>,
  onReviewError: (error: unknown) => void,
): Promise<T> {
  try {
    return await produce()
  } catch (error) {
    try {
      await review()
    } catch (reviewError) {
      onReviewError(reviewError)
    }
    throw error
  }
}
