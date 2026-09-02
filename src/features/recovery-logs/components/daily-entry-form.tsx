import { NotebookPen } from 'lucide-react'
import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
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
  error,
  onSave,
}: {
  initialMood: number | null
  initialNotes: string
  isEditing: boolean
  isSaving: boolean
  error: unknown
  onSave: (values: { moodRating: number | null; notes: string | null }) => void
}) {
  const [mood, setMood] = useState<number | null>(initialMood)
  const [notes, setNotes] = useState(initialNotes)
  const [justSaved, setJustSaved] = useState(false)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setJustSaved(false)
        onSave({
          moodRating: mood,
          notes: notes.trim() === '' ? null : notes.trim(),
        })
        setJustSaved(true)
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

      {error ? <ErrorState error={error} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          isLoading={isSaving}
          loadingLabel="Saving your entry…"
        >
          <NotebookPen aria-hidden="true" />
          {isEditing ? 'Update entry' : 'Save entry'}
        </Button>

        {justSaved && !isSaving && !error ? (
          <p role="status" className="text-sm font-medium text-success-700">
            Saved.
          </p>
        ) : null}
      </div>
    </form>
  )
}
