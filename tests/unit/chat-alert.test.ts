import { describe, expect, it } from 'vitest'

import { CHAT_ALERT, chatAlertKind } from '@/features/notifications/chat-alert'
import { CRITICAL_ALERT_MESSAGE } from '../../supabase/functions/_shared/critical-escalation'
import { NEEDS_REVIEW_MESSAGE } from '../../supabase/functions/_shared/escalation'

/**
 * A chat alert is one of two things: the assistant judged that the patient
 * raised a concern, or the assistant could not answer at all. Both arrive as
 * `chat_critical`; the backend tells them apart by its own fixed message, and
 * so does the client. Patient text is never read.
 */
const alert = (notification_message: string, notification_type = 'chat_critical' as const) => ({
  notification_type,
  notification_message,
})

describe('telling the two chat alerts apart', () => {
  it('reads a concern as a concern', () => {
    expect(chatAlertKind(alert(CRITICAL_ALERT_MESSAGE))).toBe('concern')
  })

  it('reads an unanswered message as a service fault, not a concern', () => {
    expect(chatAlertKind(alert(NEEDS_REVIEW_MESSAGE))).toBe('unanswered')
  })

  it('treats a chat alert it does not recognise as a concern, so nothing real is played down', () => {
    expect(chatAlertKind(alert('Some older wording of an alert.'))).toBe('concern')
  })

  it('leaves every other notification alone', () => {
    expect(chatAlertKind({ notification_type: 'appointment', notification_message: NEEDS_REVIEW_MESSAGE })).toBeNull()
  })

  it('gives a concern amber and a fault neutral grey, never red', () => {
    expect(CHAT_ALERT.concern).toMatchObject({ label: 'Possible concern', tone: 'warning' })
    expect(CHAT_ALERT.unanswered).toMatchObject({ label: 'Unanswered message', tone: 'neutral' })
    expect(CHAT_ALERT.concern.icon).not.toBe(CHAT_ALERT.unanswered.icon)
  })
})
