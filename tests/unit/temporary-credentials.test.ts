import { describe, expect, it } from 'vitest'

import { generateTemporaryPassword } from '../../supabase/functions/_shared/credentials'

/**
 * The generator is shared by account creation and credential reset, so a
 * weakness here would apply to every account the clinic ever issues. These
 * assert the properties the workflow depends on rather than a fixed value.
 */
describe('generateTemporaryPassword', () => {
  const ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679'

  it('is four hyphenated groups of four', () => {
    expect(generateTemporaryPassword()).toMatch(
      /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    )
  })

  it('exceeds the application password policy of 12 characters', () => {
    // 16 characters of entropy; the hyphens are for reading it aloud.
    expect(generateTemporaryPassword().replace(/-/g, '')).toHaveLength(16)
  })

  it('omits characters that are misread when handed over', () => {
    // 0/O, 1/l/I, 5/S and 8/B are the pairs that cost a support call.
    for (let i = 0; i < 200; i += 1) {
      expect(generateTemporaryPassword()).not.toMatch(/[0O1lI5S8B]/)
    }
  })

  it('draws only from the intended alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      for (const character of generateTemporaryPassword().replace(/-/g, '')) {
        expect(ALPHABET).toContain(character)
      }
    }
  })

  it('does not repeat across accounts', () => {
    // A shared or cycling default would let anyone who learned one credential
    // reach the next account created.
    const drawn = new Set<string>()
    for (let i = 0; i < 500; i += 1) drawn.add(generateTemporaryPassword())
    expect(drawn.size).toBe(500)
  })

  it('does not concentrate on a few characters', () => {
    // A modulo bug or a broken source would collapse the range; 27 symbols
    // over 8000 draws should surface most of the alphabet.
    const seen = new Set<string>()
    for (let i = 0; i < 500; i += 1) {
      for (const c of generateTemporaryPassword().replace(/-/g, '')) seen.add(c)
    }
    expect(seen.size).toBe(ALPHABET.length)
  })
})
