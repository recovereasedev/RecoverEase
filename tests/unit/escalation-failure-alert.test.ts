import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  type AssistantReply,
  AssistantReplyError,
  parseAssistantReply,
} from '../../supabase/functions/_shared/assistant'
import {
  CRITICAL_ALERT_MESSAGE,
  type CriticalEscalationStore,
  ESCALATION_FAILED_MESSAGE,
  EscalationError,
  escalateCriticalConcern,
} from '../../supabase/functions/_shared/critical-escalation'
import {
  answerOrRequestReview,
  NEEDS_REVIEW_MESSAGE,
  requestReview,
  reviewFailureLogLine,
  reviewMessageFor,
  type ReviewRequestStore,
} from '../../supabase/functions/_shared/escalation'

/**
 * A reply that raised a concern, whose escalation then failed.
 *
 * The request fails and the doctor is asked to review the conversation
 * (tests/unit/chatbot-escalation.test.ts). That request used to say only that
 * the assistant "could not answer" - the words for an outage - so a concern
 * the assistant had detected reached the doctor looking like a technical
 * fault. It now carries its own fixed message, and every other failure keeps
 * the old one.
 */

const URGENT: AssistantReply = {
  message: 'Please contact emergency services now.',
  safety_level: 'urgent',
  should_contact_provider: true,
}
const NORMAL: AssistantReply = {
  message: 'That is common during recovery.',
  safety_level: 'normal',
  should_contact_provider: false,
}

/** What a patient might have written. It must never reach a row or a log. */
const PATIENT_TEXT = 'my wound is bleeding through the dressing'

type EscalationStep = EscalationError['step']
type Row = { doctor: string; message: string; read: boolean }

/**
 * One notification table behind both stores, as in the database: the concern
 * alert and the review request are rows of the same kind. Each write can be
 * made to fail on its own, as a query that times out does.
 */
function fakeDatabase(options: {
  fail?: Partial<Record<EscalationStep | 'review', boolean>>
  activeDoctor?: string | null
  rows?: Row[]
} = {}) {
  const rows: Row[] = options.rows ?? []
  const fail = { ...options.fail }
  const down = () => new Error(`db down while saving: ${PATIENT_TEXT}`)

  const critical: CriticalEscalationStore = {
    async flagConversation() {
      if (fail.flag) throw down()
    },
    async doctorUserId() {
      if (fail.doctor) throw down()
      return 'doctor-1'
    },
    async hasConcernAlertSince(doctor) {
      if (fail.dedupe) throw down()
      return rows.some((row) => row.doctor === doctor && row.message === CRITICAL_ALERT_MESSAGE)
    },
    async insertConcernAlert(doctor) {
      if (fail.alert) throw down()
      rows.push({ doctor, message: CRITICAL_ALERT_MESSAGE, read: false })
    },
  }
  const review: ReviewRequestStore = {
    assignedDoctorUserId: async () =>
      options.activeDoctor === undefined ? 'doctor-1' : options.activeDoctor,
    hasUnreadReviewRequest: async (doctor, message) =>
      rows.some((row) => row.doctor === doctor && row.message === message && !row.read),
    insertReviewRequest: async (doctor, message) => {
      if (fail.review) throw down()
      rows.push({ doctor, message, read: false })
    },
  }
  return { rows, fail, critical, review }
}

/**
 * The answer step of chatbot-reply, wired the way the function wires it: the
 * reply is escalated, then saved, and whatever fails is handed to the review
 * request. ("chatbot-reply" below pins the function to this same wiring.)
 */
async function answer(
  db: ReturnType<typeof fakeDatabase>,
  options: {
    reply?: () => AssistantReply
    save?: () => void
    onReviewError?: (error: unknown) => void
    log?: (line: string) => void
  } = {},
) {
  let thrown: unknown
  try {
    await answerOrRequestReview(
      async () => {
        const parsed = (options.reply ?? (() => URGENT))()
        await escalateCriticalConcern(db.critical, parsed, null)
        options.save?.()
        return parsed
      },
      (error) => requestReview(db.review, reviewMessageFor(error)),
      options.onReviewError ?? vi.fn(),
      options.log,
    )
  } catch (error) {
    thrown = error
  }
  return thrown
}

const messages = (rows: Row[]) => rows.map((row) => row.message)

describe('the message for a concern whose escalation failed', () => {
  it('says a concern was detected, that escalation was not completed, and asks for a review', () => {
    expect(ESCALATION_FAILED_MESSAGE).toBe(
      'A possible concern was detected in the guidance chat, but automatic escalation could not be completed. Please review the conversation.',
    )
  })

  it('is not the wording of an assistant that merely could not answer, nor the alert itself', () => {
    expect(ESCALATION_FAILED_MESSAGE).not.toBe(NEEDS_REVIEW_MESSAGE)
    expect(ESCALATION_FAILED_MESSAGE).not.toBe(CRITICAL_ALERT_MESSAGE)
    expect(ESCALATION_FAILED_MESSAGE).not.toMatch(/could not answer/i)
  })

  it('carries no clinical detail', () => {
    expect(ESCALATION_FAILED_MESSAGE).not.toMatch(
      /swelling|pain|bleed|wound|medic|dose|symptom|diagnos|urgent|emergency/i,
    )
  })
})

describe('which message a failure asks for', () => {
  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'the concern message when escalation failed at the %s step',
    (step) => {
      expect(reviewMessageFor(new EscalationError(step))).toBe(ESCALATION_FAILED_MESSAGE)
    },
  )

  it.each([
    ['a provider failure', new Error('The guidance assistant is unavailable.')],
    ['an unusable reply', new AssistantReplyError('The assistant returned malformed output')],
    ['a reply that could not be saved', new Error("The guidance assistant's reply could not be saved.")],
    ['something that is not an error', 'escalation_failed'],
    ['nothing', undefined],
  ])('the ordinary message for %s', (_label, failure) => {
    expect(reviewMessageFor(failure)).toBe(NEEDS_REVIEW_MESSAGE)
  })

  it('takes nothing from the failure itself', () => {
    const failure = new EscalationError('alert', { cause: new Error(PATIENT_TEXT) })

    expect(reviewMessageFor(failure)).toBe(ESCALATION_FAILED_MESSAGE)
  })
})

describe('a reply that raises a concern', () => {
  it('alerts the doctor as before when escalation succeeds, and asks for no review', async () => {
    const db = fakeDatabase()

    expect(await answer(db)).toBeUndefined()
    expect(messages(db.rows)).toEqual([CRITICAL_ALERT_MESSAGE])
  })

  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'tells the doctor a concern was detected when the %s step fails',
    async (step) => {
      const db = fakeDatabase({ fail: { [step]: true } })

      const thrown = await answer(db)

      // The request still fails as an escalation failure, unchanged.
      expect(thrown).toBeInstanceOf(EscalationError)
      expect((thrown as EscalationError).step).toBe(step)
      expect(db.rows).toEqual([{ doctor: 'doctor-1', message: ESCALATION_FAILED_MESSAGE, read: false }])
      expect(messages(db.rows)).not.toContain(NEEDS_REVIEW_MESSAGE)
    },
  )

  it('writes nothing of what the patient or the assistant wrote', async () => {
    const db = fakeDatabase({ fail: { alert: true } })

    await answer(db)

    expect(db.rows).toHaveLength(1)
    for (const row of db.rows) {
      expect(row.message).not.toContain(PATIENT_TEXT)
      expect(row.message).not.toContain(URGENT.message)
    }
  })
})

describe('an ordinary failure to answer', () => {
  it.each([
    ['the provider fails', { reply: () => { throw new Error('The guidance assistant is unavailable.') } }],
    ['the reply is malformed', { reply: () => parseAssistantReply('this is not json') }],
    ['a reply with no concern cannot be saved', { reply: () => NORMAL, save: () => { throw new Error('save failed') } }],
  ])('keeps the "could not answer" message when %s', async (_label, options) => {
    const db = fakeDatabase()

    expect(await answer(db, options)).toBeInstanceOf(Error)
    expect(messages(db.rows)).toEqual([NEEDS_REVIEW_MESSAGE])
  })

  it('keeps it when a concern was escalated and only the save failed', async () => {
    const db = fakeDatabase()

    await answer(db, { save: () => { throw new Error('save failed') } })

    // The alert was delivered; what is missing is the reply.
    expect(messages(db.rows)).toEqual([CRITICAL_ALERT_MESSAGE, NEEDS_REVIEW_MESSAGE])
  })
})

describe('asking once', () => {
  it('does not repeat the concern message while it is unread', async () => {
    const db = fakeDatabase({ fail: { alert: true } })

    await answer(db)
    await answer(db)
    await answer(db)

    expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE])
  })

  it('sends it again once the earlier one has been read', async () => {
    const db = fakeDatabase({ fail: { alert: true } })

    await answer(db)
    db.rows[0]!.read = true
    await answer(db)

    expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE, ESCALATION_FAILED_MESSAGE])
  })

  it('is not held back by an unread "could not answer" request', async () => {
    const db = fakeDatabase({
      fail: { alert: true },
      rows: [{ doctor: 'doctor-1', message: NEEDS_REVIEW_MESSAGE, read: false }],
    })

    await answer(db)

    expect(messages(db.rows)).toEqual([NEEDS_REVIEW_MESSAGE, ESCALATION_FAILED_MESSAGE])
  })

  it('does not hold back a later "could not answer" request either', async () => {
    const db = fakeDatabase({ fail: { alert: true } })

    await answer(db)
    await answer(db, { reply: () => { throw new Error('The guidance assistant is unavailable.') } })

    expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE, NEEDS_REVIEW_MESSAGE])
  })

  it('is followed by the alert itself when the patient’s retry escalates', async () => {
    const db = fakeDatabase({ fail: { alert: true } })

    await answer(db)
    db.fail.alert = false
    expect(await answer(db)).toBeUndefined()

    expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE, CRITICAL_ALERT_MESSAGE])
  })
})

describe('when the review request cannot be written either', () => {
  it('fails the request as it would have, reports the failure, and claims nothing was sent', async () => {
    const db = fakeDatabase({ fail: { alert: true, review: true } })
    const onReviewError = vi.fn()

    const thrown = await answer(db, { onReviewError })

    expect(thrown).toBeInstanceOf(EscalationError)
    expect(onReviewError).toHaveBeenCalledTimes(1)
    // No row at all: in particular, no "could not answer" request in its place.
    expect(db.rows).toEqual([])
  })

  it('logs the kind of error and the escalation step, and nothing else', () => {
    const line = reviewFailureLogLine(new TypeError(`insert failed: ${PATIENT_TEXT}`), 'alert')

    expect(JSON.parse(line)).toEqual({
      event: 'review_request_failed',
      error: 'TypeError',
      escalation_step: 'alert',
    })
    expect(line).not.toContain('bleeding')
  })

  it('logs no step for an ordinary failure, and drops anything that is not a step or a plain name', () => {
    expect(JSON.parse(reviewFailureLogLine(new Error('x'), undefined))).toEqual({
      event: 'review_request_failed',
      error: 'Error',
      escalation_step: null,
    })

    const named = new Error('x')
    named.name = PATIENT_TEXT
    const line = reviewFailureLogLine(named, `patient said: ${PATIENT_TEXT}`)
    expect(JSON.parse(line)).toEqual({
      event: 'review_request_failed',
      error: 'unknown',
      escalation_step: null,
    })
    expect(JSON.parse(reviewFailureLogLine({ message: PATIENT_TEXT }, 'flag')).error).toBe('unknown')

    // A class name with a digit is still a name.
    const numbered = new Error('x')
    numbered.name = 'Http2Error'
    expect(JSON.parse(reviewFailureLogLine(numbered, 'dedupe'))).toMatchObject({
      error: 'Http2Error',
      escalation_step: 'dedupe',
    })
  })
})

/**
 * Every patient has a doctor on record, so "no active doctor" is the window in
 * which that doctor is deactivated and the patients have not been moved yet.
 * The review request is addressed to the assigned doctor while they are
 * active, and to nobody else: there is no second recipient.
 */
describe('when the patient’s doctor is deactivated', () => {
  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'alerts no one when the %s step fails, and does not claim to have',
    async (step) => {
      const db = fakeDatabase({ fail: { [step]: true }, activeDoctor: null })
      const onReviewError = vi.fn()

      // The patient still gets the escalation failure, and can ask again.
      expect(await answer(db, { onReviewError })).toBeInstanceOf(EscalationError)
      // No row for anyone: not the concern message, not "could not answer".
      expect(db.rows).toEqual([])
      // Nobody to ask is not an error, so nothing is reported as one.
      expect(onReviewError).not.toHaveBeenCalled()
    },
  )

  it('reports that there was no doctor to ask, whichever message it was', async () => {
    const db = fakeDatabase({ activeDoctor: null })

    expect(await requestReview(db.review, ESCALATION_FAILED_MESSAGE)).toBe('no_doctor')
    expect(await requestReview(db.review, NEEDS_REVIEW_MESSAGE)).toBe('no_doctor')
    expect(db.rows).toEqual([])
  })
})

/**
 * That window is the one case in which a detected concern reaches nobody, so
 * it is said in the log: one fixed line per failed attempt, carrying the step
 * and nothing about the patient, the conversation or what was written.
 */
describe('the log line for a concern that reached nobody', () => {
  const NO_ACTIVE_DOCTOR_EVENT = 'critical_escalation_fallback_no_active_doctor'
  const lines = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([line]) => String(line))

  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'is written once, with the step and nothing else, when the %s step fails and the doctor is deactivated',
    async (step) => {
      const db = fakeDatabase({ fail: { [step]: true }, activeDoctor: null })
      const log = vi.fn()

      expect(await answer(db, { log })).toBeInstanceOf(EscalationError)

      expect(db.rows).toEqual([])
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(lines(log)[0]!)).toEqual({
        event: NO_ACTIVE_DOCTOR_EVENT,
        escalation_step: step,
        recipient_state: 'no_active_doctor',
      })
    },
  )

  it('is written once for each attempt, not once more for the same one', async () => {
    const db = fakeDatabase({ fail: { alert: true }, activeDoctor: null })
    const log = vi.fn()

    await answer(db, { log })
    expect(log).toHaveBeenCalledTimes(1)
    await answer(db, { log })
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('carries nothing a patient or the assistant wrote, and names no one', async () => {
    // The failure that set this off carries the patient's words as its cause.
    const db = fakeDatabase({ fail: { alert: true }, activeDoctor: null })
    const log = vi.fn()

    await answer(db, { log })

    const [line] = lines(log)
    expect(line).not.toContain(PATIENT_TEXT)
    expect(line).not.toContain('bleeding')
    expect(line).not.toContain(URGENT.message)
    expect(line).not.toContain('doctor-1')
    expect(Object.keys(JSON.parse(line!))).toEqual(['event', 'escalation_step', 'recipient_state'])
  })

  it('drops a step that is not one of the four', async () => {
    const log = vi.fn()

    await answerOrRequestReview(
      async () => {
        throw new EscalationError(PATIENT_TEXT as EscalationStep)
      },
      async () => 'no_doctor',
      vi.fn(),
      log,
    ).catch(() => undefined)

    expect(JSON.parse(lines(log)[0]!)).toEqual({
      event: NO_ACTIVE_DOCTOR_EVENT,
      escalation_step: null,
      recipient_state: 'no_active_doctor',
    })
  })

  it.each(['flag', 'doctor', 'dedupe', 'alert'] as const)(
    'is not written when the doctor is there to be told that the %s step failed',
    async (step) => {
      const db = fakeDatabase({ fail: { [step]: true } })
      const log = vi.fn()

      await answer(db, { log })

      expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE])
      expect(log).not.toHaveBeenCalled()
    },
  )

  it('is not written when the doctor already has the request unread', async () => {
    const db = fakeDatabase({ fail: { alert: true } })
    const log = vi.fn()

    await answer(db, { log })
    await answer(db, { log })

    expect(messages(db.rows)).toEqual([ESCALATION_FAILED_MESSAGE])
    expect(log).not.toHaveBeenCalled()
  })

  it('is not written when a concern is escalated', async () => {
    const db = fakeDatabase({ activeDoctor: null })
    const log = vi.fn()

    expect(await answer(db, { log })).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['with a doctor to ask', undefined, [NEEDS_REVIEW_MESSAGE]],
    ['with the doctor deactivated', null, []],
  ] as const)('is not written for an ordinary failure to answer, %s', async (_label, activeDoctor, expected) => {
    const db = fakeDatabase({ activeDoctor })
    const log = vi.fn()
    const onReviewError = vi.fn()

    const thrown = await answer(db, {
      log,
      onReviewError,
      reply: () => { throw new Error('The guidance assistant is unavailable.') },
    })

    // As before: the same failure, the same request or none, nothing logged.
    expect(thrown).not.toBeInstanceOf(EscalationError)
    expect(messages(db.rows)).toEqual(expected)
    expect(log).not.toHaveBeenCalled()
    expect(onReviewError).not.toHaveBeenCalled()
  })

  it('is not written when the request could not be written: that has its own line', async () => {
    const db = fakeDatabase({ fail: { alert: true, review: true } })
    const log = vi.fn()
    const onReviewError = vi.fn()

    expect(await answer(db, { log, onReviewError })).toBeInstanceOf(EscalationError)

    expect(db.rows).toEqual([])
    expect(onReviewError).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('never replaces the failure when it cannot be written, and is not reported as a failed request', async () => {
    const db = fakeDatabase({ fail: { alert: true }, activeDoctor: null })
    const onReviewError = vi.fn()

    const thrown = await answer(db, {
      onReviewError,
      log: () => { throw new Error(`log sink failed: ${PATIENT_TEXT}`) },
    })

    // The patient's failure is still the escalation's, at the step it failed.
    expect(thrown).toBeInstanceOf(EscalationError)
    expect((thrown as EscalationError).step).toBe('alert')
    // No request was attempted, so none failed: that line would be untrue.
    expect(onReviewError).not.toHaveBeenCalled()
    expect(db.rows).toEqual([])
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const answerStep = source.slice(
    source.indexOf('await answerOrRequestReview('),
    source.indexOf('if (answeredElsewhere)'),
  )
  const store = source.slice(
    source.indexOf('function reviewStore('),
    source.indexOf('function criticalStore('),
  )

  it('chooses the review message from the failure, as the tests above do', () => {
    expect(answerStep).toContain(
      '(error) => requestReview(reviewStore(admin, patient.doc_id, chatSessionId), reviewMessageFor(error)),',
    )
  })

  it('hands an escalation failure on as itself, so the review request can tell', () => {
    const escalationCatch = answerStep.slice(
      answerStep.indexOf('escalateCriticalConcern('),
      answerStep.indexOf('const replyId = await replyIdFor('),
    )
    expect(escalationCatch).toContain('if (error instanceof EscalationError) {')
    expect(escalationCatch).toContain('throw error')
    expect(escalationCatch).not.toContain('new ReplyError(')
  })

  it('still answers the patient with the same failure', () => {
    // Status, code and wording as before; only comments may sit in between.
    expect(source).toMatch(
      /if \(error instanceof EscalationError\) \{(?:\s*\/\/[^\n]*)*\s*return respond\(\s*\{ error: 'The guidance assistant is unavailable\.' \},\s*503,\s*'escalation_failed',?\s*\)/,
    )
  })

  it('writes the chosen message as a chat alert for this conversation and its doctor', () => {
    expect(store).toContain('async insertReviewRequest(doctorUserId, message) {')
    for (const column of [
      'user_id: doctorUserId,',
      'chat_session_id: chatSessionId,',
      "notification_type: 'chat_critical',",
      'notification_message: message,',
    ]) {
      expect(store).toContain(column)
    }
    // Only the two fixed messages can be written: nothing is built here.
    expect(store).not.toMatch(/notification_message: [`'"]/)
  })

  it('logs a review request that failed through the one fixed line', () => {
    expect(answerStep).toContain(
      '(error) => console.error(reviewFailureLogLine(error, facts.escalationStep)),',
    )
  })

  it('logs a concern that reached nobody through the one fixed line, and builds none of its own', () => {
    expect(answerStep).toMatch(
      /reviewFailureLogLine\(error, facts\.escalationStep\)\),\s*\(line\) => console\.error\(line\),\s*\)/,
    )
    expect(source).not.toContain('no_active_doctor')
  })
})
