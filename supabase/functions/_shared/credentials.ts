import { PASSPHRASE_WORDS } from './word-list.ts'

/**
 * Single-use credentials for account onboarding and recovery.
 *
 * Shared so that a password issued by a reset is indistinguishable in
 * strength and shape from one issued at creation. Two copies of this would
 * eventually drift, and the weaker one would decide the security of the
 * system.
 *
 * ---------------------------------------------------------------------------
 * Why this is a passphrase and no longer a random string
 * ---------------------------------------------------------------------------
 *
 * The previous format was sixteen characters from a 27-symbol alphabet,
 * `WXYZ-2345-...`. It is stronger on paper and worse in every way that
 * decides whether an account is actually reachable, because of how it is
 * delivered: a clinician reads it aloud to the person in front of them, who
 * writes it down and types it later. Three formats were weighed against that
 * moment rather than against a spreadsheet:
 *
 *   A. `WXYZ-2345-KMNP-QRTU` — 16 symbols, ~76 bits.
 *      Unbeatable entropy. Nineteen characters with no meaning, every one a
 *      chance to hear D for T or write 4 for A, and nothing to hold in
 *      memory between the desk and the ward. This is the format people give
 *      up on, and the format that generates the support call the reset
 *      button exists to answer.
 *
 *   B. Three words plus four digits, `cedar-harbor-willow-4271` — ~40 bits.
 *      Shorter, but ends in an unmemorable four-digit run that has the same
 *      transcription problem in miniature, and buys less entropy per typed
 *      character than a fourth word does.
 *
 *   C. Four words plus two digits — CHOSEN. ~42.6 bits: 512^4 × 100, or
 *      about 6.9 × 10^12. Four things a person can picture, in an order
 *      they can repeat, followed by a number small enough to hear once.
 *
 * C is deliberately weaker than A, by roughly 33 bits, and that trade is
 * only defensible because of what this credential is:
 *
 *   - it is single use — the forced setup gate replaces it at first sign-in,
 *     and `complete-password-setup` refuses to run twice;
 *   - it is online only. There is no hash to attack offline; every guess is
 *     an HTTP request to Supabase Auth against its own rate limits;
 *   - it is short-lived by workflow — it is handed over to be used, not
 *     stored, and an unused one can be reissued rather than left standing.
 *
 * At Supabase's documented starting posture of tens of attempts per hour,
 * 6.9 × 10^12 possibilities is not searchable in any human timeframe: even at
 * an implausible thousand guesses a second it is over two hundred years. What
 * A bought over C was resistance to offline cracking, which is not a threat
 * this value is exposed to.
 *
 * The permanent password policy is untouched. This is the credential the
 * account holder is handed; the one they choose still has to clear the same
 * twelve-character minimum it always did.
 *
 * ---------------------------------------------------------------------------
 * Case
 * ---------------------------------------------------------------------------
 *
 * Lower case throughout, deliberately. Supabase passwords are case sensitive,
 * so the safest thing to issue is the form with no shift key in it and no
 * capitalisation to remember or mishear — "all small letters" is the whole
 * rule, and it is one a person can be told once. The password policy is
 * length-based, so nothing is lost by it. Anywhere this value is typed, the
 * field must also switch off autocapitalisation, or a phone will helpfully
 * capitalise the first word and cause a failure nobody can see.
 */

/** Words per passphrase. Four is where memorability and entropy meet. */
const WORD_COUNT = 4

/** The trailing number, 10–99: two digits, never leading zero. */
const NUMBER_FLOOR = 10
const NUMBER_CEILING = 100

/**
 * A uniform integer in [0, bound), with the modulo bias removed.
 *
 * Reducing a 32-bit draw with `%` is only uniform when `bound` divides 2^32.
 * It does for the word list, which is 512 entries for exactly this reason; it
 * does not for the number. Rather than let the correctness of this depend on
 * which caller is asking, values in the final incomplete block are discarded
 * and redrawn.
 */
function randomBelow(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound
  const draw = new Uint32Array(1)

  for (;;) {
    crypto.getRandomValues(draw)
    if (draw[0] < limit) return draw[0] % bound
  }
}

/**
 * A single-use credential for an account that has none it can use.
 *
 * Drawn with `crypto.getRandomValues`, independently per account, so no two
 * accounts share one and knowing one says nothing about the next. It carries
 * nothing about its owner: not their name, their email, their birth date,
 * their contact number, their role or their identifiers. It is returned to
 * the administrator or clinician exactly once, and is never stored by
 * RecoverEase in readable form — Supabase Auth keeps only a hash, and nothing
 * here writes it to a table, an audit entry or a log line.
 */
export function generateTemporaryPassword(): string {
  // Drawn without replacement. "cedar-sienna-scarlet-sienna" is no weaker in
  // any way that matters — the cost is 0.02 of a bit — but a repeated word is
  // the one thing in this format that is genuinely hard to dictate, because
  // the listener cannot tell a repeat from a stutter.
  const words: string[] = []
  while (words.length < WORD_COUNT) {
    const word = PASSPHRASE_WORDS[randomBelow(PASSPHRASE_WORDS.length)]
    if (!words.includes(word)) words.push(word)
  }

  const number = NUMBER_FLOOR + randomBelow(NUMBER_CEILING - NUMBER_FLOOR)

  return [...words, String(number)].join('-')
}
