import { describe, expect, it } from 'vitest'

import { generateTemporaryPassword } from '../../supabase/functions/_shared/credentials'
import { PASSPHRASE_WORDS } from '../../supabase/functions/_shared/word-list'

/**
 * The generator is shared by account creation and credential reset, so a
 * weakness here would apply to every account the clinic ever issues. These
 * assert the properties the workflow depends on rather than a fixed value.
 *
 * The format changed from a random symbol string to a four-word passphrase to
 * make it possible to read aloud and type. Everything the old format was
 * tested for is still tested for here — randomness, uniqueness, policy
 * compliance, no personal data — plus the properties the new shape introduces.
 */
describe('generateTemporaryPassword', () => {
  const FORMAT = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/

  it('is four lower-case words and a two-digit number', () => {
    expect(generateTemporaryPassword()).toMatch(FORMAT)
  })

  it('is lower case throughout, with no shift key required', () => {
    // A capital would have to be heard, remembered and typed correctly. It is
    // also what a phone keyboard adds on its own, silently, to the first word.
    for (let i = 0; i < 200; i += 1) {
      const issued = generateTemporaryPassword()
      expect(issued).toBe(issued.toLowerCase())
      expect(issued).not.toMatch(/[A-Z]/)
    }
  })

  it('satisfies the application password policy on every draw', () => {
    // The policy is twelve characters. The shortest possible passphrase is
    // four three-letter words, four hyphens and two digits.
    for (let i = 0; i < 500; i += 1) {
      const issued = generateTemporaryPassword()
      expect(issued.length).toBeGreaterThanOrEqual(12)
      expect(issued.length).toBeLessThanOrEqual(72)
    }
  })

  it('draws every word from the curated list', () => {
    for (let i = 0; i < 300; i += 1) {
      const [...parts] = generateTemporaryPassword().split('-')
      const number = parts.pop()
      expect(number).toMatch(/^\d{2}$/)
      for (const word of parts) expect(PASSPHRASE_WORDS).toContain(word)
    }
  })

  it('keeps the number two digits, never a leading zero', () => {
    // "oh-four" is misheard and mistyped; ten to ninety-nine is said once.
    for (let i = 0; i < 500; i += 1) {
      const number = generateTemporaryPassword().split('-').pop() as string
      expect(Number(number)).toBeGreaterThanOrEqual(10)
      expect(Number(number)).toBeLessThanOrEqual(99)
      expect(number.startsWith('0')).toBe(false)
    }
  })

  it('never repeats a word within one passphrase', () => {
    // A listener cannot tell a repeated word from a stutter, and the person
    // writing it down has no way to check which they heard.
    for (let i = 0; i < 500; i += 1) {
      const parts = generateTemporaryPassword().split('-')
      parts.pop()
      expect(new Set(parts).size).toBe(parts.length)
    }
  })

  it('does not repeat across accounts', () => {
    // A shared or cycling default would let anyone who learned one credential
    // reach the next account created.
    const drawn = new Set<string>()
    for (let i = 0; i < 2000; i += 1) drawn.add(generateTemporaryPassword())
    expect(drawn.size).toBe(2000)
  })

  it('spreads across the whole word list rather than a corner of it', () => {
    // A modulo bug, a truncated list or a broken source would collapse the
    // range. 4000 draws is ~8000 words over a 512-word list.
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i += 1) {
      const parts = generateTemporaryPassword().split('-')
      parts.pop()
      for (const word of parts) seen.add(word)
    }
    expect(seen.size).toBeGreaterThan(PASSPHRASE_WORDS.length * 0.9)
  })

  it('varies every position independently', () => {
    // Catches a generator that draws once and reuses the value, which would
    // look random in aggregate while being four copies of one choice.
    const columns: Set<string>[] = [new Set(), new Set(), new Set(), new Set()]
    for (let i = 0; i < 400; i += 1) {
      const parts = generateTemporaryPassword().split('-')
      parts.pop()
      parts.forEach((word, index) => columns[index].add(word))
    }
    for (const column of columns) expect(column.size).toBeGreaterThan(100)
  })

  it('embeds nothing about the account it belongs to', () => {
    // No name, email, birth date, contact number, role or identifier can
    // appear, because the generator is given none of them: it takes no
    // arguments at all. This asserts the shape that guarantees it.
    expect(generateTemporaryPassword).toHaveLength(0)

    const forbidden = [
      'recoverease', 'patient', 'doctor', 'admin', 'clinic', 'nurse',
      'smoke', 'test', 'temp', 'password', 'welcome', 'changeme',
    ]
    for (let i = 0; i < 300; i += 1) {
      const issued = generateTemporaryPassword().toLowerCase()
      for (const term of forbidden) expect(issued).not.toContain(term)
    }
  })
})

describe('the passphrase word list', () => {
  it('is exactly 512 words, so word selection is unbiased', () => {
    // Not cosmetic: 512 divides 2^32 exactly, so reducing a 32-bit draw into
    // the list is uniform. Any other size makes some words likelier.
    expect(PASSPHRASE_WORDS).toHaveLength(512)
    expect(PASSPHRASE_WORDS.length & (PASSPHRASE_WORDS.length - 1)).toBe(0)
  })

  it('has no duplicates, which would double a word’s odds', () => {
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length)
  })

  it('is lower-case letters only, short enough to read aloud', () => {
    for (const word of PASSPHRASE_WORDS) {
      expect(word).toMatch(/^[a-z]{3,10}$/)
    }
  })

  it('contains nothing clinical, alarming or identifying', () => {
    // This value is handed to someone recovering from surgery.
    const unsuitable = [
      'pain', 'death', 'dead', 'blood', 'tumour', 'tumor', 'cancer',
      'sick', 'ill', 'wound', 'scar', 'fever', 'virus', 'drug',
      'fail', 'error', 'panic', 'fear', 'hurt', 'worse',
      // Innocent in their everyday sense, wrong on a patient's screen:
      // a sewing needle still reads as an injection, and a marrow is a
      // vegetable everywhere except a hospital.
      'needle', 'marrow', 'patient',
    ]
    for (const term of unsuitable) {
      expect(PASSPHRASE_WORDS).not.toContain(term)
    }
  })
})
