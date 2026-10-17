import { useState } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'

import { Button } from '@/components/ui/button'
import { SavedNotice } from '@/components/feedback/state-view'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/field'
import type { SettingParseResult } from '@/features/system-settings/api'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { focusFirstInvalid } from '@/lib/form-focus'
import { formatDateTime } from '@/lib/format'

export type SettingDefinition = {
  key: string
  label: string
  description: string
  placeholder: string
  multiline: boolean
  /**
   * For a setting the application reads as more than free text: checks a
   * value before it is saved and gives the form to store. Without one, the
   * value is saved exactly as typed.
   */
  parse?: (value: string) => SettingParseResult
}

/**
 * One configurable setting (modules 14.1 and 8.7), or the clinic's time zone.
 *
 * Split out so the page can key it on the stored value's last change. That keying is what
 * lets the saved value be the field's initial state rather than something an
 * effect copies in after the query resolves — which would blank the field on
 * first paint and could discard text an administrator had already typed.
 */
export function SettingForm({
  definition,
  savedValue,
  updatedAt,
  isSaving,
  error,
  wasJustSaved,
  onSave,
}: {
  definition: SettingDefinition
  /** The value as stored, or '' when it never has been. */
  savedValue: string
  /** When it last changed, or null when it never has been set. */
  updatedAt: string | null
  isSaving: boolean
  error: unknown
  wasJustSaved: boolean
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(savedValue)
  const [invalid, setInvalid] = useState<string | undefined>(undefined)

  const isDirty = value !== savedValue
  // Saved, nothing is left to save and Save is unavailable: keyboard focus
  // goes back to the field rather than to the top of the page.
  const focusRecovery = useFocusRecovery()

  return (
    <Card>
      {/* The explanation sits under the title rather than under the field
          label, so the card reads title, what it does, then the control -
          instead of repeating the setting's name twice in a row with the
          explanation stranded between them. */}
      <CardHeader title={definition.label} description={definition.description} />
      <CardBody>
        <form
          ref={focusRecovery}
          onSubmit={(event) => {
            event.preventDefault()
            if (!definition.parse) {
              onSave(value)
              return
            }
            // Refused here rather than saved and then ignored, so the stored
            // value stays as it was. Focus goes to the field, where the reason
            // is said, as on every other form.
            const parsed = definition.parse(value)
            if (!parsed.ok) {
              const form = event.currentTarget
              flushSync(() => setInvalid(parsed.message))
              focusFirstInvalid(form)
              return
            }
            setInvalid(undefined)
            onSave(parsed.value)
          }}
          className="space-y-4"
        >
          <Field label={definition.label} error={invalid}>
            {definition.multiline ? (
              <Textarea
                rows={6}
                value={value}
                placeholder={definition.placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <Input
                value={value}
                placeholder={definition.placeholder}
                onChange={(event) => {
                  setValue(event.target.value)
                  setInvalid(undefined)
                }}
              />
            )}
          </Field>

          {error ? (
            <FormError error={error} title="The setting was not saved" />
          ) : null}

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
            <SavedNotice>
              {wasJustSaved && !isDirty ? 'Saved.' : null}
            </SavedNotice>
          </div>
        </form>
      </CardBody>

      <CardFooter className="text-sm text-muted">
        {updatedAt ? `Last updated ${formatDateTime(updatedAt)}` : 'Not yet configured'}
      </CardFooter>
    </Card>
  )
}
