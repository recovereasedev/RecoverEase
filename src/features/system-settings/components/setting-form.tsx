import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/field'
import type { SystemSetting } from '@/features/system-settings/api'
import { formatDateTime } from '@/lib/format'

export type SettingDefinition = {
  key: string
  label: string
  description: string
  placeholder: string
  multiline: boolean
}

/**
 * One configurable setting (modules 14.1 and 8.7).
 *
 * Split out so the page can key it on the stored record. That keying is what
 * lets the saved value be the field's initial state rather than something an
 * effect copies in after the query resolves — which would blank the field on
 * first paint and could discard text an administrator had already typed.
 */
export function SettingForm({
  definition,
  record,
  isSaving,
  error,
  wasJustSaved,
  onSave,
}: {
  definition: SettingDefinition
  record: SystemSetting | undefined
  isSaving: boolean
  error: unknown
  wasJustSaved: boolean
  onSave: (value: string) => void
}) {
  const savedValue = record?.system_setting_value ?? ''
  const [value, setValue] = useState(savedValue)

  const isDirty = value !== savedValue

  return (
    <Card>
      {/* The explanation sits under the title rather than under the field
          label, so the card reads title, what it does, then the control -
          instead of repeating the setting's name twice in a row with the
          explanation stranded between them. */}
      <CardHeader title={definition.label} description={definition.description} />
      <CardBody>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSave(value)
          }}
          className="space-y-4"
        >
          <Field label={definition.label}>
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
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>

          {error ? <ErrorState error={error} /> : null}

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
            {wasJustSaved && !isDirty ? (
              <p role="status" className="text-sm font-medium text-success-700">
                Saved.
              </p>
            ) : null}
          </div>
        </form>
      </CardBody>

      <CardFooter className="text-sm text-muted">
        {record
          ? `Last updated ${formatDateTime(record.system_setting_updated_at)}`
          : 'Not yet configured'}
      </CardFooter>
    </Card>
  )
}
