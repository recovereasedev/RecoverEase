import { describe, expect, it } from 'vitest'

import { describeSchedulingError } from '@/features/appointments/components/schedule-appointment-dialog'

/**
 * These exist because the release that added the duplicate-appointment guard
 * shipped a translation that production never reached.
 *
 * The database refused the second booking correctly — a live 409 — but the
 * clinician was shown "The appointment could not be scheduled. Check the
 * details and try again." instead of the sentence written for exactly that
 * case. The classifier read `error instanceof Error ? error.message : ''`,
 * and the value `createAppointment` throws is not an Error.
 *
 * `postgrest-js` only constructs a `PostgrestError` when `.throwOnError()` is
 * used. Reading `{ data, error }` and throwing `error` yields the parsed
 * response body: a plain object, `Object.getPrototypeOf(e) === Object
 * .prototype`, carrying `code`, `details`, `hint` and `message`. Every case
 * below that stands in for production uses that shape, verified against the
 * real library, so the bug cannot come back by testing a shape the app never
 * produces.
 */

/** The body PostgREST returns for a violation of the live-slot index. */
function postgrestDuplicate(): unknown {
  return {
    code: '23505',
    details:
      'Key (pat_id, doc_id, appointment_date)=(6dedfc30, 37780d1c, 2026-10-15 02:30:00+00) already exists.',
    hint: null,
    message:
      'duplicate key value violates unique constraint "appointment_one_active_per_slot"',
  }
}

const DUPLICATE_COPY =
  'That appointment already exists. Refresh to see it in the schedule.'
const GENERIC_COPY =
  'The appointment could not be scheduled. Check the details and try again.'

describe('describeSchedulingError', () => {
  it('translates the plain-object conflict PostgREST actually returns', () => {
    // The regression itself. This failed before the fix.
    expect(describeSchedulingError(postgrestDuplicate())).toBe(DUPLICATE_COPY)
  })

  it('translates the same conflict when it arrives as an Error', () => {
    // `.throwOnError()`, a wrapped rethrow, or a future refactor can all
    // produce the Error shape. Both must reach the same sentence.
    const error = new Error(
      'duplicate key value violates unique constraint "appointment_one_active_per_slot"',
    )
    expect(describeSchedulingError(error)).toBe(DUPLICATE_COPY)
  })

  it('recognises the conflict from the SQLSTATE code alone', () => {
    // Postgres may not name the index in `message` on every path; 23505 on an
    // appointment insert is a unique violation on this table either way.
    expect(
      describeSchedulingError({
        code: '23505',
        message: 'duplicate key value violates unique constraint on appointment',
      }),
    ).toBe(DUPLICATE_COPY)
  })

  it('translates the assigned-doctor refusal from the trigger', () => {
    // Raised by `appointment_enforce_assigned_doctor`, and it arrives in the
    // same plain-object shape as the conflict.
    expect(
      describeSchedulingError({
        code: 'P0001',
        message:
          'An appointment must be booked with the patient’s assigned doctor',
      }),
    ).toBe(
      'An appointment can only be booked with the patient’s assigned doctor.',
    )
  })

  it('shows an unrelated PostgREST failure as a safe generic message', () => {
    // Not this conflict, and not copy written for a person: say nothing
    // technical rather than guess.
    expect(
      describeSchedulingError({
        code: '23502',
        details: 'Failing row contains (null, ...)',
        hint: null,
        message: 'null value in column "pat_id" of relation "appointment"',
      }),
    ).toBe(GENERIC_COPY)
  })

  it('never leaks SQL, constraint names or Postgres internals', () => {
    const leaky = [
      postgrestDuplicate(),
      {
        code: '42501',
        message:
          'new row violates row-level security policy for table "appointment"',
      },
      { code: '42601', message: 'syntax error at or near "SELECT"' },
      {
        code: '23503',
        message:
          'insert or update on table "appointment" violates foreign key constraint "appointment_pat_id_fkey"',
      },
    ]

    for (const error of leaky) {
      const shown = describeSchedulingError(error)
      expect(shown).not.toMatch(/duplicate key|violates|constraint|relation "/i)
      expect(shown).not.toMatch(/appointment_one_active_per_slot/)
      expect(shown).not.toMatch(/23505|42501|42601|23503/)
      // The conflicting key values are patient-identifying and must not
      // appear even in the message that is shown for the conflict.
      expect(shown).not.toMatch(/6dedfc30|37780d1c/)
      expect(shown).not.toMatch(/Key \(/)
    }
  })

  it('passes through a server sentence written for a person', () => {
    // An Edge Function or a validation rule already wrote the useful line.
    expect(
      describeSchedulingError({
        message: 'That clinician is no longer accepting appointments',
      }),
    ).toBe('That clinician is no longer accepting appointments')
  })

  it('falls back safely for shapes carrying no message at all', () => {
    expect(describeSchedulingError(null)).toBe(GENERIC_COPY)
    expect(describeSchedulingError(undefined)).toBe(GENERIC_COPY)
    expect(describeSchedulingError({})).toBe(GENERIC_COPY)
    expect(describeSchedulingError({ code: '23505' })).toBe(GENERIC_COPY)
    expect(describeSchedulingError(42)).toBe(GENERIC_COPY)
  })
})
