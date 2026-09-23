import { NotebookPen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'

import { Button } from '@/components/ui/button'
import { Field, Textarea } from '@/components/ui/field'
import { MoodScale } from '@/features/recovery-logs/components/mood-scale'

/**
 * Today's recovery entry (module 5.9).
 *
 * Split out from the page so that the caller can key it on the entry being
 * edited. That keying is what lets the initial values come straight from
 * `useState` rather than being copied in by an effect once the query
 * resolves — which would briefly render an empty form over an entry the
 * patient had already written, and risk overwriting it if they typed fast.
 */
export function DailyEntryForm({
  initialMood,
  initialNotes,
  isEditing,
  isSaving,
  wasJustSaved,
  savedAt,
  error,
  onSave,
}: {
  initialMood: number | null
  initialNotes: string
  isEditing: boolean
  isSaving: boolean
  /**
   * Owned by the parent, not this component.
   *
   * A successful save gives today's entry an id, which changes this
   * component's key and remounts it — wiping any local "saved" flag before it
   * could ever be seen. The confirmation has to live with the mutation.
   */
  wasJustSaved: boolean
  /** When that save was sent - the mutation's `submittedAt`. */
  savedAt: number
  error: unknown
  onSave: (values: { moodRating: number | null; notes: string | null }) => void
}) {
  const [mood, setMood] = useState<number | null>(initialMood)
  const [notes, setNotes] = useState(initialNotes)
  const formRef = useRef<HTMLFormElement>(null)

  // Focus goes back to the button that was pressed once a save succeeds.
  // Saving takes it away twice over: the button is disabled while the save
  // is in flight, which drops focus to the page, and the first save of the
  // day remounts this form under a new key, which removes the button
  // outright. Either way a keyboard user was left at the top of the page.
  // Only lost focus is restored - if they have already moved on, it stays
  // where they put it. Runs on mount too, which is the remount case.
  useEffect(() => {
    if (!wasJustSaved) return
    const active = document.activeElement
    if (active && active !== document.body) return
    formRef.current
      ?.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.focus()
  }, [wasJustSaved])

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        onSave({
          moodRating: mood,
          notes: notes.trim() === '' ? null : notes.trim(),
        })
      }}
      className="space-y-6"
    >
      <MoodScale value={mood} onChange={setMood} />

      <Field
        label="How was today?"
        description="Anything you would want your doctor to know — pain, sleep, mobility, mood."
      >
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Walked to the end of the road today without stopping…"
        />
      </Field>

      {error ? (
        <FormError error={error} title="Your entry was not saved" />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          type="submit"
          className="max-sm:w-full"
          isLoading={isSaving}
          loadingLabel="Saving your entry…"
        >
          <NotebookPen aria-hidden="true" />
          {isEditing ? 'Update entry' : 'Save entry'}
        </Button>

        <SavedNotice at={savedAt}>
          {wasJustSaved && !isSaving && !error ? 'Saved.' : null}
        </SavedNotice>
      </div>
    </form>
  )
}
