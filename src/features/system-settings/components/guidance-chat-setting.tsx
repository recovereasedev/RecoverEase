import { useId, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'

export const GUIDANCE_CHAT_KEY = 'chatbot.enabled'

/**
 * Whether a stored `chatbot.enabled` value means on, as the database reads it
 * (migration 38): never set is on, `true` in any case and spacing is on, and
 * anything else is off.
 */
export function guidanceChatIsOn(stored: string | null): boolean {
  return stored === null || stored.trim().toLowerCase() === 'true'
}

/**
 * The adviser's "AI Chatbot On/Off", for one clinic: its Clinic Admin turns
 * the guidance assistant on or off for the clinic's patients.
 *
 * Saved as the clinic's `chatbot.enabled` setting, always as `true` or
 * `false`, through the same path as every other setting, so it is the
 * clinic's own and audited like the rest. The server enforces it:
 * `chatbot-reply` refuses a switched-off assistant before anything reaches
 * the provider. A Super Admin can also turn it off for every clinic; this
 * card is the clinic's half only.
 */
export function GuidanceChatSetting({
  storedValue,
  updatedAt,
  isSaving,
  error,
  wasJustSaved,
  onSave,
}: {
  /** The stored value, or null when it has never been set. */
  storedValue: string | null
  updatedAt: string | null
  isSaving: boolean
  error: unknown
  wasJustSaved: boolean
  onSave: (value: 'true' | 'false') => void
}) {
  const savedOn = guidanceChatIsOn(storedValue)
  const [on, setOn] = useState(savedOn)
  const isDirty = on !== savedOn
  const name = useId()

  return (
    <Card>
      <CardHeader
        title="Guidance chat"
        description="Whether your clinic’s patients can ask the guidance assistant for general recovery guidance. When it is off, patients keep their past conversations and their care team still sees them, but nothing new is sent to the assistant."
      />
      <CardBody>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSave(on ? 'true' : 'false')
          }}
          className="space-y-4"
        >
          <fieldset>
            <legend className="sr-only">Guidance chat for your clinic</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { value: true, label: 'On', hint: 'Patients can use the guidance assistant.' },
                { value: false, label: 'Off', hint: 'The guidance assistant answers no one in your clinic.' },
              ].map((option) => (
                <label
                  key={option.label}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-surface p-3 has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50"
                >
                  <input
                    type="radio"
                    name={name}
                    checked={on === option.value}
                    onChange={() => setOn(option.value)}
                    className="mt-0.5 size-5 shrink-0 accent-brand-700"
                  />
                  <span>
                    <span className="block font-medium text-heading">{option.label}</span>
                    <span className="block text-sm text-muted">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error ? <FormError error={error} title="The setting was not saved" /> : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Button
              type="submit"
              className="max-sm:w-full"
              disabled={!isDirty}
              isLoading={isSaving}
              loadingLabel="Saving…"
            >
              Save
            </Button>
            <SavedNotice>{wasJustSaved && !isDirty ? 'Saved.' : null}</SavedNotice>
          </div>
        </form>
      </CardBody>

      <CardFooter className="text-sm text-muted">
        {updatedAt
          ? `${savedOn ? 'On' : 'Off'} · Last updated ${formatDateTime(updatedAt)}`
          : 'On · Never changed'}
      </CardFooter>
    </Card>
  )
}
