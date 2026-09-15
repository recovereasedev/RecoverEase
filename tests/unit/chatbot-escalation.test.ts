import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  AssistantReplyError,
  parseAssistantReply,
} from '../../supabase/functions/_shared/assistant'
import {
  answerOrRequestReview,
  NEEDS_REVIEW_MESSAGE,
  requestReview,
  type ReviewRequestStore,
} from '../../supabase/functions/_shared/escalation'

/**
 * When the guidance assistant cannot answer a patient, their doctor is asked
 * to review the conversation - once, and without it being called a concern.
 *
 * Before this, a patient whose message met a provider outage, a timeout or
 * an unusable reply was told the assistant was unavailable, and nobody on the
 * care team was told anything.
 */

/** A store with one assigned, active doctor and nothing sent yet. */
function fakeStore(overrides: Partial<ReviewRequestStore> = {}) {
  const sent: string[] = []
  const store: ReviewRequestStore = {
    assignedDoctorUserId: async () => 'doctor-a',
    hasUnreadReviewRequest: async (doctorUserId) => sent.includes(doctorUserId),
    insertReviewRequest: async (doctorUserId) => {
      sent.push(doctorUserId)
    },
    ...overrides,
  }
  return { store, sent }
}

/** An error standing in for what chatbot-reply throws on each failure. */
class HttpFailure extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

describe('asking the doctor to review', () => {
  it('asks the patient’s assigned doctor', async () => {
    const { store, sent } = fakeStore()

    expect(await requestReview(store)).toBe('requested')
    expect(sent).toEqual(['doctor-a'])
  })

  it('asks nobody when there is no assigned, active doctor', async () => {
    const { store, sent } = fakeStore({ assignedDoctorUserId: async () => null })

    expect(await requestReview(store)).toBe('no_doctor')
    expect(sent).toEqual([])
  })

  it('asks once while the request is still unread, however often it fails', async () => {
    const { store, sent } = fakeStore()

    expect(await requestReview(store)).toBe('requested')
    expect(await requestReview(store)).toBe('already_requested')
    expect(await requestReview(store)).toBe('already_requested')
    expect(sent).toEqual(['doctor-a'])
  })

  it('says a message went unanswered, not that a concern was found', () => {
    expect(NEEDS_REVIEW_MESSAGE).toBe(
      "The guidance assistant could not answer a patient's message. Please review the conversation.",
    )
    expect(NEEDS_REVIEW_MESSAGE).not.toMatch(/concern|urgent|emergency|critical|crisis/i)
  })
})

describe('getting an answer, or asking for a review', () => {
  it('returns the answer and asks for nothing when the assistant replies', async () => {
    const review = vi.fn(async () => 'requested' as const)

    const answer = await answerOrRequestReview(
      async () => parseAssistantReply(
        '{"message":"Some stiffness is common.","safety_level":"normal","should_contact_provider":false}',
      ),
      review,
      vi.fn(),
    )

    expect(answer.message).toBe('Some stiffness is common.')
    expect(review).not.toHaveBeenCalled()
  })

  it.each([
    ['the provider returns an error', () => { throw new HttpFailure('The guidance assistant is unavailable.', 502) }],
    ['the provider is busy', () => { throw new HttpFailure('The guidance assistant is busy. Try again in a moment.', 429) }],
    ['the request times out', () => { throw new HttpFailure('The guidance assistant is unavailable.', 503) }],
    ['the assistant is not configured', () => { throw new HttpFailure('The guidance assistant is not configured.', 503) }],
    ['the reply is malformed', () => parseAssistantReply('this is not json')],
    ['the reply does not match the schema', () => parseAssistantReply('{"message":"Hi"}')],
    ['the reply cannot be saved', () => { throw new HttpFailure("The guidance assistant's reply could not be saved.", 500) }],
  ])('asks for a review, stores no answer, and passes the failure on when %s', async (_label, fail) => {
    const { store, sent } = fakeStore()
    const saved: string[] = []
    let thrown: unknown

    try {
      await answerOrRequestReview(
        async () => {
          const reply = fail() as { message: string }
          saved.push(reply.message)
          return reply
        },
        () => requestReview(store),
        vi.fn(),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(sent).toEqual(['doctor-a'])
    expect(saved).toEqual([])
  })

  it('passes the original failure on unchanged', async () => {
    const failure = new AssistantReplyError('The assistant returned malformed output')

    await expect(
      answerOrRequestReview(
        async () => {
          throw failure
        },
        async () => 'requested',
        vi.fn(),
      ),
    ).rejects.toBe(failure)
  })

  it('never lets a failed review request replace the original failure', async () => {
    const failure = new HttpFailure('The guidance assistant is unavailable.', 503)
    const reviewFailure = new Error('notification insert failed')
    const onReviewError = vi.fn()

    await expect(
      answerOrRequestReview(
        async () => {
          throw failure
        },
        async () => {
          throw reviewFailure
        },
        onReviewError,
      ),
    ).rejects.toBe(failure)
    expect(onReviewError).toHaveBeenCalledWith(reviewFailure)
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const answerStep = source.slice(
    source.indexOf('await answerOrRequestReview('),
    source.indexOf('const critical = raisesCriticalConcern(parsed)'),
  )
  const store = source.slice(
    source.indexOf('function reviewStore('),
    source.indexOf('Deno.serve('),
  )

  it('asks for a review only once the patient is owed an answer', () => {
    // Refusals - not yours, nothing to reply to - are not the assistant
    // failing to answer, and must not reach a doctor.
    expect(source.indexOf("'This conversation is not yours', 403")).toBeLessThan(
      source.indexOf('await answerOrRequestReview('),
    )
    expect(source.indexOf('if (!hasUnansweredPatientMessage(turns))')).toBeLessThan(
      source.indexOf('await answerOrRequestReview('),
    )
  })

  it('covers every way of failing to answer: configuration, the provider, the reply and saving it', () => {
    expect(answerStep).toContain("Deno.env.get('GEMINI_API_KEY')")
    expect(answerStep).toContain('fetch(GEMINI_ENDPOINT')
    expect(answerStep).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)')
    expect(answerStep).toContain('parseAssistantReply(extractOutputText(payload))')
    expect(answerStep).toContain("chat_message_role: 'assistant'")
    expect(answerStep).toContain(
      "() => requestReview(reviewStore(admin, patient.doc_id, chatSessionId))",
    )
  })

  it('treats a body that is not JSON as an unusable reply', () => {
    expect(answerStep).toMatch(
      /payload = await response\.json\(\)\s*\} catch \{\s*throw new AssistantReplyError/,
    )
  })

  it('writes an assistant message in one place only: the real reply', () => {
    expect(source.match(/chat_message_role: 'assistant'/g)).toHaveLength(1)
    expect(source).toContain('chat_message_content: parsed.message')
  })

  it('does not show a patient the database’s own error', () => {
    expect(source).not.toContain('new AuthError(insertError.message')
  })

  it('leaves the critical-concern flag and summary to a real concern', () => {
    expect(store).not.toContain("from('chat_session')")
    expect(store).not.toContain('chat_session_has_critical_flag')
    expect(source.indexOf('chat_session_has_critical_flag: true')).toBeGreaterThan(
      source.indexOf('const critical = raisesCriticalConcern(parsed)'),
    )
  })

  it('sends the review request to the assigned, active doctor, about this conversation, once', () => {
    expect(store).toContain(".eq('doc_id', docId)")
    expect(store).toContain('data?.doc_is_active ?')
    for (const filter of [
      ".eq('user_id', doctorUserId)",
      ".eq('chat_session_id', chatSessionId)",
      ".eq('notification_type', 'chat_critical')",
      ".eq('notification_message', NEEDS_REVIEW_MESSAGE)",
      ".eq('notification_is_read', false)",
    ]) {
      expect(store).toContain(filter)
    }
    expect(store).toContain('notification_message: NEEDS_REVIEW_MESSAGE')
  })
})
