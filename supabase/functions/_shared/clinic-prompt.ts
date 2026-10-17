/**
 * Which guidance the chatbot is given for a conversation (decision D3,
 * migration 31).
 *
 * Each clinic writes its own `chatbot.system_prompt`. The clinic is the
 * patient's doctor's, found from the conversation the caller has already been
 * proved to own - never from anything in the request. If that clinic's prompt
 * cannot be read, for any reason, the conversation gets the built-in guidance
 * (`DEFAULT_GUIDANCE`, followed as always by the safety rules) and never
 * another clinic's.
 *
 * No Deno or Supabase imports, so the rules can be unit tested.
 */

export const PROMPT_KEY = 'chatbot.system_prompt'

export type PromptStore = {
  /** The clinic of a doctor, or null when there is none. */
  clinicOfDoctor(docId: string): Promise<string | null>
  /** A clinic's prompt, or null when it has not written one. */
  clinicPrompt(clinicId: string): Promise<string | null>
}

/**
 * The administrator prompt for the patient's clinic, or null for the built-in
 * guidance. Failures are logged without any prompt text or identifier.
 */
export async function loadClinicPrompt(
  store: PromptStore,
  patientDoctorId: string,
): Promise<string | null> {
  try {
    const clinicId = await store.clinicOfDoctor(patientDoctorId)
    if (!clinicId) {
      console.error('chatbot prompt: the patient’s clinic is unknown; using the built-in guidance')
      return null
    }
    return await store.clinicPrompt(clinicId)
  } catch (error) {
    console.error(
      'chatbot prompt could not be read; using the built-in guidance:',
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}
