import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  chronologicalWindow,
  hasUnansweredPatientMessage,
  HISTORY_LIMIT,
  toInteractionInput,
  type StoredMessage,
} from '../../supabase/functions/_shared/assistant'

/**
 * Which messages of a conversation the guidance assistant is given: the
 * newest forty, oldest first.
 *
 * `chatbot-reply` used to read the oldest forty. A conversation past forty
 * messages was cut off at its fortieth, so the patient's latest question -
 * and anything concerning in it - never reached the model.
 */

/** A conversation of `count` messages, oldest first, ending on the patient. */
function conversation(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    chat_message_role: (count - 1 - index) % 2 === 0 ? 'patient' : 'assistant',
    chat_message_content: `Message ${index + 1}`,
  }))
}

/** What the history query returns: the same rows, newest first. */
const asQueried = (rows: StoredMessage[]) => [...rows].reverse()

const numbers = (rows: StoredMessage[]) =>
  rows.map((row) => Number(row.chat_message_content?.replace('Message ', '')))

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

describe('the conversation window', () => {
  it('is forty messages', () => {
    expect(HISTORY_LIMIT).toBe(40)
  })

  it.each([
    [0, []],
    [1, [1]],
    [39, range(1, 39)],
    [40, range(1, 40)],
    [41, range(2, 41)],
    [50, range(11, 50)],
    [120, range(81, 120)],
  ])('of a %i-message conversation is the newest forty at most, oldest first', (count, expected) => {
    expect(numbers(chronologicalWindow(asQueried(conversation(count))))).toEqual(expected)
  })

  it('always ends on the patient’s latest message, so there is something to answer', () => {
    for (const count of [1, 39, 40, 41, 50, 120]) {
      const turns = toInteractionInput(chronologicalWindow(asQueried(conversation(count))))

      expect(turns.at(-1)).toEqual({
        type: 'user_input',
        content: [{ type: 'text', text: `Message ${count}` }],
      })
      expect(hasUnansweredPatientMessage(turns)).toBe(true)
    }
  })

  it('keeps a recent concerning message in what the model reads', () => {
    const rows = conversation(50)
    rows[47] = {
      chat_message_role: 'patient',
      chat_message_content: 'My wound is hot and swollen and I have a fever.',
    }

    const window = chronologicalWindow(asQueried(rows))

    expect(window.map((row) => row.chat_message_content)).toContain(
      'My wound is hot and swollen and I have a fever.',
    )
  })

  it('does not change the rows it is given', () => {
    const rows = asQueried(conversation(45))
    const before = [...rows]

    chronologicalWindow(rows)

    expect(rows).toEqual(before)
  })

  it('is what the old window got wrong', () => {
    // Oldest first, then limited: what the query used to return.
    const oldWindow = conversation(50).slice(0, HISTORY_LIMIT)

    expect(numbers(oldWindow)).toEqual(range(1, 40))
    expect(toInteractionInput(oldWindow).at(-1)?.content[0]?.text).toBe('Message 40')
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  // The first read of chat_message is the history; the second is the insert.
  const historyQuery = source.slice(
    source.indexOf(".from('chat_message')"),
    source.indexOf('.limit(HISTORY_LIMIT)') + '.limit(HISTORY_LIMIT)'.length,
  )

  it('reads only this conversation, newest first with a tie-breaker, capped at the window', () => {
    expect(historyQuery).toContain(".eq('chat_session_id', chatSessionId)")
    expect(historyQuery).toMatch(
      /\.order\('chat_message_created_at', \{ ascending: false \}\)\s*\.order\('chat_message_id', \{ ascending: false \}\)\s*\.limit\(HISTORY_LIMIT\)$/,
    )
  })

  it('puts the window back in order before building the model input', () => {
    expect(source).toContain('const history = chronologicalWindow(newestFirst)')
    expect(source.indexOf('chronologicalWindow(newestFirst)')).toBeLessThan(
      source.indexOf('toInteractionInput(history)'),
    )
  })

  it('still proves the conversation is the caller’s before reading any of it', () => {
    expect(source.indexOf("'This conversation is not yours', 403")).toBeLessThan(
      source.indexOf(".from('chat_message')"),
    )
  })

  it('uses the shared window size rather than one of its own', () => {
    expect(source).not.toMatch(/const HISTORY_LIMIT/)
    expect(source).toMatch(/import \{[^}]*\bHISTORY_LIMIT\b[^}]*\} from '\.\.\/_shared\/assistant\.ts'/)
  })
})
