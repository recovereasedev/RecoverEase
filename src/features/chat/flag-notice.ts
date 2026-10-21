/**
 * What a patient is told about a conversation flagged as a possible critical
 * concern (module 8.2).
 *
 * Only what the flag itself means. The flag is set before the alert is sent,
 * and the alert may go to their doctor, wait for a clinician while that
 * doctor's account is deactivated, or fail to be written
 * (docs/critical-alert-escalation.md). The page cannot know which, so it
 * never says anyone has been notified. It says what to do if it cannot wait.
 */
export const FLAGGED_CONVERSATION_NOTICE =
  'Something you raised in this conversation has been flagged for your care team. If you feel unwell or it’s urgent, don’t wait to hear from them: contact your doctor or emergency services now.'

/** Beside a flagged conversation in the patient's history. */
export const FLAGGED_CONVERSATION_BADGE = 'Flagged for your care team'
