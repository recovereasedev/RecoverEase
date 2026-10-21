/**
 * The adviser's "AI Chatbot On/Off", as `chatbot-reply` reads it.
 *
 * The rule itself - the platform's switch and the patient's clinic's both on,
 * unset counting as on and anything but 'true' as off - lives in the database
 * (migration 38, `app_private.guidance_assistant_on`), so the website and this
 * function cannot disagree about it. `chatbot-reply` asks
 * `guidance_assistant_on_for_doctor()` for the patient's assigned doctor, once
 * the conversation is proved the caller's and before it reads any of it or
 * calls the provider.
 *
 * What this decides is what to make of the answer. Only an explicit `true`
 * lets the reply go ahead. An explicit `false` is the switch turned off. A
 * failed or unexpected answer is neither: the assistant is not known to be
 * allowed, so it does not answer - a switch that exists to stop the assistant
 * fails closed - and the browser is told it is unavailable rather than off.
 *
 * Free of `Deno` and of any client, like `assistant.ts`, so it is tested in
 * Node.
 */

export const ASSISTANT_SWITCH_FUNCTION = 'guidance_assistant_on_for_doctor'

export type AssistantSwitch = 'on' | 'off' | 'unknown'

export function readAssistantSwitch(result: { data: unknown; error: unknown }): AssistantSwitch {
  if (result.error) return 'unknown'
  if (result.data === true) return 'on'
  if (result.data === false) return 'off'
  return 'unknown'
}
